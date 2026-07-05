import { Readable } from "node:stream";
import { Transform } from "node:stream";

import { handleAdmin } from "./admin.mjs";
import {
  logRaw,
  logRequest,
  logFailoverSwitch,
  recordRouteUpstreamError,
  recordUpstreamError,
  resolveBoundRoute,
  resolveCandidates,
} from "./route-utils.mjs";
import {
  breakerKey,
  orderCandidates,
  recordBreakerFailure,
  recordBreakerSuccess,
} from "./circuit-breaker.mjs";
import { recordUsage } from "./usage-store.mjs";
import { randomUUID } from "node:crypto";
import {
  responsesBodyToAnthropic,
  resolveModelFromResponses,
  isResponsesStream,
} from "./responses-request-adapter.mjs";
import {
  anthropicResponseToResponses,
  createAnthropicToResponsesStream,
} from "./responses-response-adapter.mjs";
import { buildResponsesEnvelope } from "./responses-protocol.mjs";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const RETRYABLE_TRANSPORT_STATUS = new Set([502, 503, 504]);
// failover 触发集：命中即换下一个候选（fetchWithRetry 已对同上游重试过，这里换「不同上游」）。
// >=500 全部触发；429 限流；401/402/403 鉴权或余额失效。400/404 等请求格式类不触发（换哪都错）。
const FAILOVER_TRIGGER_STATUS = new Set([401, 402, 403, 429]);
const DEFAULT_MAX_BODY_SIZE = 50 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
// 普通重试预算（fetch error / 502/503/504）独立计数：V5.1 §5.1
const DEFAULT_GENERIC_MAX_RETRIES = 3;
// 429 重试预算独立计数：V5.1 §5.1
const RATE_LIMIT_MAX_RETRIES = 10;
const RATE_LIMIT_RETRY_DELAY_MS = 5_000;
const DEFAULT_RETRY_BASE_MS = 1000;

export class GatewayHttpError extends Error {
  constructor(statusCode, type, message) {
    super(message);
    this.name = "GatewayHttpError";
    this.statusCode = statusCode;
    this.type = type;
  }
}

