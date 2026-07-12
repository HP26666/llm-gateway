import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logRaw } from "./route-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const CONFIG_PATH = path.join(DATA_DIR, "gateway.json");
const LEGACY_ENV_PATH = path.join(__dirname, "gateway.env");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8000;
const MAX_HISTORY_ITEMS = 200;
export const CURRENT_CONFIG_VERSION = 3;

function emptyBinding() {
  return { candidates: [], strategy: "failover", circuitBreaker: null };
}

const DEFAULT_MODEL_FAMILIES = {
  opus: emptyBinding(),
  sonnet: emptyBinding(),
  "sonnet[1m]": emptyBinding(),
  haiku: emptyBinding(),
};

let saveQueue = Promise.resolve();
let warnedLegacyEnv = false;

export { CONFIG_PATH };

export function createEmptyConfig() {
  return {
    version: CURRENT_CONFIG_VERSION,
    gateway: {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      sharedToken: null,
      adminToken: null,
    },
    providers: {},
    circuitBreaker: null,
    modelFamilies: structuredClone(DEFAULT_MODEL_FAMILIES),
    history: [],
  };
}

function normalizeString(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeNullableString(value) {
  const normalized = normalizeString(value);
  return normalized || null;
}

function normalizePort(value) {
  const port = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return DEFAULT_PORT;
  }
  return port;
}

export function shortId(prefix = "id") {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function normalizeBaseUrl(baseUrl, fallbackPrefix) {
  if (!baseUrl || typeof baseUrl !== "object") {
    return null;
  }
  const url = normalizeString(baseUrl.url);
  if (!url) {
    return null;
  }
  return {
    id: normalizeString(baseUrl.id) || shortId(fallbackPrefix || "b"),
    url,
    note: normalizeString(baseUrl.note),
  };
}

function normalizeKey(key, index) {
  if (!key || typeof key !== "object") {
    return null;
  }
  const id = normalizeString(key.id, `key_${index + 1}`);
  const createdAt = normalizeString(key.createdAt, new Date().toISOString());

  return {
    id,
    token: normalizeString(key.token),
    note: normalizeString(key.note),
    createdAt,
  };
}

function normalizeModel(model, index) {
  if (!model || typeof model !== "object") {
    return null;
  }

  // V3: { id, model, name }。兼容 V2: { id, name(=型号), note(=备注) }。
  const hasV3Model = typeof model.model === "string" && model.model.trim();
  const modelValue = hasV3Model
    ? normalizeString(model.model)
    : normalizeString(model.name);

  if (!modelValue) {
    return null;
  }

  const nameValue = hasV3Model
    ? normalizeString(model.name) || modelValue
    : normalizeString(model.note) || modelValue;

  return {
    id: normalizeString(model.id, `model_${index + 1}`),
    model: modelValue,
    name: nameValue,
  };
}

function normalizeProvider(providerId, provider) {
  if (!provider || typeof provider !== "object") {
    provider = {};
  }

  // 兼容 V2 单字段 baseUrl → V3 baseUrls[]
  let baseUrls = [];
  if (Array.isArray(provider.baseUrls)) {
    baseUrls = provider.baseUrls
      .map((b) => normalizeBaseUrl(b, `b_${providerId || "x"}`))
      .filter(Boolean);
  }
  if (baseUrls.length === 0) {
    const legacyBaseUrl = normalizeString(provider.baseUrl);
    if (legacyBaseUrl) {
      baseUrls = [
        {
          id: shortId(`b_${providerId || "x"}`),
          url: legacyBaseUrl,
          note: "default",
        },
      ];
    }
  }

  const keys = Array.isArray(provider.keys)
    ? provider.keys.map(normalizeKey).filter(Boolean)
    : [];

  const models = Array.isArray(provider.models)
    ? provider.models.map(normalizeModel).filter(Boolean)
    : [];

  return {
    id: normalizeString(provider.id, providerId),
    name: normalizeString(provider.name, providerId),
    authHeader: normalizeString(provider.authHeader, "Authorization"),
    authScheme: typeof provider.authScheme === "string" ? provider.authScheme.trim() : "Bearer",
    baseUrls,
    keys,
    models,
  };
}

function normalizeProviders(providers) {
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(providers).map(([providerId, provider]) => [
      providerId,
      normalizeProvider(providerId, provider),
    ]),
  );
}

