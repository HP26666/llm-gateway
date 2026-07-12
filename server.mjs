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
  forceOpen,
  getBreakerState,
  orderCandidates,
  recordBreakerFailure,
  recordBreakerSuccess,
} from "./circuit-breaker.mjs";
import { recordUsage } from "./usage-store.mjs";
import { randomUUID, timingSafeEqual } from "node:crypto";
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
// 首字节（response headers）超时：上游 headers 在此时长内未到达即判失败（典型 GLM 限额 hang）。
// fetchWithRetry 识别 TTFB 超时后不重试、直接抛，由 tryWithFailover 切到副候选。
// 30s（非 15s）：大上下文请求冷缓存时 pre-fill（处理全部输入 token）可能 >15s，
// 15s 会把正常的慢启动误判为 hang 而误杀。30s 覆盖绝大多数冷缓存场景；真 hang 时
// 等待翻倍但配合熔断器（failureThreshold=3）仍可在合理时间内切换，可接受。
const DEFAULT_TTFB_TIMEOUT_MS = 30_000;
// 普通重试预算（fetch error / 502/503/504）独立计数：V5.1 §5.1
const DEFAULT_GENERIC_MAX_RETRIES = 3;
// 429 重试预算独立计数：V5.1 §5.1
// V5.3: 429 只重试 1 次——在有 failover 候选的场景下，重复打同一个被限流的上游
// 毫无意义，应尽快切到下一个候选。剩余重试预算留给同候选的可能恢复。
const RATE_LIMIT_MAX_RETRIES = 1;
const RATE_LIMIT_RETRY_DELAY_MS = 5_000;
// 429 只重试 1 次即视为失败→通知熔断器，让 orderCandidates 直接跳过此候选。
const BREAKER_429_RETRY_THRESHOLD = 1;
const DEFAULT_RETRY_BASE_MS = 1000;

export class GatewayHttpError extends Error {
  constructor(statusCode, type, message) {
    super(message);
    this.name = "GatewayHttpError";
    this.statusCode = statusCode;
    this.type = type;
  }
}

// TTFB 超时专用错误。作为 controller.abort(reason) 的 reason 注入，fetchWithRetry catch 块
// 通过 controller.signal.reason 识别它（reason 不在 fetch 抛出的 AbortError 上，必须读 signal.reason）。
class TtfbTimeoutError extends Error {
  constructor(ms) {
    super(`upstream TTFB timeout after ${ms}ms (headers not received)`);
    this.name = "TtfbTimeoutError";
    this.code = "TTFB_TIMEOUT";
  }
}

