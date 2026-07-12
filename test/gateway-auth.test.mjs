// 网关级 sharedToken 鉴权测试（checkGatewayAuth，server.mjs）。
//
// 此前只有 adminToken（admin 侧）被测过；sharedToken 这层网关入口鉴权完全空白。
// 覆盖：
//   - sharedToken=null：无 Authorization 头可访问（向后兼容，默认行为）
//   - sharedToken 已设：缺/错/格式不对的 Authorization → 401；正确 Bearer → 放行
//   - 鉴权应用于 /v1/messages 和 /v1/responses，但不影响 /health（健康检查无需鉴权）
//   - admin 路由有独立的 adminToken 鉴权，sharedToken 不干扰 admin
//
// 通过真实 HTTP 端到端验证（间接测 checkGatewayAuth 的行为契约）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGatewayRequestHandler } from "../server.mjs";

// 起一个 stub 上游，只回 200 + 假 Anthropic 响应，验证请求能否穿透鉴权层。
async function startStubUpstream() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_stub",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "stub-model",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((r) => server.close(r)),
  };
}

async function startGateway(config, metrics = {}) {
  const handler = createGatewayRequestHandler(config, metrics);
  const server = createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(r)) };
}

function buildConfigWithSharedToken(sharedToken, upstreamUrl) {
  const pid = "stub";
  return {
    gateway: { host: "127.0.0.1", port: 0, sharedToken, adminToken: null },
    circuitBreaker: null,
    providers: {
      [pid]: {
        id: pid,
        name: pid,
        authHeader: "Authorization",
        authScheme: "Bearer",
        baseUrls: [{ id: `b_${pid}`, url: upstreamUrl, note: "stub" }],
        keys: [{ id: `k_${pid}`, token: "upstream-key", note: "stub", createdAt: "1970-01-01T00:00:00.000Z" }],
        models: [{ id: `m_${pid}`, model: "stub-model", name: "Stub" }],
      },
    },
    modelFamilies: {
      opus: { candidates: [{ providerId: pid, baseUrlId: `b_${pid}`, keyId: `k_${pid}`, modelId: `m_${pid}` }], strategy: "failover", circuitBreaker: null },
      sonnet: { candidates: [], strategy: "failover", circuitBreaker: null },
      "sonnet[1m]": { candidates: [], strategy: "failover", circuitBreaker: null },
      haiku: { candidates: [], strategy: "failover", circuitBreaker: null },
    },
    history: [],
  };
}

async function withServers(sharedToken, fn) {
  const upstream = await startStubUpstream();
  const config = buildConfigWithSharedToken(sharedToken, upstream.url);
  const gateway = await startGateway(config);
  try {
    await fn(gateway.url);
  } finally {
    await gateway.stop();
    await upstream.stop();
  }
}

test("sharedToken=null：无 Authorization 头可访问 /v1/messages（向后兼容）", async () => {
  await withServers(null, async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "opus", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
  });
});

test("sharedToken 已设：缺 Authorization → 401", async () => {
  await withServers("my-gateway-secret", async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "opus", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error.message, /token/i);
  });
});

test("sharedToken 已设：错误 token → 401", async () => {
  await withServers("my-gateway-secret", async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: JSON.stringify({ model: "opus", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 401);
  });
});

test("sharedToken 已设：token 格式不对（非 Bearer 前缀）→ 401", async () => {
  await withServers("my-gateway-secret", async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "my-gateway-secret" },
      body: JSON.stringify({ model: "opus", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 401, "缺少 'Bearer ' 前缀应被拒");
  });
});

test("sharedToken 已设：正确 Bearer token → 放行 200", async () => {
  await withServers("my-gateway-secret", async (base) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer my-gateway-secret" },
      body: JSON.stringify({ model: "opus", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
  });
});

test("sharedToken 鉴权同样作用于 /v1/responses", async () => {
  await withServers("my-gateway-secret", async (base) => {
    // 缺 token
    const blocked = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "opus", input: "hi" }),
    });
    assert.equal(blocked.status, 401);

    // 正确 token（opus family 已配上游）
    const ok = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer my-gateway-secret" },
      body: JSON.stringify({ model: "opus", input: "hi" }),
    });
    assert.equal(ok.status, 200);
  });
});

test("sharedToken 鉴权不应用于 /health（健康检查无需鉴权）", async () => {
  await withServers("my-gateway-secret", async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
  });
});

test("sharedToken 鉴权不干扰 admin 路由（admin 有独立 adminToken）", async () => {
  // 设 sharedToken 但 adminToken=null：admin/config 应仍可访问（回环 + 无 adminToken）
  await withServers("my-gateway-secret", async (base) => {
    const res = await fetch(`${base}/admin/config`);
    assert.equal(res.status, 200, "admin 不受 sharedToken 约束");
  });
});

test("count_tokens 端点同样受 sharedToken 保护", async () => {
  await withServers("my-gateway-secret", async (base) => {
    const blocked = await fetch(`${base}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "opus", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(blocked.status, 401);
  });
});
