// probe-fail 修复回归测试：当所有候选都因 HALF_OPEN 探活失败被跳过时，
// tryWithFailover 必须返回有意义的 failure，而非旧的 "no candidates and no error"。
// 场景：两个候选先各自累计失败进 OPEN → 冷却到期转 HALF_OPEN → 探活都失败
// → 全候选被 continue 跳过 → 应返回 500 + 明确错误消息。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createGatewayRequestHandler } from "../server.mjs";
import { _resetBreakersForTest } from "../circuit-breaker.mjs";

// body-aware stub：探活（max_tokens=1）和真实请求（max_tokens>1）分别响应。
async function startBodyStub(responder) {
  let probeHits = 0;
  let realHits = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let parsed = {};
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* ignore */ }
    if (parsed.max_tokens === 1) probeHits += 1; else realHits += 1;
    const r = await responder(parsed);
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((r) => server.close(r)),
    getProbeHits: () => probeHits,
    getRealHits: () => realHits,
  };
}

async function startGateway(config, metrics = {}) {
  const handler = createGatewayRequestHandler(config, metrics);
  const server = createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(r)) };
}

function buildConfig(family, specs, familyCB = null) {
  const providers = {};
  const candidates = [];
  for (const spec of specs) {
    const pid = spec.id;
    const model = spec.model || `model_${pid}`;
    providers[pid] = {
      id: pid, name: pid, authHeader: "Authorization", authScheme: "Bearer",
      baseUrls: [{ id: `b_${pid}`, url: spec.url, note: "stub" }],
      keys: [{ id: `k_${pid}`, token: "stub-token", note: "stub", createdAt: "1970-01-01T00:00:00.000Z" }],
      models: [{ id: `m_${pid}`, model, name: model }],
    };
    candidates.push({ providerId: pid, baseUrlId: `b_${pid}`, keyId: `k_${pid}`, modelId: `m_${pid}` });
  }
  const empty = { candidates: [], strategy: "failover", circuitBreaker: null };
  const modelFamilies = { opus: empty, sonnet: { ...empty }, "sonnet[1m]": { ...empty }, haiku: { ...empty } };
  modelFamilies[family] = { candidates, strategy: "failover", circuitBreaker: familyCB };
  return {
    gateway: { host: "127.0.0.1", port: 0, sharedToken: null },
    circuitBreaker: null, providers, modelFamilies, history: [],
  };
}

async function postMessages(gatewayUrl, model = "opus") {
  return fetch(`${gatewayUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
}

test("全候选 probe-fail：返回有意义的 500（非 'no candidates and no error'）", async (t) => {
  _resetBreakersForTest();

  // 两个 stub：真实请求返回 500（累计失败），探活也返回 500（HALF_OPEN 探活失败）。
  // failureThreshold=1 让第一个请求就 OPEN，coolDownMs 极短让下一个请求进入 HALF_OPEN。
  const p1 = await startBodyStub(() => ({ status: 500, body: { error: "down" } }));
  const p2 = await startBodyStub(() => ({ status: 500, body: { error: "down" } }));
  t.after(async () => { await p1.stop(); await p2.stop(); });

  const config = buildConfig("opus",
    [{ id: "p1", url: p1.url }, { id: "p2", url: p2.url }],
    { failureThreshold: 1, coolDownMs: 50, successThreshold: 1 });

  const gw = await startGateway(config);
  t.after(() => gw.stop());

  // 请求 1：两个候选各打 1 次 500 → 各累计 1 failure → OPEN
  const res1 = await postMessages(gw.url);
  assert.equal(res1.status, 500, "全候选 500，应返回 500");

  // 等 coolDown 到期（50ms），两个候选转 HALF_OPEN
  await new Promise((r) => setTimeout(r, 100));

  // 请求 2：两个候选都 HALF_OPEN → 探活都失败（500）→ continue 跳过
  // 这是旧 bug 触发点：lastError=null → "no candidates and no error"
  const res2 = await postMessages(gw.url);
  assert.equal(res2.status, 500, "全候选 probe-fail，应返回 500");
  const body2 = await res2.json();
  const msg = body2.error?.message || "";
  assert.ok(
    !msg.includes("no candidates and no error"),
    `不应再出现无意义错误 'no candidates and no error'，实际: ${msg}`,
  );
  assert.ok(msg.includes("probe failed"), `错误消息应含 'probe failed'，实际: ${msg}`);
});
