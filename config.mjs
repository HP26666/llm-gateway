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
  return { providerId: null, baseUrlId: null, keyId: null, modelId: null };
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
    },
    providers: {},
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

function normalizeFamilyRoute(route, providerMap) {
  if (!route || typeof route !== "object") {
    return emptyBinding();
  }

  const providerId = normalizeNullableString(route.providerId);
  const keyId = normalizeNullableString(route.keyId);
  const modelId = normalizeNullableString(route.modelId);

  let baseUrlId = normalizeNullableString(route.baseUrlId);
  if (!baseUrlId && providerId && providerMap[providerId]) {
    const provider = providerMap[providerId];
    if (provider.baseUrls && provider.baseUrls.length > 0) {
      baseUrlId = provider.baseUrls[0].id;
    }
  }

  return { providerId, baseUrlId, keyId, modelId };
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
    },
    providers,
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
  saveQueue = saveQueue.then(async () => {
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
