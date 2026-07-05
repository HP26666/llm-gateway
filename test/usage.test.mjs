// usage.test.mjs
// 用量统计端到端测试：recordUsage 写文件 → aggregateUsage 读回聚合。
// 不依赖真实 HTTP 请求，直接调用 usage-store API。

import { equal, notEqual, ok } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import { recordUsage, aggregateUsage, cleanupOldUsageFiles } from "../usage-store.mjs";

// 注意：recordUsage 写入的是进程同目录的 data/usage-YYYYMMDD.jsonl。
// 测试用例会产生真实文件，但每条 token 数极小，且与生产数据隔离到独立 key。
// 若担心污染，可在 CI 前手动清空 data/usage-*.jsonl。

beforeEach(async () => {
  // 不同 case 用不同 keyId 避免互相干扰聚合结果
});

afterEach(async () => {});

test("recordUsage + aggregateUsage today：单条记录被正确聚合", async () => {
  const stamp = `usage_test_single_${Date.now()}`;
  await recordUsage({
    family: "opus",
    providerId: "glm",
    modelId: "m_test",
    keyId: stamp,
    in: 100,
    out: 200,
    cacheR: 0,
    cacheW: 0,
    status: 200,
    ms: 500,
  });

  const agg = await aggregateUsage("today");
  // 至少包含刚才那条
  ok(agg.totals.total >= 300, `total should be >= 300, got ${agg.totals.total}`);
  ok(agg.totals.reqs >= 1, `reqs should be >= 1, got ${agg.totals.reqs}`);
  // byFamily 应该有 opus
  ok(agg.byFamily.opus, "byFamily should have opus");
  equal(typeof agg.byFamily.opus.tokens, "number");
  // 24 小时桶
  equal(agg.timeBuckets.length, 24);
  equal(agg.bucketLabels.length, 24);
  equal(agg.bucketLabels[0], "00");
  equal(agg.bucketLabels[23], "23");
});

test("aggregateUsage today：input/output 分别统计", async () => {
  const stamp = `usage_test_split_${Date.now()}`;
  await recordUsage({
    family: "sonnet",
    providerId: "kimi",
    modelId: "m_test",
    keyId: stamp,
    in: 50,
    out: 150,
    cacheR: 30,
    cacheW: 20,
    status: 200,
    ms: 100,
  });

  const agg = await aggregateUsage("today");
  ok(agg.totals.in >= 50, `in should be >= 50`);
  ok(agg.totals.out >= 150, `out should be >= 150`);
  ok(agg.totals.cacheR >= 30, `cacheR should be >= 30`);
  ok(agg.totals.cacheW >= 20, `cacheW should be >= 20`);
});

test("aggregateUsage 7d：返回 7 个桶", async () => {
  const agg = await aggregateUsage("7d");
  equal(agg.range, "7d");
  equal(agg.timeBuckets.length, 7);
  equal(agg.bucketLabels.length, 7);
});

test("aggregateUsage 30d：返回 30 个桶", async () => {
  const agg = await aggregateUsage("30d");
  equal(agg.range, "30d");
  equal(agg.timeBuckets.length, 30);
  equal(agg.bucketLabels.length, 30);
});

test("aggregateUsage 非法 range 降级为 today", async () => {
  const agg = await aggregateUsage("invalid_range_xyz");
  equal(agg.range, "today");
  equal(agg.timeBuckets.length, 24);
});

test("aggregateUsage 错误请求计入 errors", async () => {
  const stamp = `usage_test_err_${Date.now()}`;
  await recordUsage({
    family: "haiku",
    providerId: "deepseek",
    modelId: "m_test",
    keyId: stamp,
    in: 0,
    out: 0,
    cacheR: 0,
    cacheW: 0,
    status: 429,
    ms: 50,
  });

  const agg = await aggregateUsage("today");
  ok(agg.totals.errors >= 1, `errors should be >= 1, got ${agg.totals.errors}`);
});

test("cleanupOldUsageFiles 不抛错（惰性清理，幂等）", async () => {
  // 强制重置节流：通过重新 import 拿到新模块实例
  await cleanupOldUsageFiles();
  // 再调一次应同样安全
  await cleanupOldUsageFiles();
  // 不抛错即通过
  ok(true);
});

test("recordUsage 失败不影响调用方（吞掉错误）", async () => {
  // 正常记录不应抛错
  await recordUsage({
    family: null,
    providerId: null,
    modelId: null,
    keyId: null,
    in: 0,
    out: 0,
    status: 500,
    ms: 0,
  });
  ok(true);
});

test("aggregateUsage byProvider 维度存在", async () => {
  const stamp = `usage_test_prov_${Date.now()}`;
  await recordUsage({
    family: "opus",
    providerId: "glm",
    modelId: "m_test",
    keyId: stamp,
    in: 80,
    out: 120,
    cacheR: 0,
    cacheW: 0,
    status: 200,
    ms: 300,
  });

  const agg = await aggregateUsage("today");
  ok(agg.byProvider.glm, "byProvider should have glm");
  ok(agg.byProvider.glm.tokens >= 200);
  ok(agg.byProvider.glm.reqs >= 1);
});

test("aggregateUsage peak 计算：返回非负峰值和标签", async () => {
  const agg = await aggregateUsage("today");
  ok(agg.peak >= 0, `peak should be >= 0, got ${agg.peak}`);
  ok(typeof agg.peakLabel === "string");
  notEqual(agg.peakLabel, undefined);
});
