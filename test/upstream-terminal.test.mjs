// V5.1 §5.4 / §7.4: 终态 upstream 4xx/5xx 纳入 footer 可见性
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGatewayRuntime } from "../gateway-runtime.mjs";
import { createGatewayRequestHandler } from "../server.mjs";
import { getLastUpstreamError } from "../route-utils.mjs";

function makeConfig(port, provider) {
  return {
    gateway: { host: "127.0.0.1", port, sharedToken: null },
    providers: provider ? {
      p1: {
        id: "p1",
        name: "stub",
        authHeader: "authorization",
        authScheme: "Bearer",
        baseUrls: [{ id: "b1", url: provider.baseUrl, note: "stub" }],
        keys: [{ id: "k1", token: "sk-stub", note: "stub" }],
        models: [{ id: "m1", model: provider.model, name: "stub" }],
      },
    } : {},
    modelFamilies: {
      opus: provider
        ? { providerId: "p1", baseUrlId: "b1", keyId: "k1", modelId: "m1" }
        : { providerId: null, baseUrlId: null, keyId: null, modelId: null },
      sonnet: { providerId: null, baseUrlId: null, keyId: null, modelId: null },
      "sonnet[1m]": { providerId: null, baseUrlId: null, keyId: null, modelId: null },
      haiku: { providerId: null, baseUrlId: null, keyId: null, modelId: null },
    },
  };
}

async function startStubUpstream(port, status) {
  const server = createServer((req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "auth", message: "x" } }));
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((r) => server.close(r)),
  };
}

test("upstream 401 -> footer 记录 api-error", async (t) => {
  const upstream = await startStubUpstream(18700, 401);
  t.after(() => upstream.stop());

  const config = makeConfig(18701, { baseUrl: upstream.url, model: "stub-model" });
  const metrics = {};
  const runtime = createGatewayRuntime({
    config,
    requestHandler: createGatewayRequestHandler(config, metrics),
  });
  await runtime.start();
  t.after(() => runtime.close());

  // 触发一次代理请求
  const res = await fetch("http://127.0.0.1:18701/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "opus", messages: [] }),
  });
  assert.equal(res.status, 401, "upstream 401 should pass through");

  const last = getLastUpstreamError(60_000);
  assert.ok(last, "footer 应当记录到 api-error");
  assert.equal(last.kind, "api-error");
  assert.equal(last.status, 401);
  assert.equal(last.family, "opus");
  assert.equal(last.providerId, "p1");
});

test("upstream 503 -> footer 记录 upstream-5xx", async (t) => {
  const upstream = await startStubUpstream(18710, 503);
  t.after(() => upstream.stop());

  const config = makeConfig(18711, { baseUrl: upstream.url, model: "stub-model" });
  const metrics = {};
  const runtime = createGatewayRuntime({
    config,
    requestHandler: createGatewayRequestHandler(config, metrics),
  });
  await runtime.start();
  t.after(() => runtime.close());

  const res = await fetch("http://127.0.0.1:18711/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "opus", messages: [] }),
  });
  assert.equal(res.status, 503);

  const last = getLastUpstreamError(60_000);
  assert.ok(last, "footer 应当记录到 upstream-5xx");
  assert.equal(last.kind, "upstream-5xx");
  assert.equal(last.status, 503);
});

// V5.2 §5.2 / §5.3 / §6.2: 完整 E2E 终态 429 pass-through
// - upstream 永远返回 429 + Retry-After: 0.01
// - gateway E2E 走完整 10 次 rate-limit 预算
// - 必须返回 status=429（不是 500）
// - body 仍可读
// - footer 记录保持 rate-limited（不被 api-error 覆盖）
async function startStubRateLimited(port) {
  const { createServer } = await import("node:http");
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "0.01",
    });
    res.end(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }));
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((r) => server.close(r)),
    getCount: () => count,
  };
}

test("V5.2 E2E 终态 429: status=429, body 可读, rate-limited 不被覆盖", async (t) => {
  const upstream = await startStubRateLimited(18720);
  t.after(() => upstream.stop());

  const config = makeConfig(18721, { baseUrl: upstream.url, model: "stub-model" });
  const metrics = {};
  const runtime = createGatewayRuntime({
    config,
    requestHandler: createGatewayRequestHandler(config, metrics),
  });
  await runtime.start();
  t.after(() => runtime.close());

  // 走完整链路
  const res = await fetch("http://127.0.0.1:18721/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "opus", messages: [] }),
  });
  // 1) 状态必须是 429，不能是 500
  assert.equal(res.status, 429, `gateway must return 429 (not 500), got ${res.status}`);

  // 2) body 必须可读
  const body = await res.json();
  assert.equal(body.error.type, "rate_limit_error", `upstream body must pass through, got: ${JSON.stringify(body)}`);

  // 3) upstream 被命中 2 次（1 + 1 retry，V5.3 起 429 单候选只重试 1 次）
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(upstream.getCount(), 2, `expected 2 hits (1 + 1 retry), got ${upstream.getCount()}`);

  // 4) footer 必须是 rate-limited，不能被 api-error 覆盖
  const last = getLastUpstreamError(60_000);
  assert.ok(last, "footer 应当记录到 rate-limited");
  assert.equal(last.kind, "rate-limited", `kind must be 'rate-limited', got '${last.kind}'`);
  assert.equal(last.status, 429);
  assert.equal(last.family, "opus");
  assert.equal(last.providerId, "p1");
});
