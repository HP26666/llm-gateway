// TTFB 超时分层 + HALF_OPEN 惰性探活集成测试。
// 慢 stub（延迟 writeHead）模拟 GLM 限额 hang：首字节迟迟不来，TTFB 超时识别后切副候选；
// body-aware stub 按 max_tokens 区分探活（=1）与真实请求，验证探活路径与并发去重。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGatewayRequestHandler, fetchWithRetry } from "../server.mjs";
import { _resetBreakersForTest } from "../circuit-breaker.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 同步快 stub：responder(hits) → {status, body, headers}
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
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(r)), getHits: () => hits };
}

// 慢 stub：延迟 ttfbDelayMs 才 writeHead，模拟 GLM 首 bytes hang。
// 客户端 abort（TTFB 超时）会触发 res close，此时取消 pending 写，避免向已关闭连接 writeHead 抛错。
async function startSlowStub(ttfbDelayMs, status = 200, body = { ok: true }) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    const timer = setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    }, ttfbDelayMs);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(r)), getHits: () => hits };
}

// body-aware stub：解析请求 body，按 max_tokens 区分探活（=1）/真实（>1）计数。
// responder(parsed) 可 async，返回 {status, body}。
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

test("TTFB 超时切副候选：primary hang → backup 200", async (t) => {
  _resetBreakersForTest();
  const primary = await startSlowStub(3000); // hang 3s，远超 ttfb 500ms
  const backup = await startStub(() => ({ status: 200, body: { ok: true } }));
  t.after(async () => { await primary.stop(); await backup.stop(); });

  const config = buildConfig("opus",
    [{ id: "p1", url: primary.url }, { id: "p2", url: backup.url }],
    { failureThreshold: 5, ttfbTimeoutMs: 500 });
  const gw = await startGateway(config);
  t.after(() => gw.stop());

  const t0 = Date.now();
  const res = await postMessages(gw.url);
  const elapsed = Date.now() - t0;

  assert.equal(res.status, 200, `expected 200 after TTFB failover, got ${res.status}`);
  assert.equal(primary.getHits(), 1, "TTFB 超时不重试，primary 只打 1 次");
  assert.equal(backup.getHits(), 1, "backup 兜底 1 次");
  assert.ok(elapsed < 2000, `应在 TTFB 超时后快速切副(<2s)，实际 ${elapsed}ms`);
});

test("TTFB 超时不重试：单候选 hang → 只打 1 次，返回 500", async (t) => {
  _resetBreakersForTest();
  const primary = await startSlowStub(3000);
  t.after(() => primary.stop());

  const config = buildConfig("opus",
    [{ id: "p1", url: primary.url }],
    { failureThreshold: 5, ttfbTimeoutMs: 500 });
  const gw = await startGateway(config);
  t.after(() => gw.stop());

  const res = await postMessages(gw.url);
  assert.equal(res.status, 500, "单候选全失败，网关返回 500");
  assert.equal(primary.getHits(), 1, "TTFB 超时不重试，只打 1 次（非 1+3 generic 重试）");
});

test("fetchWithRetry TTFB 超时抛 TtfbTimeoutError", async (t) => {
  _resetBreakersForTest();
  const slow = await startSlowStub(3000);
  t.after(() => slow.stop());

  await assert.rejects(
    fetchWithRetry(slow.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [] }),
    }, null, { ttfbTimeoutMs: 400 }),
    (err) => err.name === "TtfbTimeoutError",
    "应抛 TtfbTimeoutError",
  );
});

test("探活成功切回主：HALF_OPEN 探活 ok → CLOSED → 真实请求打主", async (t) => {
  _resetBreakersForTest();
  let primaryOk = false;
  const primary = await startBodyStub(() =>
    primaryOk ? { status: 200, body: { ok: true } } : { status: 401, body: { err: "auth" } },
  );
  const backup = await startStub(() => ({ status: 200, body: { ok: true } }));
  t.after(async () => { await primary.stop(); await backup.stop(); });

  const config = buildConfig("opus",
    [{ id: "p1", url: primary.url }, { id: "p2", url: backup.url }],
    { failureThreshold: 2, coolDownMs: 100, successThreshold: 1, ttfbTimeoutMs: 5000 });
  const gw = await startGateway(config);
  t.after(() => gw.stop());

  await postMessages(gw.url); // p1 401 fail1 → p2
  await postMessages(gw.url); // p1 401 fail2 → OPEN → p2
  await sleep(150); // 等过 coolDown → HALF_OPEN
  primaryOk = true; // primary 恢复

  await postMessages(gw.url); // HALF_OPEN → 探活 p1(200) → CLOSED → 真实请求 p1(200)

  assert.equal(primary.getProbeHits(), 1, "HALF_OPEN 时探活 1 次");
  assert.equal(backup.getHits(), 2, "恢复后 backup 不再兜底（req1/2 各 1，req3 走主）");
});

test("探活失败重新 OPEN：HALF_OPEN 探活 500 → 走副", async (t) => {
  _resetBreakersForTest();
  let mode = "auth"; // auth=401 | five=500
  const primary = await startBodyStub(() =>
    mode === "auth" ? { status: 401, body: { err: "auth" } } : { status: 500, body: { err: "500" } },
  );
  const backup = await startStub(() => ({ status: 200, body: { ok: true } }));
  t.after(async () => { await primary.stop(); await backup.stop(); });

  const config = buildConfig("opus",
    [{ id: "p1", url: primary.url }, { id: "p2", url: backup.url }],
    { failureThreshold: 2, coolDownMs: 100, ttfbTimeoutMs: 5000 });
  const gw = await startGateway(config);
  t.after(() => gw.stop());

  await postMessages(gw.url); // p1 401 fail1 → p2
  await postMessages(gw.url); // p1 401 fail2 → OPEN → p2
  await sleep(150); // HALF_OPEN
  mode = "five"; // 探活时 primary 返回 500

  await postMessages(gw.url); // HALF_OPEN → 探活 p1(500) → 失败 → 重新 OPEN → backup

  assert.equal(primary.getProbeHits(), 1, "探活 1 次（500）");
  assert.equal(backup.getHits(), 3, "req3 backup 兜底");
});

test("并发去重：3 请求撞同一 HALF_OPEN，只探活 1 次", async (t) => {
  _resetBreakersForTest();
  let mode = "fail"; // fail=401 | probe=慢200
  const primary = await startBodyStub(async (parsed) => {
    if (mode === "fail") return { status: 401, body: { err: "auth" } };
    if (parsed.max_tokens === 1) await sleep(200); // 探活慢，确保并发请求共享 in-flight Promise
    return { status: 200, body: { ok: true } };
  });
  const backup = await startStub(() => ({ status: 200, body: { ok: true } }));
  t.after(async () => { await primary.stop(); await backup.stop(); });

  const config = buildConfig("opus",
    [{ id: "p1", url: primary.url }, { id: "p2", url: backup.url }],
    { failureThreshold: 1, coolDownMs: 100, ttfbTimeoutMs: 5000 });
  const gw = await startGateway(config);
  t.after(() => gw.stop());

  await postMessages(gw.url); // p1 401 fail1（threshold=1 → OPEN）→ p2
  await sleep(150); // 过 coolDown → HALF_OPEN
  mode = "probe";

  // 3 个请求并发，都撞 HALF_OPEN primary：第一个发起探活，后两个复用 inflightProbes
  await Promise.all([postMessages(gw.url), postMessages(gw.url), postMessages(gw.url)]);

  assert.equal(primary.getProbeHits(), 1, "并发去重：3 请求共享 1 次探活");
});
