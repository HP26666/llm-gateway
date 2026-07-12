// debug-log 测试：
// 1. isProblemLog 前缀识别
// 2. writeDebugLog 写入文件
// 3. 静默失败（不抛错）
// 4. 集成：failover 触发后 debug 文件出现 [failover] 行
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isProblemLog, writeDebugLog, __resetForTest } from "../debug-log.mjs";
import { logRaw } from "../route-utils.mjs";
import { createGatewayRequestHandler } from "../server.mjs";
import { _resetBreakersForTest } from "../circuit-breaker.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "..", "data");

function pad2(n) {
  return String(n).padStart(2, "0");
}
function dayKey(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}
function debugFilePath() {
  return path.join(DATA_DIR, `debug-${dayKey()}.log`);
}

// ===== isProblemLog 前缀识别 =====

test("isProblemLog: [error]/[warn]/[failover]/[info][breaker] 识别为问题级", () => {
  assert.equal(isProblemLog("[error][gateway-error] something broke"), true);
  assert.equal(isProblemLog("[error][stream-error] connection lost"), true);
  assert.equal(isProblemLog("[warn][retry] TTFB timeout 30000ms"), true);
  assert.equal(isProblemLog("[warn][retry] connection error (ECONNREFUSED)"), true);
  assert.equal(isProblemLog("[failover] 2026-07-10T09:40:28Z family=opus glm -> (next)"), true);
  assert.equal(isProblemLog("[info][breaker] probe ok glm:glm-5.1, HALF_OPEN→CLOSED"), true);
});

test("isProblemLog: 正常日志不识别为问题级", () => {
  assert.equal(isProblemLog("[config-change] 2026-07-10 family=opus ..."), false);
  assert.equal(isProblemLog("[2026-07-10T09:40:28Z] /v1/messages claude-opus [opus] -> glm:glm-5.1 (200)"), false);
  assert.equal(isProblemLog("Claude gateway listening on http://127.0.0.1:8000"), false);
  assert.equal(isProblemLog(""), false);
  assert.equal(isProblemLog(null), false);
});

// ===== writeDebugLog 写入文件 =====

test("writeDebugLog: 追加写入当天的 debug 文件", async (t) => {
  __resetForTest();
  const filePath = debugFilePath();

  // 清理可能的残留（测试隔离）
  t.after(async () => {
    try { await unlink(filePath); } catch { /* ignore */ }
  });

  const marker = `[warn][retry] test-marker-${Date.now()}`;
  await writeDebugLog(marker);

  // 验证文件存在且包含该行
  const content = await readFile(filePath, "utf8");
  assert.ok(content.includes(marker), "debug 文件应包含写入的日志行");
  assert.ok(content.includes("[warn]"), "应保留原始前缀");
});

test("writeDebugLog: 失败静默不抛错", async () => {
  __resetForTest();
  // 直接调用多次，不应抛出任何异常
  await writeDebugLog("[error][test] this should not throw");
  // 即使重复调用也不报错
  await writeDebugLog("[error][test] second call");
});

// ===== 集成：failover 触发后 debug 文件出现记录 =====

async function startStub(responder) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    const r = responder(hits);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body ?? {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((r) => server.close(r)),
    getHits: () => hits,
  };
}

function buildConfig(family, specs) {
  const providers = {};
  const candidates = [];
  for (const spec of specs) {
    const pid = spec.id;
    providers[pid] = {
      id: pid, name: pid, authHeader: "Authorization", authScheme: "Bearer",
      baseUrls: [{ id: `b_${pid}`, url: spec.url, note: "stub" }],
      keys: [{ id: `k_${pid}`, token: "stub-token", note: "stub", createdAt: "1970-01-01T00:00:00.000Z" }],
      models: [{ id: `m_${pid}`, model: `model_${pid}`, name: `model_${pid}` }],
    };
    candidates.push({ providerId: pid, baseUrlId: `b_${pid}`, keyId: `k_${pid}`, modelId: `m_${pid}` });
  }
  const empty = { candidates: [], strategy: "failover", circuitBreaker: null };
  const modelFamilies = { opus: empty, sonnet: { ...empty }, "sonnet[1m]": { ...empty }, haiku: { ...empty } };
  modelFamilies[family] = { candidates, strategy: "failover", circuitBreaker: null };
  return {
    gateway: { host: "127.0.0.1", port: 0, sharedToken: null },
    circuitBreaker: null, providers, modelFamilies, history: [],
  };
}

test("集成：failover 触发后 debug 文件出现 [failover] 行", async (t) => {
  __resetForTest();
  _resetBreakersForTest();

  const primary = await startStub(() => ({ status: 500, body: {} }));
  const backup = await startStub(() => ({ status: 200, body: { ok: true } }));
  t.after(async () => { await primary.stop(); await backup.stop(); });

  const config = buildConfig("opus", [
    { id: "p1", url: primary.url },
    { id: "p2", url: backup.url },
  ]);
  const handler = createGatewayRequestHandler(config, {});
  const gw = createServer((req, res) => handler(req, res));
  await new Promise((r) => gw.listen(0, "127.0.0.1", r));
  const gwUrl = `http://127.0.0.1:${gw.address().port}`;
  t.after(() => new Promise((r) => gw.close(r)));

  const filePath = debugFilePath();
  t.after(async () => {
    try { await unlink(filePath); } catch { /* ignore */ }
  });

  // 触发一次 failover（主 500 → 切副 200）
  const res = await fetch(`${gwUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "opus", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);

  // 等待异步写入落盘（writeDebugLog 是 fire-and-forget，需要给 I/O 一点时间）
  await new Promise((r) => setTimeout(r, 200));

  const content = await readFile(filePath, "utf8");
  assert.ok(content.includes("[failover]"), "debug 文件应记录 failover 切换");
});
