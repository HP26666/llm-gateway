export const FAMILY_ORDER = ["opus", "sonnet", "sonnet[1m]", "haiku"];

import { EventEmitter } from "node:events";

const LOG_BUFFER_LIMIT = 200;
const logBuffer = [];

// CLI 模式下打开：gateway 处理请求时的 logRequest 等只 buffer，不再 console.log
// 抢屏主界面。CLI 按下 8 实时日志视图仍能从 getRecentLogs 看到全部日志。
let suppressConsole = false;

// 上游异常事件总线 + 最近一次错误快照。
// gateway 后台处理请求时遇到 fetch error / 429 / stream-error 调用 recordUpstreamError，
// CLI 主循环监听 errorBus，下次重绘 statusLine 时显示。同进程共享内存，无新依赖。
export const errorBus = new EventEmitter();
// 避免 listener 不够时 Node 11 警告——CLI 是唯一消费者，但留余量
errorBus.setMaxListeners(20);
let lastUpstreamError = null;

// 上游异常原因分类（参考 V5.1 §5.4）。
// upstream-fetch  : DNS/connect/timeout/transport failure
// rate-limited    : 429（含进度更新与终态）
// api-error       : 终态 4xx（401/403/404 等）
// upstream-5xx    : 终态 5xx
// stream-error    : 上游流中断
export function recordUpstreamError({ family, kind, summary, providerId, status } = {}) {
  lastUpstreamError = {
    ts: Date.now(),
    family: family ?? null,
    kind: kind ?? "unknown",
    summary: summary ?? "",
    providerId: providerId ?? null,
    status: status ?? null,
  };
  errorBus.emit("upstream-error", lastUpstreamError);
}

// route-aware 助手：避免在 server.mjs 多个 catch 里反复拼字段。
// route 可以是 null（fetchWithRetry 拿不到完整 route 时）。
export function recordRouteUpstreamError(route, { kind, summary, status } = {}) {
  recordUpstreamError({
    family: route?.modelFamily ?? null,
    providerId: route?.providerId ?? null,
    kind,
    summary,
    status,
  });
}

export function getLastUpstreamError(maxAgeMs = 60000) {
  if (!lastUpstreamError) return null;
  if (Date.now() - lastUpstreamError.ts > maxAgeMs) return null;
  return lastUpstreamError;
}

export function setSuppressConsole(v) {
  suppressConsole = !!v;
}

export function isConsoleSuppressed() {
  return suppressConsole;
}

function appendLog(line) {
  logBuffer.push(line);
  while (logBuffer.length > LOG_BUFFER_LIMIT) {
    logBuffer.shift();
  }
}

// 统一日志出口：始终入 buffer；非 CLI 模式才打印到 stdout。
function emitLog(line) {
  if (!suppressConsole) {
    console.log(line);
  }
  appendLog(line);
}

export function getRecentLogs(limit = 50) {
  return logBuffer.slice(-Math.max(1, limit));
}

export function findProviderModel(provider, modelId) {
  return provider?.models?.find((model) => model.id === modelId) ?? null;
}

export function findProviderKey(provider, keyId) {
  return provider?.keys?.find((key) => key.id === keyId) ?? null;
}

export function findProviderBaseUrl(provider, baseUrlId) {
  return provider?.baseUrls?.find((baseUrl) => baseUrl.id === baseUrlId) ?? null;
}

function maskUrl(url) {
  if (!url) {
    return "?";
  }
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url.length > 24 ? `${url.slice(0, 24)}...` : url;
  }
}

export function describeBinding(config, binding) {
  if (
    !binding
    || !binding.providerId
    || !binding.baseUrlId
    || !binding.modelId
    || !binding.keyId
  ) {
    return "未配置";
  }

  const provider = config.providers[binding.providerId];
  const baseUrl = findProviderBaseUrl(provider, binding.baseUrlId);
  const model = findProviderModel(provider, binding.modelId);
  const key = findProviderKey(provider, binding.keyId);

  if (!provider || !baseUrl || !model || !key) {
    return "配置已失效";
  }

  const segments = [
    provider.name,
    model.name || model.model,
    baseUrl.note || maskUrl(baseUrl.url),
    key.note || key.id,
  ];
  return segments.join(" · ");
}

