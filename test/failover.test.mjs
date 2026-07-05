// failover + 熔断集成测试：多候选切换、全失败透传、熔断跳过。
// stub 上游用随机端口（listen 0）避免并发冲突；500/401 不触发 fetchWithRetry 重试，保持测试快速。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGatewayRequestHandler } from "../server.mjs";
import { _resetBreakersForTest } from "../circuit-breaker.mjs";

async function startStub(responder) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    const r = responder(hits);
    res.writeHead(r.status, { "content-type": "application/json", ...(r.headers || {}) });
    res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((r) => server.close(r)),
    getHits: () => hits,
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
      id: pid,
      name: pid,
      authHeader: "Authorization",
      authScheme: "Bearer",
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
    circuitBreaker: null,
    providers,
    modelFamilies,
    history: [],
  };
}

async function postMessages(gatewayUrl, model = "opus") {
  return fetch(`${gatewayUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
}

test("主候选 500 自动 failover 到备候选返回 200", async (t) => {
  _resetBreakersForTest();
  const primary = await startStub(() => ({ status: 500, body: { err: "primary" } }));
  const backup = await startStub(() => ({ status: 200, body: { ok: true } }));
  t.after(async () => { await primary.stop(); await backup.stop(); });

  const config = buildConfig("opus", [{ id: "p1", url: primary.url }, { id: "p2", url: backup.url }]);
  const gw = await startGateway(config);
  t.after(() => gw.stop());

  const res = await postMessages(gw.url);
  assert.equal(res.status, 200, `expected 200 after failover, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(primary.getHits(), 1, "主候选应被打 1 次（500 不重试）");
  assert.equal(backup.getHits(), 1, "备候选应被打 1 次");
});

test("主候选 401（鉴权失效）触发 failover 到备候选", async (t) => {
  _resetBreakersForTest();
  const primary = await startStub(() => ({ status: 401, body: { err: "auth" } }));
  const backup = await startStub(() => ({ status: 200, body: { ok: true } }));
  t.after(async () => { await primary.stop(); await backup.stop(); });

  const config = buildConfig("opus", [{ id: "p1", url: primary.url }, { id: "p2", url: backup.url }]);
  const gw = await startGateway(config);
  t.after(() => gw.stop());

  const res = await postMessages(gw.url);
  assert.equal(res.status, 200);
  assert.equal(primary.getHits(), 1);
  assert.equal(backup.getHits(), 1);
});

test("全候选失败时透传最后一个候选的真实状态码（非网关 500）", async (t) => {
  _resetBreakersForTest();
  const primary = await startStub(() => ({ status: 500, body: { who: "primary" } }));
  const backup = await startStub(() => ({ status: 500, body: { who: "backup" } }));
  t.after(async () => { await primary.stop(); await backup.stop(); });

  const config = buildConfig("opus", [{ id: "p1", url: primary.url }, { id: "p2", url: backup.url }]);
  const gw = await startGateway(config);
  t.after(() => gw.stop());

  const res = await postMessages(gw.url);
  assert.equal(res.status, 500, "应透传最后一个候选的 500");
  const body = await res.json();
  assert.equal(body.who, "backup", "应透传最后一个候选(backup)的响应体");
  assert.ok(primary.getHits() >= 1 && backup.getHits() >= 1, "两个候选都应被试过");
});

test("连续失败达阈值后熔断 OPEN，后续请求跳过该候选", async (t) => {
  _resetBreakersForTest();
  const primary = await startStub(() => ({ status: 401, body: { err: "auth" } }));
  const backup = await startStub(() => ({ status: 200, body: { ok: true } }));
  t.after(async () => { await primary.stop(); await backup.stop(); });

  // failureThreshold=2：两次失败即熔断 primary
  const config = buildConfig(
    "opus",
    [{ id: "p1", url: primary.url }, { id: "p2", url: backup.url }],
    { failureThreshold: 2, coolDownMs: 60_000 },
  );
  const gw = await startGateway(config);
  t.after(() => gw.stop());

  await postMessages(gw.url); // req1: p1 401 (fail#1) -> p2 200
  await postMessages(gw.url); // req2: p1 401 (fail#2 -> OPEN) -> p2 200
  assert.equal(primary.getHits(), 2, "前两次请求都应打 primary");

  await postMessages(gw.url); // req3: p1 OPEN 跳过 -> 直接 p2 200
  assert.equal(primary.getHits(), 2, "熔断后 primary 不应再被打");
  assert.equal(backup.getHits(), 3, "三次请求 backup 都兜底");
});

test("请求格式类 4xx（404）不触发 failover，直接返回", async (t) => {
  _resetBreakersForTest();
  const primary = await startStub(() => ({ status: 404, body: { err: "not found" } }));
  const backup = await startStub(() => ({ status: 200, body: { ok: true } }));
  t.after(async () => { await primary.stop(); await backup.stop(); });

  const config = buildConfig("opus", [{ id: "p1", url: primary.url }, { id: "p2", url: backup.url }]);
  const gw = await startGateway(config);
  t.after(() => gw.stop());

  const res = await postMessages(gw.url);
  assert.equal(res.status, 404, "404 不应 failover，原样返回");
  assert.equal(primary.getHits(), 1, "只打 primary");
  assert.equal(backup.getHits(), 0, "404 不触发 failover，backup 不应被打");
});
