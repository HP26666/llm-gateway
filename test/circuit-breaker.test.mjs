// circuit-breaker 三态机 + 候选排序单测。纯逻辑，零网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  breakerKey,
  getBreakerState,
  breakerAllow,
  recordBreakerFailure,
  recordBreakerSuccess,
  orderCandidates,
  getBreakerSnapshot,
  _resetBreakersForTest,
} from "../circuit-breaker.mjs";

const PK = { failureThreshold: 3, coolDownMs: 60_000, successThreshold: 1 };
const KEY = "p|b|k|m";

test("breakerKey 兼容 binding 与 route 两种形态", () => {
  _resetBreakersForTest();
  const fromBinding = breakerKey({ providerId: "p", baseUrlId: "b", keyId: "k", modelId: "m" });
  const fromRoute = breakerKey({
    providerId: "p",
    baseUrlId: "b",
    baseUrl: { id: "b" },
    key: { id: "k" },
    model: { id: "m" },
  });
  assert.equal(fromBinding, "p|b|k|m");
  assert.equal(fromBinding, fromRoute);
});

test("CLOSED 累计失败达阈值跳 OPEN", () => {
  _resetBreakersForTest();
  assert.equal(getBreakerState(KEY, PK), "CLOSED");
  recordBreakerFailure(KEY, PK);
  recordBreakerFailure(KEY, PK);
  assert.equal(getBreakerState(KEY, PK), "CLOSED");
  recordBreakerFailure(KEY, PK); // 第 3 次 → OPEN
  assert.equal(getBreakerState(KEY, PK), "OPEN");
  assert.equal(breakerAllow(KEY, PK), false);
});

test("OPEN 冷却到期惰性转 HALF_OPEN，breakerAllow 恢复 true", async () => {
  _resetBreakersForTest();
  const fast = { failureThreshold: 1, coolDownMs: 50, successThreshold: 1 };
  recordBreakerFailure(KEY, fast); // 阈值 1 → OPEN
  assert.equal(getBreakerState(KEY, fast), "OPEN");
  assert.equal(breakerAllow(KEY, fast), false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(getBreakerState(KEY, fast), "HALF_OPEN");
  assert.equal(breakerAllow(KEY, fast), true);
});

test("HALF_OPEN 成功回 CLOSED 并重置计数", async () => {
  _resetBreakersForTest();
  const fast = { failureThreshold: 1, coolDownMs: 50, successThreshold: 1 };
  recordBreakerFailure(KEY, fast);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(getBreakerState(KEY, fast), "HALF_OPEN");
  recordBreakerSuccess(KEY, fast);
  assert.equal(getBreakerState(KEY, fast), "CLOSED");
  // 计数重置：需重新累计 1 次才再次 OPEN
  recordBreakerFailure(KEY, fast);
  assert.equal(getBreakerState(KEY, fast), "OPEN");
});

test("HALF_OPEN 失败回 OPEN 并刷新 openedAt", async () => {
  _resetBreakersForTest();
  const fast = { failureThreshold: 1, coolDownMs: 50, successThreshold: 1 };
  recordBreakerFailure(KEY, fast);
  const firstOpened = getBreakerSnapshot(KEY, fast).openedAt;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(getBreakerState(KEY, fast), "HALF_OPEN");
  recordBreakerFailure(KEY, fast); // 探活失败 → 回 OPEN
  assert.equal(getBreakerState(KEY, fast), "OPEN");
  const secondOpened = getBreakerSnapshot(KEY, fast).openedAt;
  assert.ok(secondOpened >= firstOpened, "HALF_OPEN 失败应刷新 openedAt");
});

test("CLOSED 阶段成功重置失败计数（未达阈值不跳 OPEN）", () => {
  _resetBreakersForTest();
  recordBreakerFailure(KEY, PK);
  recordBreakerFailure(KEY, PK); // 2 < 3
  recordBreakerSuccess(KEY, PK); // 重置
  recordBreakerFailure(KEY, PK);
  recordBreakerFailure(KEY, PK); // 又 2 < 3
  assert.equal(getBreakerState(KEY, PK), "CLOSED");
});

test("orderCandidates: failover 保持顺序，OPEN 候选被排除", () => {
  _resetBreakersForTest();
  const A = { providerId: "pa", baseUrlId: "ba", keyId: "ka", modelId: "ma" };
  const B = { providerId: "pb", baseUrlId: "bb", keyId: "kb", modelId: "mb" };
  const P = { failureThreshold: 1, coolDownMs: 60_000 };
  recordBreakerFailure(breakerKey(A), P); // A 熔断
  const ordered = orderCandidates([A, B], "failover", "fam", P);
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0], B); // A 被排除，只剩 B
});

test("orderCandidates: 全部 OPEN 时强制最早者转 HALF_OPEN 纳入序列", async () => {
  _resetBreakersForTest();
  const A = { providerId: "pa", baseUrlId: "ba", keyId: "ka", modelId: "ma" };
  const B = { providerId: "pb", baseUrlId: "bb", keyId: "kb", modelId: "mb" };
  const P = { failureThreshold: 1, coolDownMs: 60_000 };
  recordBreakerFailure(breakerKey(A), P);
  await new Promise((r) => setTimeout(r, 20));
  recordBreakerFailure(breakerKey(B), P); // B 较晚 OPEN
  const ordered = orderCandidates([A, B], "failover", "fam", P);
  assert.equal(ordered.length, 1, "全 OPEN 时应只放最早一个试探");
  assert.equal(ordered[0], A, "应选 openedAt 最早的 A");
  assert.equal(getBreakerState(breakerKey(A), P), "HALF_OPEN");
});

test("orderCandidates: round_robin 在候选间轮转", () => {
  _resetBreakersForTest();
  const A = { providerId: "pa", baseUrlId: "ba", keyId: "ka", modelId: "ma" };
  const B = { providerId: "pb", baseUrlId: "bb", keyId: "kb", modelId: "mb" };
  const C = { providerId: "pc", baseUrlId: "bc", keyId: "kc", modelId: "mc" };
  const list = [A, B, C];
  const o1 = orderCandidates(list, "round_robin", "fam1", PK);
  const o2 = orderCandidates(list, "round_robin", "fam1", PK);
  const o3 = orderCandidates(list, "round_robin", "fam1", PK);
  assert.equal(o1[0], A);
  assert.equal(o2[0], B);
  assert.equal(o3[0], C);
});

test("per-key 隔离：不同候选互不影响", () => {
  _resetBreakersForTest();
  const KEY2 = "p2|b2|k2|m2";
  recordBreakerFailure(KEY, PK);
  recordBreakerFailure(KEY, PK);
  recordBreakerFailure(KEY, PK); // KEY → OPEN
  assert.equal(getBreakerState(KEY, PK), "OPEN");
  assert.equal(getBreakerState(KEY2, PK), "CLOSED"); // KEY2 不受影响
});