export function resolveBoundRoute(config, family) {
  const binding = config.modelFamilies[family];
  if (!binding) {
    return { kind: "unknown_family", modelFamily: family };
  }

  if (
    !binding.providerId
    || !binding.baseUrlId
    || !binding.modelId
    || !binding.keyId
  ) {
    return { kind: "unconfigured", modelFamily: family, binding };
  }

  const providerConfig = config.providers[binding.providerId];
  const baseUrl = findProviderBaseUrl(providerConfig, binding.baseUrlId);
  const model = findProviderModel(providerConfig, binding.modelId);
  const key = findProviderKey(providerConfig, binding.keyId);

  if (!providerConfig || !baseUrl || !model || !key || !key.token) {
    return {
      kind: "invalid_binding",
      modelFamily: family,
      binding,
      providerConfig,
      baseUrl,
      model,
      key,
    };
  }

  return {
    kind: "ok",
    modelFamily: family,
    binding,
    providerConfig,
    providerId: providerConfig.id,
    baseUrl,
    baseUrlId: baseUrl.id,
    model,
    key,
    upstreamModel: model.model,
    upstreamUrl: baseUrl.url,
  };
}

export function summarizeFamilyRoute(config, family) {
  const resolved = resolveBoundRoute(config, family);
  if (resolved.kind !== "ok") {
    return {
      status: resolved.kind,
      label: describeBinding(config, config.modelFamilies[family]),
    };
  }

  return {
    status: "ok",
    providerId: resolved.providerId,
    providerName: resolved.providerConfig.name,
    baseUrlId: resolved.baseUrl.id,
    baseUrlNote: resolved.baseUrl.note || maskUrl(resolved.baseUrl.url),
    baseUrlHost: maskUrl(resolved.baseUrl.url),
    modelId: resolved.model.id,
    modelName: resolved.model.name,
    modelModel: resolved.model.model,
    keyId: resolved.key.id,
    keyNote: resolved.key.note || resolved.key.id,
    label: `${resolved.providerConfig.name} · ${resolved.model.name}`,
  };
}

export function formatFamiliesLine(config) {
  return FAMILY_ORDER.map((family) => {
    const resolved = resolveBoundRoute(config, family);
    if (resolved.kind !== "ok") {
      return `${family}>(未配置)`;
    }
    return `${family}->${resolved.providerId}:${resolved.upstreamModel}`;
  }).join(", ");
}

export function logStartupBanner(config) {
  const baseUrl = `http://${config.gateway.host}:${config.gateway.port}`;
  const line = `Claude gateway listening on ${baseUrl} | families: ${formatFamiliesLine(config)}`;
  emitLog(line);
}

export function logRequest(route, pathname, upstreamStatus) {
  const now = new Date().toISOString();
  const family = route.modelFamily ?? "?";
  const providerId = route.providerId ?? "?";
  const upstreamModel = route.upstreamModel ?? "?";
  const requested = route.requestedModel ?? "?";
  const line = `[${now}] ${pathname} ${requested} [${family}] -> ${providerId}:${upstreamModel} (${upstreamStatus})`;
  emitLog(line);
}

export function logFamilySwitch({ family, fromLabel, toLabel, source }) {
  const now = new Date().toISOString();
  const line = `[config-change] ${now} family=${family} from=${fromLabel} to=${toLabel} source=${source}`;
  emitLog(line);
}

export function logProviderChange({ action, providerId, providerName, source }) {
  const now = new Date().toISOString();
  const line = `[config-change] ${now} provider ${action} id=${providerId} name=${providerName} source=${source}`;
  emitLog(line);
}

export function logModelChange({ action, providerId, modelId, modelName, source }) {
  const now = new Date().toISOString();
  const line = `[config-change] ${now} model ${action} provider=${providerId} id=${modelId} name=${modelName} source=${source}`;
  emitLog(line);
}

export function logKeyChange({ action, providerId, keyId, keyNote, source }) {
  const now = new Date().toISOString();
  const line = `[config-change] ${now} key ${action} provider=${providerId} id=${keyId} note=${keyNote} source=${source}`;
  emitLog(line);
}

export function logBaseUrlChange({ action, providerId, baseUrlId, baseUrlNote, source }) {
  const now = new Date().toISOString();
  const line = `[config-change] ${now} baseUrl ${action} provider=${providerId} id=${baseUrlId} note=${baseUrlNote} source=${source}`;
  emitLog(line);
}

export function logPortChange({ from, to, source }) {
  const now = new Date().toISOString();
  const line = `[config-change] ${now} port from=${from} to=${to} source=${source}`;
  emitLog(line);
}

export function logRaw(line) {
  emitLog(line);
}
