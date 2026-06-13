import { Readable } from "node:stream";

import { handleAdmin } from "./admin.mjs";
import {
  logRequest,
  resolveBoundRoute,
} from "./route-utils.mjs";

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

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DEFAULT_MAX_BODY_SIZE = 50 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 3;
const RATE_LIMIT_RETRY_DELAY_MS = 5_000;
const RATE_LIMIT_MAX_RETRIES = 10;
const DEFAULT_RETRY_BASE_MS = 1000;

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

export async function fetchWithRetry(url, options, maxRetries = DEFAULT_MAX_RETRIES) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_UPSTREAM_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;

      if (attempt < maxRetries) {
        const delay = DEFAULT_RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500;
        console.warn(
          `[retry] attempt ${attempt + 1}/${maxRetries} fetch error: ${error.message}, retrying in ${Math.round(delay)}ms`,
        );
        await sleep(delay);
        continue;
      }

      throw lastError;
    }

    clearTimeout(timeout);

    if (!RETRYABLE_STATUS.has(response.status)) {
      return response;
    }

    try {
      await response.arrayBuffer();
    } catch {
      // ignore
    }

    if (response.status === 429) {
      if (attempt >= RATE_LIMIT_MAX_RETRIES) {
        console.warn(`[retry] 429 exhausted ${RATE_LIMIT_MAX_RETRIES} retries, giving up`);
        return response;
      }

      const delay = getRetryAfterMs(response) ?? RATE_LIMIT_RETRY_DELAY_MS;
      console.warn(
        `[retry] 429 rate limited, attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES}, waiting ${Math.round(delay)}ms`,
      );
      await sleep(delay);
      continue;
    }

    if (attempt >= maxRetries) {
      return response;
    }

    const baseDelay = DEFAULT_RETRY_BASE_MS * Math.pow(2, attempt);
    const delay = baseDelay + Math.random() * 500;
    console.warn(
      `[retry] attempt ${attempt + 1}/${maxRetries} upstream ${response.status}, retrying in ${Math.round(delay)}ms`,
    );
    await sleep(delay);
  }

  throw lastError ?? new Error("fetchWithRetry exhausted retries");
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
      throw new Error(`Request body exceeds ${maxSize} byte limit`);
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
    throw new Error(`Invalid JSON body: ${message}`);
  }
}

function selectRoute(config, req, body) {
  const requestedModel = body.model;
  const family = detectModelFamily(requestedModel);
  let effectiveFamily = family;

  if (family === "sonnet" && hasOneMillionContextSignal(req, body)) {
    effectiveFamily = "sonnet[1m]";
  }

  return {
    requestedModel,
    ...resolveBoundRoute(config, effectiveFamily),
  };
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

  const route = selectRoute(config, req, body);
  if (route.kind === "unknown_family") {
    writeJson(res, 400, {
      error: {
        type: "invalid_request_error",
        message: `Unknown gateway model: ${body.model}`,
        supported_model_families: Object.keys(config.modelFamilies),
      },
    });
    return;
  }

  if (route.kind !== "ok") {
    recordMetric(metrics, route.modelFamily, true);
    writeJson(res, 503, {
      error: {
        type: "api_error",
        message: `Model family ${route.modelFamily} is not fully configured.`,
      },
    });
    return;
  }

  const upstreamBody = JSON.stringify({
    ...body,
    model: route.upstreamModel,
  });

  let upstreamResponse;
  try {
    upstreamResponse = await fetchWithRetry(joinUrl(route.upstreamUrl, pathname), {
      method: "POST",
      headers: copyRequestHeaders(req, route.providerConfig, route.key),
      body: upstreamBody,
    });
  } catch (error) {
    recordMetric(metrics, route.modelFamily, true);
    const message = error instanceof Error ? error.message : String(error);
    const cause =
      error && typeof error === "object" && "cause" in error ? String(error.cause) : "unknown";
    throw new Error(
      `Upstream fetch failed for ${route.providerId}:${route.upstreamModel} ${pathname}: ${message}; cause=${cause}`,
    );
  }

  res.statusCode = upstreamResponse.status;
  copyResponseHeaders(upstreamResponse.headers, res);

  if (!upstreamResponse.body) {
    recordMetric(metrics, route.modelFamily, upstreamResponse.status >= 400);
    res.end();
    logRequest(route, pathname, upstreamResponse.status);
    return;
  }

  const stream = Readable.fromWeb(upstreamResponse.body);
  stream.on("error", (error) => {
    recordMetric(metrics, route.modelFamily, true);
    console.error(`[stream-error] ${route.providerId}:${route.upstreamModel} ${pathname}: ${error.message}`);
    if (!res.writableEnded) {
      res.end();
    }
  });
  stream.pipe(res);

  res.on("finish", () => {
    recordMetric(metrics, route.modelFamily, upstreamResponse.status >= 400);
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

      writeJson(res, 404, {
        error: {
          type: "not_found_error",
          message: `Unsupported route: ${req.method} ${pathname}`,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[gateway-error] ${message}`);
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
