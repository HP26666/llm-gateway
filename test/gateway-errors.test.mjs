// V5.1 §5.6: gateway 本地输入错误状态码语义
// - 非法 JSON -> 400
// - body 超限 -> 413
// 这条用例走完整 handler 链路：起一个 gateway server，发坏请求，断言状态码。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGatewayRuntime } from "../gateway-runtime.mjs";
import { createGatewayRequestHandler } from "../server.mjs";

function makeConfig(port) {
  return {
    gateway: { host: "127.0.0.1", port, sharedToken: null },
    providers: {},
    modelFamilies: {
      opus: { providerId: null, baseUrlId: null, keyId: null, modelId: null },
      sonnet: { providerId: null, baseUrlId: null, keyId: null, modelId: null },
      "sonnet[1m]": { providerId: null, baseUrlId: null, keyId: null, modelId: null },
      haiku: { providerId: null, baseUrlId: null, keyId: null, modelId: null },
    },
  };
}

async function startGateway(port) {
  const config = makeConfig(port);
  const metrics = {};
  const runtime = createGatewayRuntime({
    config,
    requestHandler: createGatewayRequestHandler(config, metrics),
  });
  await runtime.start();
  return { runtime, config };
}

test("invalid JSON body -> 400", async (t) => {
  const { runtime } = await startGateway(18200);
  t.after(() => runtime.close());
  const res = await fetch("http://127.0.0.1:18200/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json}",
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.type, "invalid_request_error");
});

test("body 超限 -> 413", async (t) => {
  const { runtime } = await startGateway(18201);
  t.after(() => runtime.close());
  // 50MB + 1B 超限
  const big = "x".repeat(50 * 1024 * 1024 + 1);
  const res = await fetch("http://127.0.0.1:18201/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: big,
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.error.type, "invalid_request_error");
});

test("model 缺失 -> 400 invalid_request_error", async (t) => {
  const { runtime } = await startGateway(18202);
  t.after(() => runtime.close());
  const res = await fetch("http://127.0.0.1:18202/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.type, "invalid_request_error");
  assert.match(body.error.message, /model/);
});

test("GET /health -> 200", async (t) => {
  const { runtime } = await startGateway(18203);
  t.after(() => runtime.close());
  const res = await fetch("http://127.0.0.1:18203/health");
  assert.equal(res.status, 200);
});
