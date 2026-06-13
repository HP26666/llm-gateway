import http from "node:http";
import { Readable } from "node:stream";

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
const DEFAULT_MAX_BODY_SIZE = 50 * 1024 * 1024; // 50 MB
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000; // 120 s
const DEFAULT_MAX_RETRIES = 3;
const RATE_LIMIT_RETRY_DELAY_MS = 5_000; // 429 固定 5s
const RATE_LIMIT_MAX_RETRIES = 10;
const DEFAULT_RETRY_BASE_MS = 1000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

function getEnv(name, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function getRequiredEnv(name) {
  const value = getEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function joinUrl(baseUrl, path) {
  const normalizedBase = trimTrailingSlash(baseUrl);
  return `${normalizedBase}${path}`;
}

function maskSecret(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "********";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryAfterMs(response) {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return null;
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

async function fetchWithRetry(url, options, maxRetries = DEFAULT_MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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

    // 必须消费掉 body 才能复用连接
    try {
      await response.arrayBuffer();
    } catch {
      // ignore
    }

    // 429 固定 5s 延迟，放宽重试上限，避免短时间内密集请求触发上游风控
    if (response.status === 429) {
      if (attempt >= RATE_LIMIT_MAX_RETRIES) {
        console.warn(
          `[retry] 429 exhausted ${RATE_LIMIT_MAX_RETRIES} retries, giving up`,
        );
        return response;
      }
      const delay = getRetryAfterMs(response) ?? RATE_LIMIT_RETRY_DELAY_MS;
      console.warn(
        `[retry] 429 rate limited, attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES}, waiting ${Math.round(delay)}ms`,
      );
      await sleep(delay);
      continue;
    }

    // 502/503/504 走指数退避
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

  // 理论上不会到这里，但保险起见
  throw lastError ?? new Error("fetchWithRetry exhausted retries");
}

function loadConfig() {
  const host = getEnv("GATEWAY_HOST", "127.0.0.1");
  const port = Number.parseInt(getEnv("PORT", "4000"), 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }

  return {
    host,
    port,
    sharedToken: getEnv("GATEWAY_SHARED_TOKEN"),
    modelFamilies: {
      opus: {
        provider: "glm",
        upstreamModel: getEnv("GLM_OPUS_UPSTREAM_MODEL", getEnv("GLM_MODEL", "glm-5.1")),
      },
      sonnet: {
        provider: "kimi",
        upstreamModel: getEnv(
          "KIMI_SONNET_UPSTREAM_MODEL",
          getEnv("KIMI_UPSTREAM_MODEL", getEnv("KIMI_MODEL", "kimi-for-coding")),
        ),
      },
      "sonnet[1m]": {
        provider: "deepseek",
        upstreamModel: getEnv(
          "DEEPSEEK_SONNET_1M_UPSTREAM_MODEL",
          getEnv("DEEPSEEK_MODEL", "deepseek-v4-pro"),
        ),
      },
      haiku: {
        provider: "deepseek",
        upstreamModel: getEnv(
          "DEEPSEEK_HAIKU_UPSTREAM_MODEL",
          getEnv("DEEPSEEK_FLASH_MODEL", "deepseek-v4-flash"),
        ),
      },
    },
    providers: {
      kimi: {
        baseUrl: trimTrailingSlash(getEnv("KIMI_BASE_URL", "https://api.kimi.com/coding/")),
        authHeader: getEnv("KIMI_AUTH_HEADER", "Authorization"),
        authScheme: getEnv("KIMI_AUTH_SCHEME", "Bearer"),
        authToken: getRequiredEnv("KIMI_AUTH_TOKEN"),
      },
      glm: {
        baseUrl: trimTrailingSlash(
          getEnv("GLM_BASE_URL", "https://open.bigmodel.cn/api/anthropic"),
        ),
        authHeader: getEnv("GLM_AUTH_HEADER", "Authorization"),
        authScheme: getEnv("GLM_AUTH_SCHEME", "Bearer"),
        authToken: getRequiredEnv("GLM_AUTH_TOKEN"),
      },
      deepseek: {
        baseUrl: trimTrailingSlash(
          getEnv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/anthropic"),
        ),
        authHeader: getEnv("DEEPSEEK_AUTH_HEADER", "Authorization"),
        authScheme: getEnv("DEEPSEEK_AUTH_SCHEME", "Bearer"),
        authToken: getRequiredEnv("DEEPSEEK_AUTH_TOKEN"),
      },
    },
  };
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

function buildAuthHeaderValue(providerConfig) {
  if (!providerConfig.authScheme) {
    return providerConfig.authToken;
  }
  return `${providerConfig.authScheme} ${providerConfig.authToken}`;
}

function copyRequestHeaders(req, providerConfig) {
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

  headers.set(providerConfig.authHeader, buildAuthHeaderValue(providerConfig));
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
  if (!family) {
    return null;
  }

  let effectiveFamily = family;
  if (family === "sonnet" && hasOneMillionContextSignal(req, body)) {
    effectiveFamily = "sonnet[1m]";
  }

  const route = config.modelFamilies[effectiveFamily];
  if (!route) {
    return null;
  }

  return {
    requestedModel,
    modelFamily: effectiveFamily,
    ...route,
    providerConfig: config.providers[route.provider],
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

function logRequest(route, pathname, upstreamStatus) {
  const now = new Date().toISOString();
  console.log(
    `[${now}] ${pathname} ${route.requestedModel} [${route.modelFamily}] -> ${route.provider}:${route.upstreamModel} (${upstreamStatus})`,
  );
}

async function handleProxy(config, req, res, pathname) {
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
  if (!route) {
    writeJson(res, 400, {
      error: {
        type: "invalid_request_error",
        message: `Unknown gateway model: ${body.model}`,
        supported_model_families: Object.keys(config.modelFamilies),
        examples: [
          "sonnet",
          "opus",
          "haiku",
          "claude-sonnet-4-6",
          "claude-opus-4-7",
          "claude-haiku-4-5",
        ],
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
    upstreamResponse = await fetchWithRetry(
      joinUrl(route.providerConfig.baseUrl, pathname),
      {
        method: "POST",
        headers: copyRequestHeaders(req, route.providerConfig),
        body: upstreamBody,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause =
      error && typeof error === "object" && "cause" in error
        ? String(error.cause)
        : "unknown";
    throw new Error(
      `Upstream fetch failed for ${route.provider}:${route.upstreamModel} ${pathname}: ${message}; cause=${cause}`,
    );
  }

  res.statusCode = upstreamResponse.status;
  copyResponseHeaders(upstreamResponse.headers, res);

  if (!upstreamResponse.body) {
    res.end();
    logRequest(route, pathname, upstreamResponse.status);
    return;
  }

  const stream = Readable.fromWeb(upstreamResponse.body);
  stream.on("error", (err) => {
    console.error(`[stream-error] ${route.provider}:${route.upstreamModel} ${pathname}: ${err.message}`);
    if (!res.writableEnded) {
      res.end();
    }
  });
  stream.pipe(res);

  res.on("finish", () => {
    logRequest(route, pathname, upstreamResponse.status);
  });
}

function checkGatewayAuth(config, req, res) {
  if (!config.sharedToken) {
    return true;
  }

  const expected = `Bearer ${config.sharedToken}`;
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

function createServer(config) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/health") {
        writeJson(res, 200, {
          status: "ok",
          modelFamilies: Object.fromEntries(
            Object.entries(config.modelFamilies).map(([family, route]) => [
              family,
              `${route.provider}:${route.upstreamModel}`,
            ]),
          ),
        });
        return;
      }

      if (
        req.method === "POST" &&
        (pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens")
      ) {
        if (!checkGatewayAuth(config, req, res)) {
          return;
        }

        await handleProxy(config, req, res, pathname);
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
      writeJson(res, 500, {
        error: {
          type: "api_error",
          message,
        },
      });
    }
  });
}

const config = loadConfig();
const server = createServer(config);

server.listen(config.port, config.host, () => {
  console.log(
    `Claude gateway listening on http://${config.host}:${config.port} | families: ${Object.entries(
      config.modelFamilies,
    )
      .map(([family, route]) => `${family}->${route.provider}:${route.upstreamModel}`)
      .join(", ")}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    const forceTimer = setTimeout(() => {
      console.warn("[shutdown] forcing exit after timeout");
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);

    server.close(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
  });
}
