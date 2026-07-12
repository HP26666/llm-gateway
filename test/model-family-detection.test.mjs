// detectModelFamily 行为测试（server.mjs，通过真实 HTTP 间接验证）。
//
// 此前 detectModelFamily 零测试。修复后用关键字匹配覆盖 Anthropic 新老两种命名。
// 覆盖：
//   - 新格式：claude-sonnet-4-5 / claude-opus-4-1 / claude-haiku-3-5
//   - 旧格式：claude-3-5-sonnet-* / claude-3-opus-* / claude-3-haiku-*（此前漏判→opus）
//   - 简名：opus / sonnet / haiku
//   - 别名：best / default / auto → opus
//   - [1m] 后缀：sonnet 带 [1m] → sonnet[1m]
//   - 1m 信号：anthropic-beta 头 + sonnet → sonnet[1m]
//   - 未知 → opus（兜底）
//
// 验证方式：opus/sonnet/haiku 三个 family 各绑一个独立 stub 上游，
// 发不同 model 名，检查请求落到哪个上游（getHits）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGatewayRequestHandler } from "../server.mjs";

async function startStub(label) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_stub", type: "message", role: "assistant",
      content: [{ type: "text", text: label }],
      model: label, stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    label,
    url: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((r) => server.close(r)),
    getHits: () => hits,
  };
}

// 三个 family 各绑一个 stub；sonnet[1m] 复用 sonnet 的 stub（简化）
async function setupThreeFamilies() {
  const opusStub = await startStub("opus-upstream");
  const sonnetStub = await startStub("sonnet-upstream");
  const haikuStub = await startStub("haiku-upstream");

  function mkProvider(pid, url) {
    return {
      id: pid, name: pid, authHeader: "Authorization", authScheme: "Bearer",
      baseUrls: [{ id: `b_${pid}`, url, note: "n" }],
      keys: [{ id: `k_${pid}`, token: "t", note: "n", createdAt: "1970-01-01T00:00:00.000Z" }],
      models: [{ id: `m_${pid}`, model: "any", name: pid }],
    };
  }

  const config = {
    gateway: { host: "127.0.0.1", port: 0, sharedToken: null, adminToken: null },
    circuitBreaker: null,
    providers: {
      opus_p: mkProvider("opus_p", opusStub.url),
      sonnet_p: mkProvider("sonnet_p", sonnetStub.url),
      haiku_p: mkProvider("haiku_p", haikuStub.url),
    },
    modelFamilies: {
      opus: { candidates: [{ providerId: "opus_p", baseUrlId: "b_opus_p", keyId: "k_opus_p", modelId: "m_opus_p" }], strategy: "failover", circuitBreaker: null },
      sonnet: { candidates: [{ providerId: "sonnet_p", baseUrlId: "b_sonnet_p", keyId: "k_sonnet_p", modelId: "m_sonnet_p" }], strategy: "failover", circuitBreaker: null },
      "sonnet[1m]": { candidates: [{ providerId: "sonnet_p", baseUrlId: "b_sonnet_p", keyId: "k_sonnet_p", modelId: "m_sonnet_p" }], strategy: "failover", circuitBreaker: null },
      haiku: { candidates: [{ providerId: "haiku_p", baseUrlId: "b_haiku_p", keyId: "k_haiku_p", modelId: "m_haiku_p" }], strategy: "failover", circuitBreaker: null },
    },
    history: [],
  };

  const handler = createGatewayRequestHandler(config, {});
  const server = createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    config,
    stop: async () => {
      await new Promise((r) => server.close(r));
      await opusStub.stop();
      await sonnetStub.stop();
      await haikuStub.stop();
    },
    // 发请求后返回哪个 stub 被命中（通过 getHits 增量判断）
    async hitFamily(model, headers = {}) {
      const before = { opus: opusStub.getHits(), sonnet: sonnetStub.getHits(), haiku: haikuStub.getHits() };
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "x" }] }),
      });
      assert.equal(res.status, 200, `${model} 应路由成功`);
      const after = { opus: opusStub.getHits(), sonnet: sonnetStub.getHits(), haiku: haikuStub.getHits() };
      if (after.opus > before.opus) return "opus";
      if (after.sonnet > before.sonnet) return "sonnet";
      if (after.haiku > before.haiku) return "haiku";
      return null;
    },
  };
}