function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function joinUrl(baseUrl, requestPath) {
  return `${trimTrailingSlash(baseUrl)}${requestPath}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryAfterMs(response) {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) {
    return null;
  }

  const asSeconds = Number(retryAfter);
  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    return Math.min(asSeconds * 1000, 60_000);
  }

  const asDate = new Date(retryAfter);
  if (Number.isFinite(asDate.getTime())) {
    return Math.min(Math.max(0, asDate.getTime() - Date.now()), 60_000);
  }

  return null;
}

// V5.1 §5.1：双计数器状态机，429 与普通重试预算彻底解耦。
// - genericRetryCount : fetch error / 502 / 503 / 504，最多 DEFAULT_GENERIC_MAX_RETRIES(3) 次
// - rateLimitRetryCount : 429 专用，最多 RATE_LIMIT_MAX_RETRIES(10) 次
// - 终态 429 原样返回，绝不包装成 500
// - 终态 4xx/5xx 由调用方负责 recordRouteUpstreamError 记录（fetchWithRetry 只看 5xx 终态兜底）
// - route 是可选上下文：调用方拿到 response 后再做 route-aware 记录
//
// 返回值:最终 response（可能是终态 4xx/5xx/429），不再 throw fetch 错误（由调用方感知）。
// 真正 fetch 失败时抛 lastError。
export async function fetchWithRetry(url, options, route = null) {
  let lastError = null;
  let genericRetryCount = 0;
  let rateLimitRetryCount = 0;

  // 防御性兜底：while(true) 里若代码出 bug 也得能跳出
  const hardCap = DEFAULT_GENERIC_MAX_RETRIES + RATE_LIMIT_MAX_RETRIES + 50;

  while (genericRetryCount < DEFAULT_GENERIC_MAX_RETRIES
      || rateLimitRetryCount < RATE_LIMIT_MAX_RETRIES) {
    if (genericRetryCount + rateLimitRetryCount >= hardCap) {
      break;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_UPSTREAM_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;

      if (genericRetryCount < DEFAULT_GENERIC_MAX_RETRIES) {
        genericRetryCount += 1;
        const delay = DEFAULT_RETRY_BASE_MS * Math.pow(2, genericRetryCount - 1) + Math.random() * 500;
        logRaw(
          `[warn][retry] generic ${genericRetryCount}/${DEFAULT_GENERIC_MAX_RETRIES} fetch error: ${error.message}, retrying in ${Math.round(delay)}ms`,
        );
        await sleep(delay);
        continue;
      }

      // 普通重试耗尽：交给调用方抛错并 recordRouteUpstreamError
      recordRouteUpstreamError(route, { kind: "upstream-fetch", summary: error.message });
      throw error;
    }

    clearTimeout(timeout);

    // 429 走专用分支
    if (response.status === 429) {
      if (rateLimitRetryCount >= RATE_LIMIT_MAX_RETRIES) {
        // 429 耗尽：原样返回 response，body 必须保持未消费，由 handleProxy 转给客户端。
        // ⚠️ V5.2 §5.2：绝不能 await response.arrayBuffer() / response.text() 等会消耗 body 的方法。
        // 任何 retry 路径上要丢弃的 response 才能 drain。
        logRaw(`[warn][retry] 429 exhausted ${RATE_LIMIT_MAX_RETRIES} retries, returning 429`);
        recordRouteUpstreamError(route, {
          kind: "rate-limited",
          status: 429,
          summary: `429 exhausted ${RATE_LIMIT_MAX_RETRIES} retries`,
        });
        return response;
      }

      rateLimitRetryCount += 1;
      const delay = getRetryAfterMs(response) ?? RATE_LIMIT_RETRY_DELAY_MS;
      logRaw(
        `[warn][retry] 429 rate limited, attempt ${rateLimitRetryCount}/${RATE_LIMIT_MAX_RETRIES}, waiting ${Math.round(delay)}ms`,
      );
      // 429 进度更新也记：CLI footer 在 60s 窗口内能体现进度
      recordRouteUpstreamError(route, {
        kind: "rate-limited",
        status: 429,
        summary: `429 attempt ${rateLimitRetryCount}/${RATE_LIMIT_MAX_RETRIES}`,
      });
      await sleep(delay);
      continue;
    }

    // 502/503/504 走 generic 预算
    if (RETRYABLE_TRANSPORT_STATUS.has(response.status)) {
      if (genericRetryCount >= DEFAULT_GENERIC_MAX_RETRIES) {
        // 5xx 终态：原样返回，由调用方 recordRouteUpstreamError
        return response;
      }
      genericRetryCount += 1;
      try { await response.arrayBuffer(); } catch { /* ignore */ }
      const baseDelay = DEFAULT_RETRY_BASE_MS * Math.pow(2, genericRetryCount - 1);
      const delay = baseDelay + Math.random() * 500;
      logRaw(
        `[warn][retry] generic ${genericRetryCount}/${DEFAULT_GENERIC_MAX_RETRIES} upstream ${response.status}, retrying in ${Math.round(delay)}ms`,
      );
      await sleep(delay);
      continue;
    }

    // 2xx 或其他不可重试状态：直接返回
    return response;
  }

  // 正常路径不会到这里，兜底抛错
  throw lastError ?? new Error("fetchWithRetry exhausted all budgets");
}

function detectModelFamily(requestedModel) {
  const normalized = String(requestedModel ?? "").trim().toLowerCase();

  if (normalized === "best" || normalized === "default" || normalized === "auto") {
    return "opus";
  }
  if (normalized === "opus") {
    return "opus";
  }
  if (normalized === "sonnet") {
    return "sonnet";
  }
  if (normalized === "sonnet[1m]") {
    return "sonnet[1m]";
  }
  if (normalized === "haiku") {
    return "haiku";
  }
  if (/^claude-opus-[0-9-]+(?:\[1m\])?$/.test(normalized)) {
    return "opus";
  }
  if (/^claude-sonnet-[0-9-]+\[1m\]$/.test(normalized)) {
    return "sonnet[1m]";
  }
  if (/^claude-sonnet-[0-9-]+$/.test(normalized)) {
    return "sonnet";
  }
  if (/^claude-haiku-[0-9-]+$/.test(normalized)) {
    return "haiku";
  }

  return "opus";
}

function hasOneMillionContextSignal(req, body) {
  const betaHeaderValue = req.headers["anthropic-beta"];
  const betaHeader = Array.isArray(betaHeaderValue)
    ? betaHeaderValue.join(",")
    : String(betaHeaderValue ?? "");

  const bodyBetas = Array.isArray(body?.betas)
    ? body.betas.map((item) => String(item)).join(",")
    : "";

  const signal = `${betaHeader},${bodyBetas}`.toLowerCase();
  return signal.includes("1m") || signal.includes("context-1m");
}

function buildAuthHeaderValue(providerConfig, key) {
  if (!providerConfig.authScheme) {
    return key.token;
  }
  return `${providerConfig.authScheme} ${key.token}`;
}

function copyRequestHeaders(req, providerConfig, key) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (!value) {
      continue;
    }

    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === "authorization") {
      continue;
    }

    if (Array.isArray(value)) {
      headers.set(name, value.join(", "));
    } else {
      headers.set(name, value);
    }
  }

  headers.set(providerConfig.authHeader, buildAuthHeaderValue(providerConfig, key));
  headers.set("content-type", "application/json");
  return headers;
}

function copyResponseHeaders(upstreamHeaders, res) {
  for (const [name, value] of upstreamHeaders.entries()) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    res.setHeader(name, value);
  }
}

async function readJsonBody(req, maxSize = DEFAULT_MAX_BODY_SIZE) {
  const chunks = [];
  let totalSize = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalSize += buf.length;
    if (totalSize > maxSize) {
      throw new GatewayHttpError(413, "invalid_request_error", `Request body exceeds ${maxSize} byte limit`);
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
    throw new GatewayHttpError(400, "invalid_request_error", `Invalid JSON body: ${message}`);
  }
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function getMetricBucket(metrics, family) {
  if (!metrics[family]) {
    metrics[family] = [];
  }
  return metrics[family];
}

function recordMetric(metrics, family, isError) {
  const bucket = getMetricBucket(metrics, family);
  const now = Date.now();
  bucket.push({ ts: now, isError });
  const cutoff = now - 60_000;

  while (bucket.length > 0 && bucket[0].ts < cutoff) {
    bucket.shift();
  }
}

function summarizeRoute(config, family) {
  const resolved = resolveBoundRoute(config, family);
  if (resolved.kind !== "ok") {
    return null;
  }

  return {
    providerId: resolved.providerId,
    providerName: resolved.providerConfig.name,
    baseUrlId: resolved.baseUrlId,
    baseUrlNote: resolved.baseUrl.note,
    baseUrlHost: resolved.baseUrl.url,
    modelId: resolved.model.id,
    modelName: resolved.model.name,
    modelModel: resolved.model.model,
    keyId: resolved.key.id,
  };
}

export function buildHealthPayload(config) {
  return {
    status: "ok",
    host: config.gateway.host,
    port: config.gateway.port,
    modelFamilies: Object.fromEntries(
      Object.keys(config.modelFamilies).map((family) => [family, summarizeRoute(config, family)]),
    ),
  };
}

function isFailoverStatus(status) {
  return status >= 500 || FAILOVER_TRIGGER_STATUS.has(status);
}

async function drainBody(response) {
  if (!response || !response.body) return;
  try {
    await response.arrayBuffer();
  } catch {
    // ignore：丢弃的响应，释放连接
  }
}

// ===== 用量采集 =====
// 流式 SSE 嗅探：透传 chunk 不改动响应，同时解析 message_start / message_delta 事件里的 usage。
// Anthropic 流式 usage 分布在两处：
//   - message_start 事件 data.message.usage 含 input_tokens / cache_creation_input_tokens / cache_read_input_tokens
//   - message_delta 事件 data.usage 含 output_tokens（每帧累加或最终值，取最后一个）
// 解析失败静默：嗅探不能影响主请求路径。
function createUsageSniffer(route, status, startedAt, onDone) {
  let buffer = "";
  const usage = { in: 0, out: 0, cacheR: 0, cacheW: 0 };

  const flush = () => {
    if (usage.in || usage.out || usage.cacheR || usage.cacheW) {
      onDone({ route, status, startedAt, usage });
    } else {
      // 流式但没解析到 usage：仍记录一次请求（token=0），保证请求数统计完整
      onDone({ route, status, startedAt, usage: { in: 0, out: 0, cacheR: 0, cacheW: 0 } });
    }
  };

  const sniffer = new Transform({
    transform(chunk, _enc, callback) {
      // 原样往下传：客户端拿到的字节与不嗅探时完全一致
      callback(null, chunk);

      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const eventBlock = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!eventBlock.includes("usage")) continue;

        // 提取 data: 行
        const dataLine = eventBlock
          .split("\n")
          .find((l) => l.startsWith("data:") || l.startsWith("data: "));
        if (!dataLine) continue;

        try {
          const payload = JSON.parse(dataLine.slice(5).trim());
          const u = payload?.usage;
          if (!u) continue;
          // message_start 带 input 系列字段
          if (typeof u.input_tokens === "number") usage.in = u.input_tokens;
          if (typeof u.cache_creation_input_tokens === "number") usage.cacheW = u.cache_creation_input_tokens;
          if (typeof u.cache_read_input_tokens === "number") usage.cacheR = u.cache_read_input_tokens;
          // message_delta 带 output_tokens（最终值覆盖即可）
          if (typeof u.output_tokens === "number") usage.out = u.output_tokens;
        } catch {
          // 单条解析失败忽略
        }
      }
    },
    flush(callback) {
      flush();
      callback();
    },
  });

  // 安全兜底：流提前关闭（stream-error）也要 flush 当前已采集的部分
  sniffer.on("error", () => flush());
  return sniffer;
}

// 落盘一条用量记录。所有路径共用，封装避免散落。
function emitUsage({ route, status, startedAt, usage }) {
  if (!route) return;
  const ms = Date.now() - startedAt;
  recordUsage({
    family: route.modelFamily ?? null,
    providerId: route.providerId ?? null,
    modelId: route.modelId ?? null,
    keyId: route.keyId ?? null,
    in: usage?.in ?? 0,
    out: usage?.out ?? 0,
    cacheR: usage?.cacheR ?? 0,
    cacheW: usage?.cacheW ?? 0,
    status: status ?? 0,
    ms,
  }).catch(() => {
    // recordUsage 内部已 warn，这里不再处理
  });
}

// 合并熔断参数：全局 config.circuitBreaker ← per-family circuitBreaker 覆盖。
function mergeBreakerParams(globalCB, familyCB) {
  return { ...(globalCB || {}), ...(familyCB || {}) };
}

// failover 循环：在候选间换上游。首字节前（response header 阶段）才切；
// 拿到非触发集响应即返回，后续 pipe 阶段不再 failover（防重复/乱码 token）。
// 返回 { route, response }（可用响应，或透传最后一个失败响应保留真实上游错误）
//   或 { failure: Error }（全候选 fetch throw）。
async function tryWithFailover({ resolved, pathname, req, body, breakerParams, upstreamPath = null }) {
  // upstreamPath：上游实际要打的路径。默认沿用客户端 pathname（/v1/messages 行为不变）；
  // Responses 入口传 "/v1/messages" 把客户端的 /v1/responses 与上游路径解耦。
  const targetPath = upstreamPath ?? pathname;
  const candidates = orderCandidates(
    resolved.candidates,
    resolved.strategy,
    resolved.modelFamily,
    breakerParams,
  );

  let lastError = null;
  let lastRoute = null;
  let lastResponse = null;

  for (const route of candidates) {
    // 每个候选用自己的 upstreamModel 重组 body（不同上游模型名可能不同）
    const upstreamBody = JSON.stringify({ ...body, model: route.upstreamModel });
    let response;
    try {
      response = await fetchWithRetry(joinUrl(route.upstreamUrl, targetPath), {
        method: "POST",
        headers: copyRequestHeaders(req, route.providerConfig, route.key),
        body: upstreamBody,
      }, route);
    } catch (error) {
      recordBreakerFailure(breakerKey(route), breakerParams);
      logFailoverSwitch({
        family: route.modelFamily,
        fromProvider: route.providerId,
        toProvider: "(next)",
        status: "throw",
        reason: error instanceof Error ? error.message : String(error),
      });
      lastError = error;
      lastRoute = route;
      lastResponse = null;
      continue;
    }

    if (isFailoverStatus(response.status)) {
      recordBreakerFailure(breakerKey(route), breakerParams);
      logFailoverSwitch({
        family: route.modelFamily,
        fromProvider: route.providerId,
        toProvider: "(next)",
        status: response.status,
      });
      if (lastResponse) {
        await drainBody(lastResponse); // 释放被覆盖的旧响应连接
      }
      lastError = null;
      lastRoute = route;
      lastResponse = response;
      continue;
    }

    recordBreakerSuccess(breakerKey(route), breakerParams);
    if (lastResponse) {
      await drainBody(lastResponse);
    }
    return { route, response };
  }

  // 全候选失败：透传最后一个失败响应（保留真实 503/429/401）；无响应则返回 failure
  if (lastResponse) {
    return { route: lastRoute, response: lastResponse };
  }
  return { failure: lastError ?? new Error("tryWithFailover: no candidates and no error") };
}

async function handleProxy(config, metrics, req, res, pathname) {
  const body = await readJsonBody(req);
  if (!body.model || typeof body.model !== "string") {
    writeJson(res, 400, {
      error: {
        type: "invalid_request_error",
        message: "Request JSON must include a string `model` field.",
      },
    });
    return;
  }

  const requestedModel = body.model;
  const family = detectModelFamily(requestedModel);
  let effectiveFamily = family;
  if (family === "sonnet" && hasOneMillionContextSignal(req, body)) {
    effectiveFamily = "sonnet[1m]";
  }

  const resolved = resolveCandidates(config, effectiveFamily);
  if (resolved.kind === "unknown_family") {
    writeJson(res, 400, {
      error: {
        type: "invalid_request_error",
        message: `Unknown gateway model: ${requestedModel}`,
        supported_model_families: Object.keys(config.modelFamilies),
      },
    });
    return;
  }

  if (resolved.kind !== "ok") {
    recordMetric(metrics, effectiveFamily, true);
    writeJson(res, 503, {
      error: {
        type: "api_error",
        message: `Model family ${effectiveFamily} is not fully configured.`,
      },
    });
    return;
  }

  const breakerParams = mergeBreakerParams(config.circuitBreaker, resolved.circuitBreaker);

  const outcome = await tryWithFailover({ resolved, pathname, req, body, breakerParams });
  if (outcome.failure) {
    recordMetric(metrics, effectiveFamily, true);
    // fetch 耗尽：errorBus 已经在 fetchWithRetry 内部 recordRouteUpstreamError（带 family/providerId）。
    const error = outcome.failure;
    const message = error instanceof Error ? error.message : String(error);
    const cause =
      error && typeof error === "object" && "cause" in error ? String(error.cause) : "unknown";
    throw new Error(
      `Upstream fetch failed for family ${effectiveFamily} ${pathname}: ${message}; cause=${cause}`,
    );
  }

  const route = outcome.route;
  const upstreamResponse = outcome.response;

  // 终态 4xx/5xx 纳入 footer 可见性模型（V5.1 §5.4 / V5.2 §5.3）
  // 429 已经在 fetchWithRetry 内部记成 rate-limited，这里不要再覆盖成 api-error。
  if (upstreamResponse.status === 429) {
    // 不重复记录：fetchWithRetry 已经把 429 终态记为 rate-limited
  } else if (upstreamResponse.status >= 500) {
    recordRouteUpstreamError(route, {
      kind: "upstream-5xx",
      status: upstreamResponse.status,
      summary: `${route.providerId}:${route.upstreamModel} ${pathname} -> ${upstreamResponse.status}`,
    });
  } else if (upstreamResponse.status >= 400) {
    recordRouteUpstreamError(route, {
      kind: "api-error",
      status: upstreamResponse.status,
      summary: `${route.providerId}:${route.upstreamModel} ${pathname} -> ${upstreamResponse.status}`,
    });
  }

  res.statusCode = upstreamResponse.status;
  copyResponseHeaders(upstreamResponse.headers, res);

  const startedAt = Date.now();
  const isStream = body.stream === true || body.stream === "true";

  // 错误响应（4xx/5xx）没有可用 usage，直接记录一次请求（token=0）便于统计错误率
  if (upstreamResponse.status >= 400) {
    recordMetric(metrics, route.modelFamily, true);
    if (!upstreamResponse.body) {
      res.end();
    } else {
      // 错误响应通常很小，直接透传即可（保留原 stream.pipe 行为）
      const errStream = Readable.fromWeb(upstreamResponse.body);
      errStream.on("error", () => res.writableEnded || res.end());
      errStream.pipe(res);
    }
    emitUsage({ route, status: upstreamResponse.status, startedAt, usage: { in: 0, out: 0, cacheR: 0, cacheW: 0 } });
    logRequest(route, pathname, upstreamResponse.status);
    return;
  }

  if (!upstreamResponse.body) {
    recordMetric(metrics, route.modelFamily, false);
    res.end();
    emitUsage({ route, status: upstreamResponse.status, startedAt, usage: { in: 0, out: 0, cacheR: 0, cacheW: 0 } });
    logRequest(route, pathname, upstreamResponse.status);
    return;
  }

  // 流式：透传 + 嗅探 SSE usage（不改动响应内容）
  if (isStream) {
    const upstreamStream = Readable.fromWeb(upstreamResponse.body);
    const sniffer = createUsageSniffer(
      route,
      upstreamResponse.status,
      startedAt,
      (result) => emitUsage(result),
    );

    upstreamStream.on("error", (error) => {
      recordMetric(metrics, route.modelFamily, true);
      logRaw(`[error][stream-error] ${route.providerId}:${route.upstreamModel} ${pathname}: ${error.message}`);
      recordUpstreamError({
        family: route.modelFamily,
        providerId: route.providerId,
        kind: "stream-error",
        summary: error.message,
      });
      if (!res.writableEnded) {
        res.end();
      }
    });
    upstreamStream.pipe(sniffer).pipe(res);

    res.on("finish", () => {
      recordMetric(metrics, route.modelFamily, false);
      logRequest(route, pathname, upstreamResponse.status);
    });
    return;
  }

  // 非流式：缓冲完整 body，解析 usage 后再发给客户端。
  // ⚠️ 必须先把全部 buffer 读出来再 write，不能用 pipe（pipe 会消费流，无法二次读 usage）。
  const buf = [];
  let totalLen = 0;
  const upstreamStream = Readable.fromWeb(upstreamResponse.body);
  upstreamStream.on("error", (error) => {
    recordMetric(metrics, route.modelFamily, true);
    logRaw(`[error][stream-error] ${route.providerId}:${route.upstreamModel} ${pathname}: ${error.message}`);
    recordUpstreamError({
      family: route.modelFamily,
      providerId: route.providerId,
      kind: "stream-error",
      summary: error.message,
    });
    if (!res.writableEnded) {
      res.end();
    }
  });

  upstreamStream.on("data", (chunk) => {
    buf.push(chunk);
    totalLen += chunk.length;
  });

  upstreamStream.on("end", () => {
    const fullBody = Buffer.concat(buf, totalLen);

    // 尝试解析 usage
    let usage = { in: 0, out: 0, cacheR: 0, cacheW: 0 };
    if (fullBody.length > 0) {
      try {
        const parsed = JSON.parse(fullBody.toString("utf8"));
        const u = parsed?.usage;
        if (u && typeof u === "object") {
          if (typeof u.input_tokens === "number") usage.in = u.input_tokens;
          if (typeof u.output_tokens === "number") usage.out = u.output_tokens;
          if (typeof u.cache_creation_input_tokens === "number") usage.cacheW = u.cache_creation_input_tokens;
          if (typeof u.cache_read_input_tokens === "number") usage.cacheR = u.cache_read_input_tokens;
        }
      } catch {
        // 上游返回非 JSON 或格式异常，usage 留 0
      }
    }

    if (!res.writableEnded) {
      res.end(fullBody);
    }
    emitUsage({ route, status: upstreamResponse.status, startedAt, usage });
    recordMetric(metrics, route.modelFamily, false);
    logRequest(route, pathname, upstreamResponse.status);
  });
}

// 生成 Responses 顶层 response id（resp_ 前缀，24 位 hex）。
function generateResponseId() {
  return `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

// Codex（wire_api="responses"）入口：POST /v1/responses。
// 镜像 handleProxy 结构，但请求侧把 Responses body 预转成 Anthropic body 透传上游，
// 响应侧把 Anthropic 结果翻回 Responses 对象/SSE。family 路由 / failover / 熔断 / 用量统计全部复用。
// 上游路径强制为 /v1/messages（与客户端的 /v1/responses 解耦）。
async function handleResponsesProxy(config, metrics, req, res, pathname) {
  const body = await readJsonBody(req);
  const model = resolveModelFromResponses(body);
  if (!model || typeof model !== "string") {
    writeJson(res, 400, {
      error: {
        type: "invalid_request_error",
        message: "Request JSON must include a string `model` field.",
      },
    });
    return;
  }

  const family = detectModelFamily(model);
  // Codex 不发 anthropic-beta 1m 信号：用户需显式把 model 配成 "sonnet[1m]" 才走 1m family。
  const effectiveFamily = family;

  const resolved = resolveCandidates(config, effectiveFamily);
  if (resolved.kind === "unknown_family") {
    writeJson(res, 400, {
      error: {
        type: "invalid_request_error",
        message: `Unknown gateway model: ${model}`,
        supported_model_families: Object.keys(config.modelFamilies),
      },
    });
    return;
  }

  if (resolved.kind !== "ok") {
    recordMetric(metrics, effectiveFamily, true);
    writeJson(res, 503, {
      error: {
        type: "api_error",
        message: `Model family ${effectiveFamily} is not fully configured.`,
      },
    });
    return;
  }

  // Responses body → Anthropic body（含 input/tools/tool_choice/system 映射）
  const conv = responsesBodyToAnthropic(body);
  if (!conv.ok) {
    writeJson(res, conv.statusCode, {
      error: { type: conv.type, message: conv.message },
    });
    return;
  }
  const anthropicBody = conv.body;
  const isStream = isResponsesStream(body);
  anthropicBody.stream = isStream; // 上游按客户端期望的流/非流式响应

  const breakerParams = mergeBreakerParams(config.circuitBreaker, resolved.circuitBreaker);
  const requestId = generateResponseId();

  const outcome = await tryWithFailover({
    resolved,
    pathname,
    upstreamPath: "/v1/messages",
    req,
    body: anthropicBody,
    breakerParams,
  });
  if (outcome.failure) {
    recordMetric(metrics, effectiveFamily, true);
    const error = outcome.failure;
    const message = error instanceof Error ? error.message : String(error);
    const cause =
      error && typeof error === "object" && "cause" in error ? String(error.cause) : "unknown";
    throw new Error(
      `Upstream fetch failed for responses family ${effectiveFamily}: ${message}; cause=${cause}`,
    );
  }

  const route = outcome.route;
  const upstreamResponse = outcome.response;

  // 终态 4xx/5xx 记录（429 已在 fetchWithRetry 内部记为 rate-limited，不重复）
  if (upstreamResponse.status === 429) {
    // 跳过：fetchWithRetry 已记
  } else if (upstreamResponse.status >= 500) {
    recordRouteUpstreamError(route, {
      kind: "upstream-5xx",
      status: upstreamResponse.status,
      summary: `${route.providerId}:${route.upstreamModel} responses -> ${upstreamResponse.status}`,
    });
  } else if (upstreamResponse.status >= 400) {
    recordRouteUpstreamError(route, {
      kind: "api-error",
      status: upstreamResponse.status,
      summary: `${route.providerId}:${route.upstreamModel} responses -> ${upstreamResponse.status}`,
    });
  }

  const startedAt = Date.now();

  // 上游错误：透传状态码，把 Anthropic 错误体包成 Responses 风格 error 返回
  if (upstreamResponse.status >= 400) {
    recordMetric(metrics, route.modelFamily, true);
    let errText = "";
    try {
      errText = await upstreamResponse.text();
    } catch {
      errText = "";
    }
    let errMessage = `upstream returned ${upstreamResponse.status}`;
    try {
      const parsed = JSON.parse(errText);
      errMessage = parsed?.error?.message || parsed?.message || errMessage;
    } catch {
      // 非 JSON 错误体：保留默认消息
    }
    writeJson(res, upstreamResponse.status, {
      error: { type: "upstream_error", message: errMessage },
    });
    emitUsage({ route, status: upstreamResponse.status, startedAt, usage: { in: 0, out: 0, cacheR: 0, cacheW: 0 } });
    logRequest(route, pathname, upstreamResponse.status);
    return;
  }

  // 无 body：返回空 completed
  if (!upstreamResponse.body) {
    recordMetric(metrics, route.modelFamily, false);
    writeJson(res, 200, buildResponsesEnvelope({
      id: requestId,
      model,
      status: "completed",
      output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    }));
    emitUsage({ route, status: upstreamResponse.status, startedAt, usage: { in: 0, out: 0, cacheR: 0, cacheW: 0 } });
    logRequest(route, pathname, upstreamResponse.status);
    return;
  }

  // 流式：上游 Anthropic SSE → translate → 客户端 Responses SSE
  if (isStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    });

    const upstreamStream = Readable.fromWeb(upstreamResponse.body);
    const translate = createAnthropicToResponsesStream({
      requestId,
      model,
      onUsage: (u) => emitUsage({ route, status: upstreamResponse.status, startedAt, usage: u }),
    });

    upstreamStream.on("error", (error) => {
      recordMetric(metrics, route.modelFamily, true);
      logRaw(`[error][responses-stream] ${route.providerId}:${route.upstreamModel} ${pathname}: ${error.message}`);
      recordUpstreamError({
        family: route.modelFamily,
        providerId: route.providerId,
        kind: "stream-error",
        summary: error.message,
      });
      try {
        translate.destroy(error);
      } catch {
        // ignore
      }
      if (!res.writableEnded) {
        res.end();
      }
    });

    translate.on("error", (error) => {
      logRaw(`[error][responses-translate] ${route.providerId}:${route.upstreamModel}: ${error.message}`);
    });

    upstreamStream.pipe(translate).pipe(res);

    res.on("finish", () => {
      recordMetric(metrics, route.modelFamily, false);
      logRequest(route, pathname, upstreamResponse.status);
    });
    return;
  }

  // 非流式：缓冲完整 Anthropic 响应，整体翻译成 Responses 对象
  const buf = [];
  let totalLen = 0;
  const upstreamStream = Readable.fromWeb(upstreamResponse.body);
  upstreamStream.on("error", (error) => {
    recordMetric(metrics, route.modelFamily, true);
    logRaw(`[error][responses-body] ${route.providerId}:${route.upstreamModel} ${pathname}: ${error.message}`);
    if (!res.writableEnded) {
      writeJson(res, 502, {
        error: { type: "upstream_read_error", message: error.message },
      });
    }
  });

  upstreamStream.on("data", (chunk) => {
    buf.push(chunk);
    totalLen += chunk.length;
  });

  upstreamStream.on("end", () => {
    const fullBody = Buffer.concat(buf, totalLen);
    let anthropicJson = {};
    if (fullBody.length > 0) {
      try {
        anthropicJson = JSON.parse(fullBody.toString("utf8"));
      } catch {
        anthropicJson = {};
      }
    }
    const { responsesObject, usage } = anthropicResponseToResponses(anthropicJson, requestId);
    writeJson(res, 200, responsesObject);
    emitUsage({ route, status: upstreamResponse.status, startedAt, usage });
    recordMetric(metrics, route.modelFamily, false);
    logRequest(route, pathname, upstreamResponse.status);
  });
}