const FAMILY_STRATEGIES = new Set(["failover", "round_robin", "weighted"]);

// 规范化单个候选四元组。保留 baseUrlId 回退（provider 首个 baseUrl）。
function normalizeQuad(quad, providerMap) {
  if (!quad || typeof quad !== "object") return null;

  const providerId = normalizeNullableString(quad.providerId);
  const keyId = normalizeNullableString(quad.keyId);
  const modelId = normalizeNullableString(quad.modelId);
  let baseUrlId = normalizeNullableString(quad.baseUrlId);

  if (!baseUrlId && providerId && providerMap[providerId]) {
    const provider = providerMap[providerId];
    if (provider.baseUrls && provider.baseUrls.length > 0) {
      baseUrlId = provider.baseUrls[0].id;
    }
  }

  return { providerId, baseUrlId, keyId, modelId };
}

// 至少有一个非空字段才算有效候选；全 null 的丢弃（CLI 半成品清理）。
function isMeaningfulQuad(quad) {
  if (!quad) return false;
  return Boolean(quad.providerId || quad.baseUrlId || quad.keyId || quad.modelId);
}

// 规范化 per-family 或全局熔断参数覆盖。空对象/无效返回 null（用全局默认）。
function normalizeCircuitBreaker(cb) {
  if (!cb || typeof cb !== "object") return null;

  const out = {};
  if (Number.isFinite(Number(cb.failureThreshold))) {
    out.failureThreshold = Math.max(1, Number(cb.failureThreshold));
  }
  if (Number.isFinite(Number(cb.coolDownMs))) {
    out.coolDownMs = Math.max(0, Number(cb.coolDownMs));
  }
  if (Number.isFinite(Number(cb.successThreshold))) {
    out.successThreshold = Math.max(1, Number(cb.successThreshold));
  }
  // TTFB 超时：上游 response headers 在此时长内未到达即判失败（GLM 限额 hang）。
  // clamp [1000, 120000]——下限防误杀，上限不超过总超时（无意义）。缺省走 fetchWithRetry 默认 15000。
  if (Number.isFinite(Number(cb.ttfbTimeoutMs))) {
    out.ttfbTimeoutMs = Math.min(120_000, Math.max(1_000, Number(cb.ttfbTimeoutMs)));
  }

  return Object.keys(out).length > 0 ? out : null;
}

// family 绑定：{ candidates:[...四元组], strategy, circuitBreaker }。
// 向后兼容：旧顶层单四元组（无 candidates 数组）自动包成 1 元素列表。
function normalizeFamilyRoute(route, providerMap) {
  if (!route || typeof route !== "object") {
    return emptyBinding();
  }

  if (Array.isArray(route.candidates)) {
    const candidates = route.candidates
      .map((c) => normalizeQuad(c, providerMap))
      .filter(isMeaningfulQuad);
    const strategy = FAMILY_STRATEGIES.has(route.strategy) ? route.strategy : "failover";
    return { candidates, strategy, circuitBreaker: normalizeCircuitBreaker(route.circuitBreaker) };
  }

  // 旧形态：顶层单四元组 → 1 元素 candidates
  const legacyQuad = normalizeQuad(route, providerMap);
  if (isMeaningfulQuad(legacyQuad)) {
    return { candidates: [legacyQuad], strategy: "failover", circuitBreaker: null };
  }
  return emptyBinding();
}

function normalizeHistoryRoute(route) {
  if (!route || typeof route !== "object") {
    return null;
  }

  return {
    providerId: normalizeNullableString(route.providerId),
    baseUrlId: normalizeNullableString(route.baseUrlId),
    keyId: normalizeNullableString(route.keyId),
    modelId: normalizeNullableString(route.modelId),
  };
}

