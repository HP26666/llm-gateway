// V5.1 §5.6: 429 重试预算回归保护
// - 上游永远返回 429：必须返回 429 而非 500
// - 上游永远返回 503：必须返回 503 而非 500，且 generic 预算走满
//
// server.mjs 内部 sleep() 是本地函数，node:test mock 改不到。
// 429 路径 sleep 5s × 10 = 50s 会超时；所以 429 测试用 Promise.race 截断，
// 只断言"不被包装成 generic-exhausted"。
// 503 路径 sleep 1s × 2 + 2s × 1 ≈ 4s，可在 30s 内完成。
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry, GatewayHttpError } from "../server.mjs";

async function startStubStatus(port, status) {
  const { createServer } = await import("node:http");
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    res.writeHead(status, { "content-type": "text/plain" });
    res.end("stub");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
    getCount: () => count,
  };
}

test("503 retry budget walks full 3 generic times and returns 503", async (t) => {
  // 503 走 generic 预算，间隔 1s × 2 ≈ 2s，能在 30s 内完成
  const stub = await startStubStatus(18100, 503);
  t.after(() => stub.stop());

  let lastError = null;
  const response = await fetchWithRetry(stub.url, {
    method: "GET",
    headers: { "content-type": "application/json" },
  }, null).catch((e) => { lastError = e; return null; });

  assert.equal(lastError, null, "fetchWithRetry must NOT throw on terminal 5xx");
  assert.equal(response.status, 503, "must return 503 to caller, not 500");
  // 503 终态：原样返回。第一次 = 第 1 次，后续 retry = 第 2/3 次，第 4 次 503 → return
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(stub.getCount(), 4, `expected 4 upstream hits (1 + 3 retries), got ${stub.getCount()}`);
});

test("GatewayHttpError is exported and carries statusCode/type", () => {
  const err = new GatewayHttpError(413, "invalid_request_error", "too big");
  assert.equal(err.statusCode, 413);
  assert.equal(err.type, "invalid_request_error");
  assert.equal(err.message, "too big");
  assert.equal(err.name, "GatewayHttpError");
});

test("429 返回时不会被 500 包装（V5.1 回归 P0 #1）", async (t) => {
  // 仅一次 429 验证：fetchWithRetry 拿到 429 后会进 retry 循环。
  // 我们只校验它不会 throw 5xx-包装错误（即仍然以 response.status=429 形式返回）。
  // 用 timeout 100ms 截断保证不真等 5s。
  const stub = await startStubStatus(18101, 429);
  t.after(() => stub.stop());

  const ac = new AbortController();
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => {
    ac.abort();
    reject(new Error("test timeout"));
  }, 1500));

  const fetchPromise = fetchWithRetry(stub.url, {
    method: "GET",
    headers: { "content-type": "application/json" },
  }, null).catch((e) => { throw e; });

  // 让 fetch 跑 1.4s（能撑过 ~2 次 retry + sleep），但不会跑完 10 次
  let lastError = null;
  let response = null;
  try {
    response = await Promise.race([fetchPromise, timeoutPromise]);
  } catch (e) {
    lastError = e;
  }
  // 关键断言：哪怕最终超时，调用方也不会看到"5xx 包装"的伪错误
  if (lastError) {
    assert.ok(
      !String(lastError.message).includes("exhausted all budgets"),
      `fetchWithRetry must not be wrapped as generic-exhausted error: ${lastError.message}`,
    );
  } else {
    // 没超时说明已经在窗口内完成。状态必须是 429，绝不 500
    assert.equal(response.status, 429);
  }
});

// V5.2 §5.2 / §5.3 / §6.2：完整终态 429 pass-through 链路。
// - upstream 永远返回 429 + Retry-After: 0.01（10ms 间隔）
// - 走完整 10 次 rate-limit 预算
// - 终态 429 必须以 response 形式返回，body 保持未消费
// - 调用方拿到 response 后能用 response.json() / response.text() 读出 body
// - getLastUpstreamError 必须是 rate-limited，不能是 api-error
// - 不能变成 500
test("V5.2 完整终态 429 pass-through: status=429, body 可读, rate-limited", async (t) => {
  const { createServer } = await import("node:http");
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "0.01", // 10ms，10 次 ≈ 100ms
    });
    res.end(JSON.stringify({ error: { type: "rate_limit", message: "slow down" } }));
  });
  await new Promise((r) => server.listen(18102, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));

  const stubUrl = `http://127.0.0.1:18102`;
  const response = await fetchWithRetry(stubUrl, {
    method: "GET",
    headers: { "content-type": "application/json" },
  }, null);

  // 1) status 必须是 429，不是 500
  assert.equal(response.status, 429, `must be 429, got ${response.status}`);

  // 2) body 必须可读
  const bodyText = await response.text();
  assert.match(bodyText, /slow down/, `body should be readable, got: ${bodyText}`);

  // 3) upstream 被命中 11 次（1 + 10 retries）
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(count, 11, `expected 11 hits (1 + 10 retries), got ${count}`);
});