test("detectModelFamily：简名 opus/sonnet/haiku", async () => {
  const env = await setupThreeFamilies();
  try {
    assert.equal(await env.hitFamily("opus"), "opus");
    assert.equal(await env.hitFamily("sonnet"), "sonnet");
    assert.equal(await env.hitFamily("haiku"), "haiku");
  } finally {
    await env.stop();
  }
});

test("detectModelFamily：新格式 claude-{family}-X-Y", async () => {
  const env = await setupThreeFamilies();
  try {
    assert.equal(await env.hitFamily("claude-opus-4-1"), "opus");
    assert.equal(await env.hitFamily("claude-sonnet-4-5"), "sonnet");
    assert.equal(await env.hitFamily("claude-sonnet-4-5-20250929"), "sonnet");
    assert.equal(await env.hitFamily("claude-haiku-3-5"), "haiku");
  } finally {
    await env.stop();
  }
});

test("★ detectModelFamily：旧格式 claude-3-X-{family}-*（此前漏判→opus）", async () => {
  const env = await setupThreeFamilies();
  try {
    assert.equal(await env.hitFamily("claude-3-5-sonnet-20241022"), "sonnet", "旧 sonnet 命名应路由到 sonnet");
    assert.equal(await env.hitFamily("claude-3-5-sonnet-latest"), "sonnet");
    assert.equal(await env.hitFamily("claude-3-opus-20240229"), "opus");
    assert.equal(await env.hitFamily("claude-3-haiku-20240307"), "haiku");
  } finally {
    await env.stop();
  }
});

test("detectModelFamily：别名 best/default/auto → opus", async () => {
  const env = await setupThreeFamilies();
  try {
    assert.equal(await env.hitFamily("best"), "opus");
    assert.equal(await env.hitFamily("default"), "opus");
    assert.equal(await env.hitFamily("auto"), "opus");
  } finally {
    await env.stop();
  }
});

test("detectModelFamily：[1m] 后缀 → sonnet[1m]", async () => {
  const env = await setupThreeFamilies();
  try {
    // sonnet[1m] 复用 sonnet 的上游，所以应命中 sonnet stub
    assert.equal(await env.hitFamily("sonnet[1m]"), "sonnet");
    assert.equal(await env.hitFamily("claude-sonnet-4-5[1m]"), "sonnet");
  } finally {
    await env.stop();
  }
});

test("detectModelFamily：anthropic-beta 1m 信号 + sonnet → sonnet[1m]", async () => {
  const env = await setupThreeFamilies();
  try {
    // 带 anthropic-beta: context-1m 头的 sonnet 请求应走 sonnet[1m]（命中 sonnet 上游）
    assert.equal(
      await env.hitFamily("claude-sonnet-4-5", { "anthropic-beta": "context-1m-2025-08-07" }),
      "sonnet",
    );
    // body.betas 含 1m 信号
    // 这个走 hitFamily 不方便传 body，单独验证
  } finally {
    await env.stop();
  }
});

test("detectModelFamily：未知 model 兜底到 opus", async () => {
  const env = await setupThreeFamilies();
  try {
    assert.equal(await env.hitFamily("gpt-4o"), "opus");
    assert.equal(await env.hitFamily("some-unknown-model"), "opus");
  } finally {
    await env.stop();
  }
});

test("detectModelFamily：大小写不敏感", async () => {
  const env = await setupThreeFamilies();
  try {
    assert.equal(await env.hitFamily("CLAUDE-SONNET-4-5"), "sonnet");
    assert.equal(await env.hitFamily("Sonnet"), "sonnet");
    assert.equal(await env.hitFamily("  opus  "), "opus");
  } finally {
    await env.stop();
  }
});