// 连接类错误：provider 不可达/挂了，毫秒级失败且不会自愈，重试毫无意义。
// 识别方式：fetch TypeError 的 cause.code（undici 底层 libuv 错误码）。涵盖 TCP/DNS/路由变体。
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",   // TCP connect 被拒（端口不通 = 进程挂了）
  "ECONNRESET",     // 连接被对端重置
  "ENOTFOUND",      // DNS 解析失败（域名不存在）
  "ETIMEDOUT",      // 连接超时（不可路由的 IP）
  "EHOSTUNREACH",   // 主机不可达
  "ENETUNREACH",    // 网络不可达
  "EAI_AGAIN",      // DNS 临时失败（可重试，但通常持续）
  "EAI_NONAME",     // DNS 名称不存在
  "EAI_FAIL",       // DNS 永久失败
  "ECONNABORTED",   // 连接中止
]);
function isConnectionError(error) {
  const code = error?.cause?.code;
  return typeof code === "string" && CONNECTION_ERROR_CODES.has(code);
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
export async function fetchWithRetry(url, options, route = null, { breakerNotify, ttfbTimeoutMs = DEFAULT_TTFB_TIMEOUT_MS } = {}) {
  let lastError = null;
  let genericRetryCount = 0;
  let rateLimitRetryCount = 0;
  let breakerNotified = false;

  // 防御性兜底：while(true) 里若代码出 bug 也得能跳出
  const hardCap = DEFAULT_GENERIC_MAX_RETRIES + RATE_LIMIT_MAX_RETRIES + 50;

  while (genericRetryCount < DEFAULT_GENERIC_MAX_RETRIES
      || rateLimitRetryCount < RATE_LIMIT_MAX_RETRIES) {
    if (genericRetryCount + rateLimitRetryCount >= hardCap) {
      break;
    }

    const controller = new AbortController();
    // 双 timer 共用同一 controller：TTFB 先到点先 abort 并带 TtfbTimeoutError reason；
    // 总超时兜底覆盖 headers 阶段。fetch resolve（headers 到达）后两个都清，避免 totalTimer 泄漏。
    const ttfbTimer = setTimeout(
      () => controller.abort(new TtfbTimeoutError(ttfbTimeoutMs)),
      ttfbTimeoutMs,
    );
    const totalTimer = setTimeout(
      () => controller.abort(new Error("upstream total timeout")),
      DEFAULT_UPSTREAM_TIMEOUT_MS,
    );

    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      clearTimeout(ttfbTimer);
      clearTimeout(totalTimer);

      // TTFB 超时（上游 headers 迟迟不来，典型 GLM 限额 hang）：不重试，直接抛，
      // 由 tryWithFailover 切到副候选。abort reason 不在抛出的 AbortError 上，必须读 signal.reason。
      const reason = controller.signal.reason;
      if (reason instanceof TtfbTimeoutError) {
        logRaw(`[warn][retry] TTFB timeout ${ttfbTimeoutMs}ms, not retrying, handing to failover`);
        recordRouteUpstreamError(route, { kind: "ttfb-timeout", summary: `TTFB > ${ttfbTimeoutMs}ms` });
        throw reason;
      }

      // 连接失败（ECONNREFUSED/ENOTFOUND 等）：provider 挂了/不可达，毫秒级返回且不会自愈。
      // 重试毫无意义——不重试，直接抛给 tryWithFailover 切副候选，避免白等 7.5s 退避。
      if (isConnectionError(error)) {
        logRaw(`[warn][retry] connection error (${error.cause?.code}), not retrying, handing to failover`);
        recordRouteUpstreamError(route, {
          kind: "upstream-fetch",
          summary: `connection error: ${error.cause?.code || error.message}`,
        });
        throw error;
      }

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

    clearTimeout(ttfbTimer);
    clearTimeout(totalTimer);

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
      // 429 重试达到熔断阈值时，提前通知熔断器（不等 10 次耗尽），
      // 让 tryWithFailover 的 orderCandidates 能更快跳过被限流的上游。
      if (!breakerNotified && rateLimitRetryCount >= BREAKER_429_RETRY_THRESHOLD && typeof breakerNotify === "function") {
        breakerNotified = true;
        breakerNotify();
      }
      const rawDelay = getRetryAfterMs(response) ?? RATE_LIMIT_RETRY_DELAY_MS;
      // V5.3: 在有 failover 候选的场景下，429 等太久无意义——上游限流通常持续。
      // 最多等 10 秒就放弃本次重试，尽快切到下一个 provider。
      const delay = Math.min(rawDelay, 10_000);
      logRaw(
        `[warn][retry] 429 rate limited, attempt ${rateLimitRetryCount}/${RATE_LIMIT_MAX_RETRIES}, waiting ${Math.round(delay)}ms (capped from ${Math.round(rawDelay)}ms)`,
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

// 按 model 字段判定 family。关键字匹配（includes）覆盖 Anthropic 新老两种命名：
//   新：claude-sonnet-4-5 / claude-opus-4-1 / claude-haiku-3-5
//   旧：claude-3-5-sonnet-20241022 / claude-3-opus-20240229 / claude-3-haiku-20240307
// 旧式正则 ^claude-sonnet-[0-9-]+$ 漏掉"sonnet 在版本号中间"的老格式，静默兜底到 opus。
// [1m] 后缀单独识别：sonnet 带 [1m] → sonnet[1m]（独立 1M 上下文 family）。
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

  // [1m] 后缀判定（仅 sonnet 有独立 1m family；opus/haiku 带 [1m] 也按主 family 归类）
  const has1m = /\[1m\]$/.test(normalized);

  // 关键字匹配：顺序 opus > sonnet > haiku（三者互斥，Anthropic 不会同时含两个关键字）
  if (normalized.includes("sonnet")) {
    return has1m ? "sonnet[1m]" : "sonnet";
  }
  if (normalized.includes("opus")) {
    return "opus";
  }
  if (normalized.includes("haiku")) {
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

// ===== HALF_OPEN 惰性探活 =====
// 探活并发去重：同 key 的探活共享一次进行中的 Promise，避免多请求并发时重复打上游。
const inflightProbes = new Map();
const PROBE_TTFB_TIMEOUT_MS = 10_000;

// 对 HALF_OPEN 候选发起极简探活（独立 fetch，不走 fetchWithRetry：无重试、无 usage、无嗅探）。
// POST {upstreamUrl}/v1/messages，body 极简。2xx 或非 429 的 4xx → 上游活着（在正常响应）；
// 5xx / 429 / TTFB 超时 / 网络错误 → 仍不可用。
async function probeCandidateOnce(route) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new TtfbTimeoutError(PROBE_TTFB_TIMEOUT_MS)),
    PROBE_TTFB_TIMEOUT_MS,
  );
  const headers = new Headers();
  headers.set(route.providerConfig.authHeader, buildAuthHeaderValue(route.providerConfig, route.key));
  headers.set("content-type", "application/json");
  headers.set("anthropic-version", "2023-06-01");
  try {
    const res = await fetch(joinUrl(route.upstreamUrl, "/v1/messages"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: route.upstreamModel,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
        stream: false,
      }),
      signal: controller.signal,
    });
    return res.status < 500 && res.status !== 429;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// 带并发去重的探活入口：同 key 并发请求共享同一 Promise。
async function probeCandidate(route) {
  const k = breakerKey(route);
  const existing = inflightProbes.get(k);
  if (existing) return existing;
  const p = probeCandidateOnce(route).finally(() => inflightProbes.delete(k));
  inflightProbes.set(k, p);
  return p;
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
    // HALF_OPEN 惰性探活：冷却到期时先轻量确认恢复，不拿用户大请求当探活炮灰。
    const breakerK = breakerKey(route);
    if (getBreakerState(breakerK, breakerParams) === "HALF_OPEN") {
      const ok = await probeCandidate(route);
      if (ok) {
        recordBreakerSuccess(breakerK, breakerParams); // HALF_OPEN → CLOSED
        logRaw(`[info][breaker] probe ok ${route.providerId}:${route.upstreamModel}, HALF_OPEN→CLOSED`);
      } else {
        recordBreakerFailure(breakerK, breakerParams); // HALF_OPEN → OPEN，刷新 openedAt 重新冷却
        logFailoverSwitch({
          family: route.modelFamily,
          fromProvider: route.providerId,
          toProvider: "(next)",
          status: "probe-fail",
          reason: "probe failed",
        });
        // 记录有意义的 lastError，避免全候选 probe-fail 时抛 "no candidates and no error"。
        // 不覆盖已有的 lastError/lastResponse（fetch 失败/5xx 透传优先级更高）。
        if (!lastError && !lastResponse) {
          lastError = new Error(`probe failed for ${route.providerId}:${route.upstreamModel} (HALF_OPEN)`);
          lastRoute = route;
        }
        continue; // 走副候选
      }
    }

    // 每个候选用自己的 upstreamModel 重组 body（不同上游模型名可能不同）
    const upstreamBody = JSON.stringify({ ...body, model: route.upstreamModel });
    let response;
    try {
      response = await fetchWithRetry(joinUrl(route.upstreamUrl, targetPath), {
        method: "POST",
        headers: copyRequestHeaders(req, route.providerConfig, route.key),
        body: upstreamBody,
      }, route, {
        breakerNotify: () => recordBreakerFailure(breakerKey(route), breakerParams),
        ttfbTimeoutMs: breakerParams?.ttfbTimeoutMs,
      });
    } catch (error) {
      // 连接失败（ECONNREFUSED 等不可达）：provider 挂了不会自愈，1 次即熔断（forceOpen），
      // 让 orderCandidates 在下一个请求直接跳过此候选。其他失败仍走累计计数。
      if (isConnectionError(error)) {
        forceOpen(breakerKey(route), breakerParams);
      } else {
        recordBreakerFailure(breakerKey(route), breakerParams);
      }
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

// 常量时间字符串比较，避免 token 校验的 timing 侧信道（与 admin.mjs safeEqual 对齐）。
function safeEqualString(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function checkGatewayAuth(config, req, res) {
  if (!config.gateway.sharedToken) {
    return true;
  }

  const expected = `Bearer ${config.gateway.sharedToken}`;
  // 常量时间比较（非常量时间 ===），防 token 长度/前缀侧信道。
  if (!safeEqualString(req.headers.authorization, expected)) {
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
