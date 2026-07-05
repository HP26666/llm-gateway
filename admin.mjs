import { randomUUID, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";

import { saveConfig as defaultSaveConfig, shortId } from "./config.mjs";
import {
  describeBinding,
  findProviderBaseUrl,
  findProviderKey,
  findProviderModel,
  getAllQuads,
  getPrimaryQuad,
  logBaseUrlChange,
  logFamilySwitch,
  logKeyChange,
  logModelChange,
  logPortChange,
  logProviderChange,
  logRaw,
} from "./route-utils.mjs";
import { checkPortFree, findPortOccupant, isValidPort, killProcess } from "./port-utils.mjs";
import { aggregateUsage, cleanupOldUsageFiles } from "./usage-store.mjs";

const DEFAULT_MAX_BODY_SIZE = 50 * 1024 * 1024;
const MAX_HISTORY_ITEMS = 200;

// V5.2 §5.4: 端口切换成功路径单次持久化测试需要观察 saveConfig 调用次数。
// 默认走 config.mjs 的真实 saveConfig；测试可通过 __setSaveConfigForTest 注入 spy。
// 注入仅在测试期间使用，生产代码不会改这个绑定。
let saveConfig = defaultSaveConfig;
export function __setSaveConfigForTest(fn) {
  saveConfig = typeof fn === "function" ? fn : defaultSaveConfig;
}

class HttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

function trimTrailingSlash(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function normalizeString(value, fieldName) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized && fieldName) {
    throw new HttpError(400, `${fieldName} is required`);
  }
  return normalized;
}

function normalizeOptionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function maskSecret(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 4) {
    return "***";
  }
  return `***${value.slice(-4)}`;
}

function slugifyName(value) {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (slug) {
    return slug;
  }
  return `p_${randomUUID().slice(0, 6)}`;
}

function findProviderByName(config, name) {
  return Object.values(config.providers || {}).find(
    (provider) => provider.name.toLowerCase() === String(name).toLowerCase(),
  );
}

function generateProviderId(config, name) {
  const base = slugifyName(name);
  if (!config.providers[base]) {
    return base;
  }
  let candidate = `${base}-${randomUUID().slice(0, 4)}`;
  while (config.providers[candidate]) {
    candidate = `${base}-${randomUUID().slice(0, 4)}`;
  }
  return candidate;
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req, maxSize = DEFAULT_MAX_BODY_SIZE) {
  const chunks = [];
  let totalSize = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalSize += buf.length;
    if (totalSize > maxSize) {
      throw new HttpError(413, `Request body exceeds ${maxSize} byte limit`);
    }
    chunks.push(buf);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(400, `Invalid JSON body: ${message}`);
  }
}

function ensureLoopbackRequest(req) {
  const remoteAddress = req.socket.remoteAddress ?? "";
  const isLoopback =
    remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "::ffff:127.0.0.1";

  if (!isLoopback) {
    throw new HttpError(403, "Admin API is only available from 127.0.0.1");
  }
}

// 常量时间字符串比较,避免 token 校验的 timing 侧信道。
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// admin 鉴权(回环之上):config.gateway.adminToken 非空时,要求 X-Admin-Token 头匹配。
// adminToken 为 null 时维持现状(只靠回环 IP)——向后兼容,不破坏现有 CLI/调用。
// 不匹配 throw HttpError(401)。
function ensureAdminAuth(req, config) {
  const expected = config?.gateway?.adminToken;
  if (!expected) {
    return;
  }
  const provided = req.headers["x-admin-token"];
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (typeof value !== "string" || !safeEqual(value, expected)) {
    throw new HttpError(401, "Invalid or missing admin token.");
  }
}

