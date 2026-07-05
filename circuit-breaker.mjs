// circuit-breaker.mjs
// 上游候选熔断器：标准三态机（CLOSED → OPEN → HALF_OPEN → CLOSED）。
// 模块级 Map 单例，按候选四元组 key 索引，独立于 config——saveConfig 会
// Object.assign 重建 modelFamilies，熔断状态挂 config 会在热切换时丢失；
// 用四元组 key 可跨 family、跨热切换保留同一上游的熔断状态。
//
// 状态语义：
//   CLOSED     正常放行；失败累计达 failureThreshold → 跳 OPEN
//   OPEN       冷却期内拒绝（不参与候选排序）；冷却到期惰性转 HALF_OPEN
//   HALF_OPEN  放行一次探活；成功 successThreshold 次 → CLOSED；失败 → 回 OPEN（刷新 openedAt）
//
// 仅被动统计：无定时器、无主动探测请求。OPEN→HALF_OPEN 的转换靠下次
// getBreakerState / record* 调用时惰性判定（Date.now() - openedAt >= coolDownMs）。

export const CIRCUIT_BREAKER_DEFAULTS = Object.freeze({
  failureThreshold: 5,
  coolDownMs: 60_000,
  successThreshold: 1,
});

function mergeParams(params) {
  return {
    ...CIRCUIT_BREAKER_DEFAULTS,
    ...(params && typeof params === "object" ? params : {}),
  };
}

const registry = new Map(); // key → { status, failureCount, successCount, openedAt }
const rrCursors = new Map(); // familyKey → round_robin 游标

function ensureBreaker(key) {
  let b = registry.get(key);
  if (!b) {
    b = { status: "CLOSED", failureCount: 0, successCount: 0, openedAt: 0 };
    registry.set(key, b);
  }
  return b;
}

// 候选四元组 → 稳定 key。兼容 binding（直接四元组）与 route（baseUrl/key/model 嵌套）两种形态。
export function breakerKey(candidate) {
  if (!candidate || typeof candidate !== "object") return "null";
  const pid = candidate.providerId ?? "";
  const bid = candidate.baseUrlId ?? candidate.baseUrl?.id ?? "";
  const kid = candidate.keyId ?? candidate.key?.id ?? "";
  const mid = candidate.modelId ?? candidate.model?.id ?? "";
  return `${pid}|${bid}|${kid}|${mid}`;
}

// 读取状态，惰性执行 OPEN → HALF_OPEN 的冷却到期转换（有副作用：可能改写 b.status）。
export function getBreakerState(key, params = {}) {
  const p = mergeParams(params);
  const b = registry.get(key);
  if (!b) return "CLOSED";
  if (b.status === "OPEN" && Date.now() - b.openedAt >= p.coolDownMs) {
    b.status = "HALF_OPEN";
    b.successCount = 0;
  }
  return b.status;
}

export function breakerAllow(key, params = {}) {
  const state = getBreakerState(key, params);
  return state === "CLOSED" || state === "HALF_OPEN";
}

export function recordBreakerFailure(key, params = {}) {
  const p = mergeParams(params);
  const b = ensureBreaker(key);
  getBreakerState(key, p); // 惰性刷新：冷却到期则先转 HALF_OPEN 再判定

  if (b.status === "HALF_OPEN") {
    // 探活失败 → 回 OPEN，刷新 openedAt（重新计冷却窗口）
    b.status = "OPEN";
    b.openedAt = Date.now();
    return;
  }
  if (b.status === "CLOSED") {
    b.failureCount += 1;
    if (b.failureCount >= p.failureThreshold) {
      b.status = "OPEN";
      b.openedAt = Date.now();
    }
  }
  // 已 OPEN（未到期）：保持，不刷新 openedAt——到期必给一次探活机会。
}

export function recordBreakerSuccess(key, params = {}) {
  const p = mergeParams(params);
  const b = registry.get(key);
  if (!b) return; // 无失败记录，默认 CLOSED，无需处理
  getBreakerState(key, p);

  if (b.status === "HALF_OPEN") {
    b.successCount += 1;
    if (b.successCount >= p.successThreshold) {
      b.status = "CLOSED";
      b.failureCount = 0;
      b.successCount = 0;
      b.openedAt = 0;
    }
  } else if (b.status === "CLOSED") {
    b.failureCount = 0; // 连续失败计数重置
  }
}

function forceHalfOpen(key) {
  const b = ensureBreaker(key);
  b.status = "HALF_OPEN";
  b.successCount = 0;
}

// 排查 / 可视化快照（只读视角，含惰性刷新后的状态）。
export function getBreakerSnapshot(key, params = {}) {
  const p = mergeParams(params);
  const state = getBreakerState(key, p);
  const b = registry.get(key);
  if (!b) return { state: "CLOSED", failureCount: 0, successCount: 0, openedAt: 0 };
  return {
    state,
    failureCount: b.failureCount,
    successCount: b.successCount,
    openedAt: b.openedAt,
  };
}

function applyRoundRobin(routes, familyKey) {
  if (!Array.isArray(routes) || routes.length <= 1) return routes;
  const cursor = (rrCursors.get(familyKey) ?? 0) % routes.length;
  rrCursors.set(familyKey, cursor + 1);
  return routes.slice(cursor).concat(routes.slice(0, cursor));
}

// 按策略 + 熔断状态排出「本次应尝试的候选序列」。
//   - CLOSED / HALF_OPEN 参与；OPEN 跳过
//   - 全部 OPEN 时：取 openedAt 最早的强制转 HALF_OPEN 纳入序列（给恢复机会，否则完全不可用）
//   - strategy: "failover"（保持顺序，默认）/ "round_robin"（轮转）/ "weighted"（暂退化为顺序，留接口）
export function orderCandidates(candidates, strategy, familyKey, params = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const p = mergeParams(params);

  const keyed = candidates.map((route) => ({ route, key: breakerKey(route) }));
  const live = keyed.filter((item) => breakerAllow(item.key, p));
  const open = keyed.filter((item) => !breakerAllow(item.key, p));

  if (live.length === 0 && open.length > 0) {
    const oldest = open.slice().sort((a, b) => {
      const ta = registry.get(a.key)?.openedAt ?? 0;
      const tb = registry.get(b.key)?.openedAt ?? 0;
      return ta - tb;
    })[0];
    forceHalfOpen(oldest.key);
    live.push(oldest);
  }

  const orderedRoutes = live.map((item) => item.route);
  if (strategy === "round_robin") {
    return applyRoundRobin(orderedRoutes, familyKey);
  }
  return orderedRoutes; // failover / weighted（暂退化）
}

// 仅供测试：清空全部熔断状态与 round_robin 游标。
export function _resetBreakersForTest() {
  registry.clear();
  rrCursors.clear();
}