function normalizeHistoryEntry(entry, index) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  return {
    id: normalizeString(entry.id, `history_${index + 1}`),
    ts: normalizeString(entry.ts, new Date().toISOString()),
    family: normalizeString(entry.family),
    providerId: normalizeNullableString(entry.providerId),
    baseUrlId: normalizeNullableString(entry.baseUrlId),
    keyId: normalizeNullableString(entry.keyId),
    modelId: normalizeNullableString(entry.modelId),
    previous: normalizeHistoryRoute(entry.previous),
    current: normalizeHistoryRoute(entry.current),
    from: typeof entry.from === "string" ? entry.from : "",
    to: typeof entry.to === "string" ? entry.to : "",
    source: normalizeString(entry.source, "unknown"),
  };
}

export function normalizeConfig(rawConfig) {
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const providers = normalizeProviders(config.providers);

  return {
    version: CURRENT_CONFIG_VERSION,
    gateway: {
      host: normalizeString(config.gateway?.host, DEFAULT_HOST),
      port: normalizePort(config.gateway?.port),
      sharedToken: normalizeNullableString(config.gateway?.sharedToken),
      adminToken: normalizeNullableString(config.gateway?.adminToken),
    },
    providers,
    circuitBreaker: normalizeCircuitBreaker(config.circuitBreaker),
    modelFamilies: {
      opus: normalizeFamilyRoute(config.modelFamilies?.opus, providers),
      sonnet: normalizeFamilyRoute(config.modelFamilies?.sonnet, providers),
      "sonnet[1m]": normalizeFamilyRoute(config.modelFamilies?.["sonnet[1m]"], providers),
      haiku: normalizeFamilyRoute(config.modelFamilies?.haiku, providers),
    },
    history: Array.isArray(config.history)
      ? config.history
          .map(normalizeHistoryEntry)
          .filter(Boolean)
          .slice(-MAX_HISTORY_ITEMS)
      : [],
  };
}

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function serializeConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function writeConfigFile(config) {
  const normalized = normalizeConfig(config);
  const tempPath = `${CONFIG_PATH}.tmp`;
  await writeFile(tempPath, serializeConfig(normalized), "utf8");
  await rename(tempPath, CONFIG_PATH);
  return normalized;
}

function stripBom(content) {
  if (typeof content !== "string") {
    return content;
  }
  if (content.charCodeAt(0) === 0xfeff) {
    return content.slice(1);
  }
  return content;
}

function warnIfLegacyEnvExists() {
  if (warnedLegacyEnv) {
    return;
  }

  exists(LEGACY_ENV_PATH)
    .then((present) => {
      if (!present) {
        return;
      }
      warnedLegacyEnv = true;
      logRaw(
        "[warn][config] 检测到根目录 gateway.env，已废弃不再读取；请通过 CLI 维护配置。",
      );
    })
    .catch(() => {
      // ignore
    });
}

export async function loadConfig() {
  await ensureDir();
  warnIfLegacyEnvExists();

  if (!(await exists(CONFIG_PATH))) {
    const initialConfig = createEmptyConfig();
    await writeConfigFile(initialConfig);
    return initialConfig;
  }

  const raw = await readFile(CONFIG_PATH, "utf8");
  const stripped = stripBom(raw);
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid gateway.json: ${message}`);
  }

  const normalized = normalizeConfig(parsed);
  await writeConfigFile(normalized);
  return normalized;
}

export function saveConfig(config) {
  // ⚠️ .catch 兜底防"毒链":Promise.then 链一旦 rejected,后续每次
  // saveQueue = saveQueue.then(...) 都会短路到 reject 分支,新写入回调永不执行。
  // 上一次落盘失败(disk full / 权限 / rename 跨设备等)绝不能毒死后续写入。
  // 调用方仍能拿到本次写入的 rejection(await 的是链上最新节点)。
  saveQueue = saveQueue
    .catch(() => {})
    .then(async () => {
      const normalized = await writeConfigFile(config);

      for (const key of Object.keys(config)) {
        if (!(key in normalized)) {
          delete config[key];
        }
      }

      Object.assign(config, normalized);
      return config;
    });

  return saveQueue;
}