// SSRF 防护:baseUrl 必须是公网 http(s)。
// 拒绝:非 http(s) scheme、localhost、私网/链路本地/回环/保留段 IP。
// 公网域名或公网 IP 放行。不做 DNS 解析(信任域名解析结果)——可预测性优先的取舍;
// 将来接本地模型可加 allowPrivateBaseUrl 开关,在此处短路。
const SSRF_BLOCKLIST = (() => {
  const bl = new BlockList();
  bl.addAddress("127.0.0.1", "ipv4");
  bl.addRange("10.0.0.0", "10.255.255.255", "ipv4");
  bl.addRange("172.16.0.0", "172.31.255.255", "ipv4");
  bl.addRange("192.168.0.0", "192.168.255.255", "ipv4");
  bl.addRange("169.254.0.0", "169.254.255.255", "ipv4");
  bl.addRange("0.0.0.0", "0.255.255.255", "ipv4");
  bl.addRange("100.64.0.0", "100.127.255.255", "ipv4");
  bl.addAddress("::1", "ipv6");
  bl.addRange("fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "ipv6");
  bl.addRange("fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "ipv6");
  return bl;
})();

function assertSafeBaseUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpError(400, `invalid baseUrl: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, `baseUrl scheme must be http or https (got ${parsed.protocol})`);
  }

  // WHATWG URL 的 hostname 对 IPv6 可能带方括号(如 [::1]),剥掉再做 IP 校验。
  const host = parsed.hostname.toLowerCase().replace(/^\[|]$/g, "");
  if (host === "localhost" || host === "localhost." || host.endsWith(".localhost")) {
    throw new HttpError(400, "baseUrl must not point to localhost");
  }

  const family = isIP(host);
  if (family === 0) {
    return; // 公网域名,放行
  }
  if (SSRF_BLOCKLIST.check(host, family === 4 ? "ipv4" : "ipv6")) {
    throw new HttpError(
      400,
      "baseUrl must not point to a private/loopback/link-local/reserved address",
    );
  }
}

function assertFamilyExists(config, family) {
  if (!(family in config.modelFamilies)) {
    throw new HttpError(404, "family not found");
  }
}

function getProvider(config, providerId) {
  const provider = config.providers[providerId];
  if (!provider) {
    throw new HttpError(404, "provider not found");
  }
  return provider;
}

function getProviderKey(provider, keyId) {
  const key = findProviderKey(provider, keyId);
  if (!key) {
    throw new HttpError(404, "key not found");
  }
  return key;
}

function getProviderModel(provider, modelId) {
  const model = findProviderModel(provider, modelId);
  if (!model) {
    throw new HttpError(404, "model not found");
  }
  return model;
}

function getProviderBaseUrl(provider, baseUrlId) {
  const baseUrl = findProviderBaseUrl(provider, baseUrlId);
  if (!baseUrl) {
    throw new HttpError(404, "baseUrl not found");
  }
  return baseUrl;
}

// 克隆主候选四元组（兼容旧单四元组与 candidates 列表形态）。history 快照用。
function cloneBinding(binding) {
  const quad = Array.isArray(binding?.candidates)
    ? binding.candidates.find((q) => q && (q.providerId || q.baseUrlId || q.keyId || q.modelId))
    : binding;
  if (!quad) {
    return null;
  }
  return {
    providerId: quad.providerId ?? null,
    baseUrlId: quad.baseUrlId ?? null,
    modelId: quad.modelId ?? null,
    keyId: quad.keyId ?? null,
  };
}

// 在所有 family 的全部候选中查找满足 predicate 的引用（兼容多候选 schema）。
function findFamilyReferencing(config, predicate) {
  for (const family of Object.keys(config.modelFamilies)) {
    for (const quad of getAllQuads(config, family)) {
      if (predicate(quad)) return family;
    }
  }
  return null;
}

function ensureProviderNotReferenced(config, providerId) {
  const family = findFamilyReferencing(config, (q) => q.providerId === providerId);
  if (family) throw new HttpError(409, `provider is used by family ${family}`);
}

function ensureKeyNotReferenced(config, providerId, keyId) {
  const family = findFamilyReferencing(config, (q) => q.providerId === providerId && q.keyId === keyId);
  if (family) throw new HttpError(409, `key is used by family ${family}`);
}

function ensureModelNotReferenced(config, providerId, modelId) {
  const family = findFamilyReferencing(config, (q) => q.providerId === providerId && q.modelId === modelId);
  if (family) throw new HttpError(409, `model is used by family ${family}`);
}

function ensureBaseUrlNotReferenced(config, providerId, baseUrlId) {
  const family = findFamilyReferencing(config, (q) => q.providerId === providerId && q.baseUrlId === baseUrlId);
  if (family) throw new HttpError(409, `baseUrl is used by family ${family}`);
}

function summarizeMetrics(metrics, family) {
  const cutoff = Date.now() - 60_000;
  const bucket = Array.isArray(metrics[family]) ? metrics[family] : [];
  const recent = bucket.filter((item) => item.ts >= cutoff);
  metrics[family] = recent;
  const count = recent.length;
  const errors = recent.filter((item) => item.isError).length;

  return {
    count,
    errors,
    errorRate: count === 0 ? 0 : Number((errors / count).toFixed(4)),
  };
}

function sanitizeConfig(config) {
  return {
    version: config.version,
    gateway: {
      host: config.gateway.host,
      port: config.gateway.port,
      sharedToken: config.gateway.sharedToken ? maskSecret(config.gateway.sharedToken) : null,
      adminToken: config.gateway.adminToken ? maskSecret(config.gateway.adminToken) : null,
    },
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([providerId, provider]) => [
        providerId,
        {
          id: provider.id,
          name: provider.name,
          authHeader: provider.authHeader,
          authScheme: provider.authScheme,
          baseUrls: provider.baseUrls.map((baseUrl) => ({
            id: baseUrl.id,
            url: baseUrl.url,
            note: baseUrl.note,
          })),
          keys: provider.keys.map((key) => ({
            id: key.id,
            token: maskSecret(key.token),
            note: key.note,
            createdAt: key.createdAt,
          })),
          models: provider.models.map((model) => ({
            id: model.id,
            model: model.model,
            name: model.name,
          })),
        },
      ]),
    ),
    modelFamilies: structuredClone(config.modelFamilies),
    history: structuredClone(config.history),
  };
}

function createKeyId(providerId) {
  return `k_${providerId}_${randomUUID().slice(0, 8)}`;
}

function createModelId(providerId) {
  return `m_${providerId}_${randomUUID().slice(0, 8)}`;
}

function pushHistory(config, family, previous, current, source = "ui") {
  const currentQuad = cloneBinding(current) || {};
  const entry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    family,
    providerId: currentQuad.providerId ?? null,
    baseUrlId: currentQuad.baseUrlId ?? null,
    modelId: currentQuad.modelId ?? null,
    keyId: currentQuad.keyId ?? null,
    previous: cloneBinding(previous),
    current: cloneBinding(current),
    from: describeBinding(config, previous),
    to: describeBinding(config, current),
    source,
  };

  config.history.unshift(entry);
  if (config.history.length > MAX_HISTORY_ITEMS) {
    config.history.length = MAX_HISTORY_ITEMS;
  }
}

function getRequestSource(req) {
  const header = req.headers["x-admin-source"];
  if (Array.isArray(header) ? header[0] : header) {
    return String(Array.isArray(header) ? header[0] : header);
  }
  const userAgent = req.headers["x-admin-client"];
  if (typeof userAgent === "string" && userAgent.includes("cli")) {
    return "cli";
  }
  return "ui";
}

async function persist(config, statusCode, payload, res) {
  await saveConfig(config);
  writeJson(res, statusCode, payload);
}

async function handleGetConfig(config, res) {
  writeJson(res, 200, sanitizeConfig(config));
}

async function handleExportConfig(config, res) {
  writeJson(res, 200, sanitizeConfig(config));
}

async function handleCreateProvider(config, req, res) {
  const body = await readJsonBody(req);
  const name = normalizeString(body.name, "name");

  if (findProviderByName(config, name)) {
    throw new HttpError(409, `provider with name "${name}" already exists`);
  }

  const providerId = generateProviderId(config, name);
  if (config.providers[providerId]) {
    throw new HttpError(409, "provider already exists");
  }

  const baseUrls = [];
  const legacyBaseUrl = trimTrailingSlash(normalizeString(body.baseUrl || body.url || ""));
  if (legacyBaseUrl) {
    assertSafeBaseUrl(legacyBaseUrl);
    baseUrls.push({
      id: shortId(`b_${providerId}`),
      url: legacyBaseUrl,
      note: normalizeOptionalString(body.baseUrlNote) || "default",
    });
  }

  const keys = [];
  const token = normalizeString(body.apiKey || body.token || "", "");
  if (token) {
    keys.push({
      id: createKeyId(providerId),
      token,
      note: normalizeOptionalString(body.keyNote) || "default",
      createdAt: new Date().toISOString(),
    });
  }

  config.providers[providerId] = {
    id: providerId,
    name,
    authHeader: "Authorization",
    authScheme: "Bearer",
    baseUrls,
    keys,
    models: [],
  };

  const source = getRequestSource(req);
  await persist(config, 201, { ok: true, provider: sanitizeConfig(config).providers[providerId] }, res);
  logProviderChange({ action: "created", providerId, providerName: name, source });
  if (keys.length > 0) {
    logKeyChange({ action: "created", providerId, keyId: keys[0].id, keyNote: keys[0].note, source });
  }
  if (baseUrls.length > 0) {
    logBaseUrlChange({
      action: "created",
      providerId,
      baseUrlId: baseUrls[0].id,
      baseUrlNote: baseUrls[0].note,
      source,
    });
  }
}

async function handleUpdateProvider(config, providerId, req, res) {
  const provider = getProvider(config, providerId);
  const body = await readJsonBody(req);
  const source = getRequestSource(req);

  if (body.name !== undefined) {
    const newName = normalizeString(body.name, "name");
    if (newName.toLowerCase() !== provider.name.toLowerCase()) {
      const conflict = findProviderByName(config, newName);
      if (conflict && conflict.id !== provider.id) {
        throw new HttpError(409, `provider with name "${newName}" already exists`);
      }
      provider.name = newName;
    }
  }

  await persist(config, 200, { ok: true, provider: sanitizeConfig(config).providers[providerId] }, res);
  logProviderChange({ action: "updated", providerId, providerName: provider.name, source });
}

async function handleDeleteProvider(config, providerId, req, res) {
  getProvider(config, providerId);
  ensureProviderNotReferenced(config, providerId);
  const providerName = config.providers[providerId].name;
  delete config.providers[providerId];
  const source = getRequestSource(req);
  await persist(config, 200, { ok: true }, res);
  logProviderChange({ action: "deleted", providerId, providerName, source });
}

async function handleAddBaseUrl(config, providerId, req, res) {
  const provider = getProvider(config, providerId);
  const body = await readJsonBody(req);
  const url = trimTrailingSlash(normalizeString(body.url, "url"));
  assertSafeBaseUrl(url);
  const baseUrl = {
    id: shortId(`b_${providerId}`),
    url,
    note: normalizeOptionalString(body.note) || "default",
  };
  provider.baseUrls.push(baseUrl);
  const source = getRequestSource(req);
  await persist(config, 201, { ok: true, baseUrl }, res);
  logBaseUrlChange({ action: "created", providerId, baseUrlId: baseUrl.id, baseUrlNote: baseUrl.note, source });
}

async function handleUpdateBaseUrl(config, providerId, baseUrlId, req, res) {
  const provider = getProvider(config, providerId);
  const baseUrl = getProviderBaseUrl(provider, baseUrlId);
  const body = await readJsonBody(req);
  const source = getRequestSource(req);

  if (body.url !== undefined) {
    const nextUrl = trimTrailingSlash(normalizeString(body.url, "url"));
    assertSafeBaseUrl(nextUrl);
    baseUrl.url = nextUrl;
  }
  if (body.note !== undefined) {
    baseUrl.note = normalizeOptionalString(body.note);
  }

  await persist(config, 200, { ok: true, baseUrl }, res);
  logBaseUrlChange({ action: "updated", providerId, baseUrlId: baseUrl.id, baseUrlNote: baseUrl.note, source });
}

async function handleDeleteBaseUrl(config, providerId, baseUrlId, req, res) {
  const provider = getProvider(config, providerId);
  getProviderBaseUrl(provider, baseUrlId);
  ensureBaseUrlNotReferenced(config, providerId, baseUrlId);

  provider.baseUrls = provider.baseUrls.filter((item) => item.id !== baseUrlId);
  const source = getRequestSource(req);
  await persist(config, 200, { ok: true }, res);
  logBaseUrlChange({ action: "deleted", providerId, baseUrlId, keyNote: "", baseUrlNote: "", source });
}

async function handleAddKey(config, providerId, req, res) {
  const provider = getProvider(config, providerId);
  const body = await readJsonBody(req);
  const key = {
    id: createKeyId(providerId),
    token: normalizeString(body.token, "token"),
    note: normalizeOptionalString(body.note) || "default",
    createdAt: new Date().toISOString(),
  };

  provider.keys.push(key);
  const source = getRequestSource(req);
  await persist(config, 201, { ok: true, key: { ...key, token: maskSecret(key.token) } }, res);
  logKeyChange({ action: "created", providerId, keyId: key.id, keyNote: key.note, source });
}

async function handleUpdateKey(config, providerId, keyId, req, res) {
  const provider = getProvider(config, providerId);
  const key = getProviderKey(provider, keyId);
  const body = await readJsonBody(req);
  const source = getRequestSource(req);

  if (body.token !== undefined) {
    key.token = normalizeString(body.token, "token");
  }
  if (body.note !== undefined) {
    key.note = normalizeOptionalString(body.note);
  }

  await persist(config, 200, { ok: true, key: { ...key, token: maskSecret(key.token) } }, res);
  logKeyChange({ action: "updated", providerId, keyId: key.id, keyNote: key.note, source });
}

async function handleDeleteKey(config, providerId, keyId, req, res) {
  const provider = getProvider(config, providerId);
  getProviderKey(provider, keyId);
  ensureKeyNotReferenced(config, providerId, keyId);

  provider.keys = provider.keys.filter((item) => item.id !== keyId);
  const source = getRequestSource(req);
  await persist(config, 200, { ok: true }, res);
  logKeyChange({ action: "deleted", providerId, keyId, keyNote: "", source });
}

async function handleAddModel(config, providerId, req, res) {
  const provider = getProvider(config, providerId);
  const body = await readJsonBody(req);
  const modelValue = normalizeString(body.model, "model");
  const nameValue = normalizeOptionalString(body.name) || modelValue;
  const model = {
    id: createModelId(providerId),
    model: modelValue,
    name: nameValue,
  };

  provider.models.push(model);
  const source = getRequestSource(req);
  await persist(config, 201, { ok: true, model }, res);
  logModelChange({ action: "created", providerId, modelId: model.id, modelName: model.name, source });
}

async function handleUpdateModel(config, providerId, modelId, req, res) {
  const provider = getProvider(config, providerId);
  const model = getProviderModel(provider, modelId);
  const body = await readJsonBody(req);
  const source = getRequestSource(req);

  if (body.model !== undefined) {
    model.model = normalizeString(body.model, "model");
  }
  if (body.name !== undefined) {
    model.name = normalizeOptionalString(body.name) || model.model;
  }

  await persist(config, 200, { ok: true, model }, res);
  logModelChange({ action: "updated", providerId, modelId: model.id, modelName: model.name, source });
}

async function handleDeleteModel(config, providerId, modelId, req, res) {
  const provider = getProvider(config, providerId);
  const model = getProviderModel(provider, modelId);
  ensureModelNotReferenced(config, providerId, modelId);

  provider.models = provider.models.filter((item) => item.id !== modelId);
  const source = getRequestSource(req);
  await persist(config, 200, { ok: true }, res);
  logModelChange({ action: "deleted", providerId, modelId, modelName: model.name, source });
}

async function handleSwitchFamily(config, family, req, res) {
  assertFamilyExists(config, family);
  const body = await readJsonBody(req);
  const providerId = normalizeString(body.providerId, "providerId");
  const baseUrlId = normalizeString(body.baseUrlId, "baseUrlId");
  const modelId = normalizeString(body.modelId, "modelId");
  const keyId = normalizeString(body.keyId, "keyId");

  const provider = getProvider(config, providerId);
  getProviderBaseUrl(provider, baseUrlId);
  getProviderModel(provider, modelId);
  getProviderKey(provider, keyId);

  const previousBinding = config.modelFamilies[family];
  const previousLabel = describeBinding(config, previousBinding);
  // PUT 单四元组 = 重置 candidates 为单候选；保留原 strategy / circuitBreaker。
  const existing = previousBinding && typeof previousBinding === "object" ? previousBinding : {};
  const strategy = existing.strategy || "failover";
  const circuitBreaker = existing.circuitBreaker ?? null;
  config.modelFamilies[family] = {
    candidates: [{ providerId, baseUrlId, modelId, keyId }],
    strategy,
    circuitBreaker,
  };
  const source = getRequestSource(req);
  pushHistory(config, family, previousBinding, config.modelFamilies[family], source);
  const currentLabel = describeBinding(config, config.modelFamilies[family]);

  await persist(config, 200, { ok: true }, res);
  logFamilySwitch({ family, fromLabel: previousLabel, toLabel: currentLabel, source });
}

// PUT /admin/families/:family/candidates —— 替换整个候选列表 + 策略（保留原 circuitBreaker）。
// body: { candidates: [{providerId,baseUrlId,keyId,modelId}, ...], strategy }
async function handleSetFamilyCandidates(config, family, req, res) {
  assertFamilyExists(config, family);
  const body = await readJsonBody(req);
  const rawCandidates = Array.isArray(body.candidates) ? body.candidates : [];

  const validated = [];
  for (const entry of rawCandidates) {
    if (!entry || typeof entry !== "object") continue;
    const providerId = normalizeString(entry.providerId, "providerId");
    const baseUrlId = normalizeString(entry.baseUrlId, "baseUrlId");
    const keyId = normalizeString(entry.keyId, "keyId");
    const modelId = normalizeString(entry.modelId, "modelId");
    const provider = getProvider(config, providerId);
    getProviderBaseUrl(provider, baseUrlId);
    getProviderKey(provider, keyId);
    getProviderModel(provider, modelId);
    validated.push({ providerId, baseUrlId, keyId, modelId });
  }

  const strategy = ["failover", "round_robin", "weighted"].includes(body.strategy)
    ? body.strategy
    : "failover";

  const previousBinding = config.modelFamilies[family];
  const previousLabel = describeBinding(config, previousBinding);
  const circuitBreaker = previousBinding?.circuitBreaker ?? null;
  config.modelFamilies[family] = { candidates: validated, strategy, circuitBreaker };
  const source = getRequestSource(req);
  const currentLabel = describeBinding(config, config.modelFamilies[family]);

  await persist(config, 200, { ok: true, family, candidateCount: validated.length, strategy }, res);
  logFamilySwitch({ family, fromLabel: previousLabel, toLabel: currentLabel, source });
}

function buildFamilyStatus(config, metrics, family) {
  assertFamilyExists(config, family);
  const binding = config.modelFamilies[family] || {};
  const primary = getPrimaryQuad(binding) || {};
  return {
    family,
    route: {
      providerId: primary.providerId ?? null,
      baseUrlId: primary.baseUrlId ?? null,
      modelId: primary.modelId ?? null,
      keyId: primary.keyId ?? null,
      label: describeBinding(config, binding),
      candidateCount: getAllQuads(config, family).length,
      strategy: binding.strategy || "failover",
    },
    stats: summarizeMetrics(metrics, family),
  };
}

async function handleGetFamilyStatus(config, metrics, family, res) {
  writeJson(res, 200, buildFamilyStatus(config, metrics, family));
}

// GET /admin/usage/:range —— 聚合用量统计。range: today|7d|30d（非法值降级为 today）。
// 顺带惰性清理超过保留期的旧文件（usage-store 内部每 6h 最多跑一次）。
async function handleGetUsage(range, res) {
  try {
    await cleanupOldUsageFiles();
    const data = await aggregateUsage(range || "today");
    writeJson(res, 200, data);
  } catch (err) {
    throw new HttpError(500, `usage aggregation failed: ${err.message}`);
  }
}

async function handleProbePort(config, req, res) {
  const body = await readJsonBody(req);
  const port = Number.parseInt(String(body.port ?? ""), 10);
  if (!isValidPort(port)) {
    throw new HttpError(400, "invalid port");
  }
  const host = config.gateway.host;
  const free = await checkPortFree(port, host);
  const occupant = free ? null : await findPortOccupant(port);
  writeJson(res, 200, {
    host,
    port,
    free,
    occupant,
  });
}

async function handleKillProcess(req, res) {
  const body = await readJsonBody(req);
  const pid = Number.parseInt(String(body.pid ?? ""), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new HttpError(400, "invalid pid");
  }
  const ok = await killProcess(pid);
  if (!ok) {
    throw new HttpError(500, `failed to kill pid ${pid}`);
  }
  writeJson(res, 200, { ok: true, pid });
}

async function handleChangePort(config, runtime, req, res) {
  const body = await readJsonBody(req);
  const port = Number.parseInt(String(body.port ?? ""), 10);
  if (!isValidPort(port)) {
    throw new HttpError(400, "invalid port");
  }
  const host = config.gateway.host;
  const previous = config.gateway.port;
  const source = getRequestSource(req);

  if (previous === port) {
    writeJson(res, 200, { ok: true, port, changed: false });
    return;
  }

  let free = await checkPortFree(port, host);
  let occupant = null;
  if (!free) {
    occupant = await findPortOccupant(port);
    const killIfOccupied = Boolean(body.killIfOccupied);
    if (killIfOccupied && occupant?.pid) {
      const killed = await killProcess(occupant.pid);
      if (!killed) {
        throw new HttpError(409, `failed to kill pid ${occupant.pid}`, { occupant });
      }
      await new Promise((r) => setTimeout(r, 300));
      free = await checkPortFree(port, host);
    }
    if (!free) {
      throw new HttpError(
        409,
        `port ${host}:${port} is in use${occupant?.pid ? ` by pid ${occupant.pid}` : ""}`,
        { occupant },
      );
    }
  }

  // V5.1 §5.3：两阶段事务
  // 1) prepare：新端口起 candidate，旧端口仍服务
  // 2) 改 in-memory config.gateway.port
  // 3) saveConfig 落盘
  // 4) commit：推进 active server + 更新 currentPort
  // 任一阶段失败 → rollback config + rollback tx + 500 + details
  if (!runtime?.preparePortSwitch) {
    throw new HttpError(500, "runtime not available");
  }
  if (runtime.isSwitchInFlight && runtime.isSwitchInFlight()) {
    throw new HttpError(409, "port switch already in progress");
  }

  let tx;
  try {
    tx = await runtime.preparePortSwitch(port, { excludeSocket: req.socket });
  } catch (err) {
    throw new HttpError(500, `failed to prepare port switch: ${err.message}`, { port, host });
  }

  if (tx.noop) {
    await persist(config, 200, { ok: true, port, changed: false, previous }, res);
    return;
  }

  // prepare 成功：candidate 已经在新端口跑。config 也得跟上。
  // 顺序：先改内存 config，再 saveConfig，最后 commit。
  const previousConfigPort = config.gateway.port;
  config.gateway.port = port;

  let saveError = null;
  try {
    await saveConfig(config);
  } catch (err) {
    saveError = err;
  }

  if (saveError) {
    // 落盘失败：把内存 config 回滚到旧端口，tx rollback
    config.gateway.port = previousConfigPort;
    let rollbackError = null;
    try {
      await tx.rollback();
    } catch (err) {
      rollbackError = err;
    }
    throw new HttpError(
      500,
      "port switch rolled back; previous port still active",
      {
        runtimePort: port,
        persistedPort: previousConfigPort,
        saveError: saveError.message,
        rollbackError: rollbackError?.message,
      },
    );
  }

  // saveConfig 成功：commit
  let commitError = null;
  try {
    await tx.commit();
  } catch (err) {
    commitError = err;
  }

  if (commitError) {
    // 补偿：尝试把 config 恢复到旧端口并再次 saveConfig
    config.gateway.port = previousConfigPort;
    let configRollbackError = null;
    try {
      await saveConfig(config);
    } catch (err) {
      configRollbackError = err;
    }
    // 同时也回滚事务（如果 commit 完全没执行）
    let txRollbackError = null;
    try {
      await tx.rollback();
    } catch (err) {
      txRollbackError = err;
    }
    throw new HttpError(
      500,
      "port commit failed; attempted rollback",
      {
        runtimePort: port,
        persistedPort: previousConfigPort,
        commitError: commitError.message,
        configRollbackError: configRollbackError?.message,
        txRollbackError: txRollbackError?.message,
      },
    );
  }

  // V5.2 §5.4：成功路径只持久化一次。
  // prepare 之前没有持久化；prepare -> saveConfig(第一次) -> commit。
  // 这里直接 writeJson，不再调 persist()（persist 内部会再 saveConfig 一次）。
  writeJson(res, 200, { ok: true, port, changed: true, previous });
  logPortChange({ from: previous, to: port, source });
}

function decodeAdminSegments(pathname) {
  return pathname
    .split("/")
    .filter(Boolean)
    .slice(1)
    .map((segment) => decodeURIComponent(segment));
}

export async function handleAdmin({ config, metrics, req, res, pathname, runtime, getHealthPayload }) {
  try {
    ensureLoopbackRequest(req);
    ensureAdminAuth(req, config);

    const segments = decodeAdminSegments(pathname);

    if (req.method === "GET" && segments.length === 1 && segments[0] === "config") {
      await handleGetConfig(config, res);
      return;
    }

    if (req.method === "GET" && segments.length === 2 && segments[0] === "config" && segments[1] === "export") {
      await handleExportConfig(config, res);
      return;
    }

    if (req.method === "GET" && segments.length === 1 && segments[0] === "history") {
      writeJson(res, 200, { history: config.history });
      return;
    }

    if (req.method === "GET" && segments.length === 2 && segments[0] === "usage") {
      await handleGetUsage(segments[1], res);
      return;
    }

    if (req.method === "GET" && segments.length === 1 && segments[0] === "health") {
      writeJson(res, 200, getHealthPayload());
      return;
    }

    if (segments[0] === "runtime") {
      if (segments.length === 2 && segments[1] === "port" && req.method === "PATCH") {
        await handleChangePort(config, runtime, req, res);
        return;
      }
      if (segments.length === 3 && segments[1] === "port" && segments[2] === "probe" && req.method === "POST") {
        await handleProbePort(config, req, res);
        return;
      }
      if (segments.length === 3 && segments[1] === "process" && segments[2] === "kill" && req.method === "POST") {
        await handleKillProcess(req, res);
        return;
      }
    }

    if (segments[0] === "providers") {
      if (req.method === "POST" && segments.length === 1) {
        await handleCreateProvider(config, req, res);
        return;
      }

      if (segments.length >= 2) {
        const providerId = segments[1];

        if (segments.length === 2 && req.method === "PATCH") {
          await handleUpdateProvider(config, providerId, req, res);
          return;
        }

        if (segments.length === 2 && req.method === "DELETE") {
          await handleDeleteProvider(config, providerId, req, res);
          return;
        }

        if (segments.length === 3 && segments[2] === "baseUrls" && req.method === "POST") {
          await handleAddBaseUrl(config, providerId, req, res);
          return;
        }

        if (segments.length === 4 && segments[2] === "baseUrls" && req.method === "PATCH") {
          await handleUpdateBaseUrl(config, providerId, segments[3], req, res);
          return;
        }

        if (segments.length === 4 && segments[2] === "baseUrls" && req.method === "DELETE") {
          await handleDeleteBaseUrl(config, providerId, segments[3], req, res);
          return;
        }

        if (segments.length === 3 && segments[2] === "keys" && req.method === "POST") {
          await handleAddKey(config, providerId, req, res);
          return;
        }

        if (segments.length === 4 && segments[2] === "keys" && req.method === "PATCH") {
          await handleUpdateKey(config, providerId, segments[3], req, res);
          return;
        }

        if (segments.length === 4 && segments[2] === "keys" && req.method === "DELETE") {
          await handleDeleteKey(config, providerId, segments[3], req, res);
          return;
        }

        if (segments.length === 3 && segments[2] === "models" && req.method === "POST") {
          await handleAddModel(config, providerId, req, res);
          return;
        }

        if (segments.length === 4 && segments[2] === "models" && req.method === "PATCH") {
          await handleUpdateModel(config, providerId, segments[3], req, res);
          return;
        }

        if (segments.length === 4 && segments[2] === "models" && req.method === "DELETE") {
          await handleDeleteModel(config, providerId, segments[3], req, res);
          return;
        }
      }
    }

    if (segments[0] === "families" && segments.length >= 2) {
      const family = segments[1];

      if (segments.length === 2 && req.method === "PUT") {
        await handleSwitchFamily(config, family, req, res);
        return;
      }

      if (segments.length === 3 && segments[2] === "candidates" && req.method === "PUT") {
        await handleSetFamilyCandidates(config, family, req, res);
        return;
      }

      if (segments.length === 3 && segments[2] === "status" && req.method === "GET") {
        await handleGetFamilyStatus(config, metrics, family, res);
        return;
      }
    }

    throw new HttpError(404, `Unsupported admin route: ${req.method} ${pathname}`);
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : String(error);
    const details = error instanceof HttpError ? error.details : undefined;

    if (statusCode >= 500) {
      logRaw(`[error][admin-error] ${message}`);
    }

    writeJson(res, statusCode, {
      error: {
        type: statusCode >= 500 ? "api_error" : "invalid_request_error",
        message,
        details,
      },
    });
  }
}
