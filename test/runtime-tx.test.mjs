// V5.1 §5.6: 端口切换事务（prepare / commit / rollback / 并发锁）
// node:test 形式
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGatewayRuntime } from "../gateway-runtime.mjs";

function makeConfig(port) {
  return { gateway: { host: "127.0.0.1", port } };
}

async function tryRequest(port) {
  return fetch(`http://127.0.0.1:${port}/health`)
    .then((r) => r.status)
    .catch((e) => `ERR ${e.code || e.message}`);
}

test("prepare 后新旧端口都可用，commit 后旧端口关闭", async (t) => {
  const runtime = createGatewayRuntime({
    config: makeConfig(18300),
    requestHandler: async (req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    },
  });
  await runtime.start();
  t.after(() => runtime.close());

  const tx = await runtime.preparePortSwitch(18301);
  assert.equal(tx.noop, false);

  const before = await Promise.all([tryRequest(18300), tryRequest(18301)]);
  assert.deepEqual(before, [200, 200], "before commit: both ports must serve");

  const result = await tx.commit();
  assert.equal(result.changed, true);
  assert.equal(runtime.getPort(), 18301);

  const after = await Promise.all([tryRequest(18300), tryRequest(18301)]);
  assert.notEqual(after[0], 200, "old 18300 should be closed after commit");
  assert.equal(after[1], 200, "new 18301 should serve after commit");
});

test("rollback: candidate 关闭，旧端口继续服务", async (t) => {
  const runtime = createGatewayRuntime({
    config: makeConfig(18400),
    requestHandler: async (req, res) => {
      res.writeHead(200);
      res.end("ok");
    },
  });
  await runtime.start();
  t.after(() => runtime.close());

  const tx = await runtime.preparePortSwitch(18401);
  await tx.rollback();

  const after = await Promise.all([tryRequest(18400), tryRequest(18401)]);
  assert.equal(after[0], 200, "old 18400 should still serve after rollback");
  assert.notEqual(after[1], 200, "candidate 18401 should NOT serve after rollback");
  assert.equal(runtime.getPort(), 18400, "getPort should remain old after rollback");
});

test("noop: 同端口 prepare 不创建 candidate", async (t) => {
  const runtime = createGatewayRuntime({
    config: makeConfig(18500),
    requestHandler: async (req, res) => { res.writeHead(200); res.end("ok"); },
  });
  await runtime.start();
  t.after(() => runtime.close());

  const tx = await runtime.preparePortSwitch(18500);
  assert.equal(tx.noop, true);
  const result = await tx.commit();
  assert.equal(result.changed, false);
});

test("并发锁: prepare 未 commit 时第二次 prepare 被拒", async (t) => {
  const runtime = createGatewayRuntime({
    config: makeConfig(18600),
    requestHandler: async (req, res) => { res.writeHead(200); res.end("ok"); },
  });
  await runtime.start();
  t.after(() => runtime.close());

  const tx = await runtime.preparePortSwitch(18601);
  assert.equal(runtime.isSwitchInFlight(), true);
  await assert.rejects(
    () => runtime.preparePortSwitch(18602),
    /already in progress/,
  );
  await tx.commit();
  assert.equal(runtime.isSwitchInFlight(), false);
});

// V5.2 §5.1 / §6.1：真正并发（不 await 第一个）的 prepare 竞争。
// 锁必须在第一个 await 之前占住，第二个 promise 必须稳定失败。
test("并发锁 V5.2: 真正并发的两个 prepare，恰好 1 成功 1 失败", async (t) => {
  const runtime = createGatewayRuntime({
    config: makeConfig(19200),
    requestHandler: async (req, res) => { res.writeHead(200); res.end("ok"); },
  });
  await runtime.start();
  t.after(() => runtime.close());

  // 不 await 第一个，直接发第二个，再统一 await
  const p1 = runtime.preparePortSwitch(19201);
  const p2 = runtime.preparePortSwitch(19202);
  const settled = await Promise.allSettled([p1, p2]);

  const fulfilled = settled.filter((s) => s.status === "fulfilled");
  const rejected = settled.filter((s) => s.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one prepare should succeed");
  assert.equal(rejected.length, 1, "exactly one prepare should be rejected");

  // 失败原因必须匹配 'already in progress'
  const rejectedReason = String(rejected[0].reason?.message ?? rejected[0].reason);
  assert.match(rejectedReason, /already in progress/, `rejection must mention 'already in progress', got: ${rejectedReason}`);

  // 事务进行中，isSwitchInFlight 应为 true
  assert.equal(runtime.isSwitchInFlight(), true, "lock must be held during in-flight tx");

  // 提交成功的那个事务，事务结束后锁应释放
  const winnerTx = fulfilled[0].value;
  if (winnerTx.noop) {
    await winnerTx.commit();
  } else {
    await winnerTx.commit();
  }
  assert.equal(runtime.isSwitchInFlight(), false, "lock must be released after commit");
});