function checkGatewayAuth(config, req, res) {
  if (!config.gateway.sharedToken) {
    return true;
  }

  const expected = `Bearer ${config.gateway.sharedToken}`;
  if (req.headers.authorization !== expected) {
    writeJson(res, 401, {
      error: {
        type: "authentication_error",
        message: "Invalid gateway token.",
      },
    });
    return false;
  }

  return true;
}

export function createGatewayRequestHandler(config, metrics, ctx = {}) {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;

      if (pathname.startsWith("/admin/")) {
        await handleAdmin({
          config,
          metrics,
          req,
          res,
          pathname,
          runtime: ctx.runtime,
          getHealthPayload: () => buildHealthPayload(config),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/health") {
        writeJson(res, 200, buildHealthPayload(config));
        return;
      }

      if (
        req.method === "POST"
        && (pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens")
      ) {
        if (!checkGatewayAuth(config, req, res)) {
          return;
        }

        await handleProxy(config, metrics, req, res, pathname);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/responses") {
        if (!checkGatewayAuth(config, req, res)) {
          return;
        }

        await handleResponsesProxy(config, metrics, req, res, pathname);
        return;
      }

      writeJson(res, 404, {
        error: {
          type: "not_found_error",
          message: `Unsupported route: ${req.method} ${pathname}`,
        },
      });
    } catch (error) {
      // 本地输入错误：尊重 typed statusCode/Type，直接返回 4xx
      if (error instanceof GatewayHttpError) {
        if (!res.headersSent) {
          writeJson(res, error.statusCode, {
            error: {
              type: error.type,
              message: error.message,
            },
          });
        }
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logRaw(`[error][gateway-error] ${message}`);
      if (!res.headersSent) {
        writeJson(res, 500, {
          error: {
            type: "api_error",
            message,
          },
        });
      } else {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    }
  };
}
