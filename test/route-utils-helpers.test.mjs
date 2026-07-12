// route-utils.mjs 辅助函数测试。
//
// 此前 compat/footer-status/debug-log 只覆盖了部分解析函数。
// 本文件补齐此前空白的纯函数：
//   - describeBinding：多种绑定形态的标签生成（含旧单四元组兼容）
//   - getPrimaryQuad / getAllQuads：候选提取
//   - findProviderModel / findProviderKey / findProviderBaseUrl：子资源查找
//   - formatFamiliesLine：启动 banner 的 family 行
//   - summarizeFamilyRoute：family 路由摘要
//   - getRecentLogs：日志缓冲（FIFO + limit）
//   - recordRouteUpstreamError / getLastUpstreamError：route-aware 错误记录 + 新鲜度窗口
//   - log*Change 函数族：配置变更日志格式（验证入缓冲）
//   - setSuppressConsole / isConsoleSuppressed：CLI 抑制开关

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeBinding,
  getPrimaryQuad,
  getAllQuads,
  findProviderModel,
  findProviderKey,
  findProviderBaseUrl,
  formatFamiliesLine,
  summarizeFamilyRoute,
  resolveBoundRoute,
  getRecentLogs,
  recordRouteUpstreamError,
  recordUpstreamError,
  getLastUpstreamError,
  setSuppressConsole,
  isConsoleSuppressed,
  logRaw,
  logFamilySwitch,
  logPortChange,
} from "../route-utils.mjs";

function makeProvider(id = "glm") {
  return {
    id,
    name: "GLM",
    baseUrls: [
      { id: "b1", url: "https://api.example.com", note: "main" },
      { id: "b2", url: "https://backup.example.com", note: "backup" },
    ],
    keys: [{ id: "k1", token: "tok", note: "primary" }],
    models: [
      { id: "m1", model: "glm-5", name: "GLM 5" },
      { id: "m2", model: "glm-4", name: "GLM 4" },
    ],
  };
}

function makeConfig() {
  return {
    providers: { glm: makeProvider() },
    modelFamilies: {
      opus: {
        candidates: [{ providerId: "glm", baseUrlId: "b1", keyId: "k1", modelId: "m1" }],
        strategy: "failover",
        circuitBreaker: null,
      },
      sonnet: { candidates: [], strategy: "failover", circuitBreaker: null },
      "sonnet[1m]": { candidates: [], strategy: "failover", circuitBreaker: null },
      haiku: { candidates: [], strategy: "failover", circuitBreaker: null },
    },
  };
}

// ===== describeBinding =====

test("describeBinding：完整 binding 显示 provider · model · note · keyNote", () => {
  const config = makeConfig();
  const binding = config.modelFamilies.opus;
  const label = describeBinding(config, binding);
  assert.match(label, /GLM/);
  assert.match(label, /GLM 5/);
  assert.match(label, /main/);
  assert.match(label, /primary/);
});

test("describeBinding：多候选时尾部显示备选数量", () => {
  const config = makeConfig();
  const binding = {
    candidates: [
      { providerId: "glm", baseUrlId: "b1", keyId: "k1", modelId: "m1" },
      { providerId: "glm", baseUrlId: "b2", keyId: "k1", modelId: "m1" },
    ],
    strategy: "failover",
    circuitBreaker: null,
  };
  const label = describeBinding(config, binding);
  assert.match(label, /\(\+1备\)/, "1 个备选显示 (+1备)");
});

test("describeBinding：空 binding 返回'未配置'", () => {
  const config = makeConfig();
  assert.equal(describeBinding(config, { candidates: [], strategy: "failover" }), "未配置");
  assert.equal(describeBinding(config, null), "未配置");
});

test("describeBinding：引用失效资源返回'配置已失效'", () => {
  const config = makeConfig();
  const binding = {
    candidates: [{ providerId: "ghost", baseUrlId: "ghost", keyId: "ghost", modelId: "ghost" }],
    strategy: "failover",
  };
  assert.equal(describeBinding(config, binding), "配置已失效");
});

test("describeBinding：兼容旧单四元组形态", () => {
  const config = makeConfig();
  const oldQuad = { providerId: "glm", baseUrlId: "b1", keyId: "k1", modelId: "m1" };
  const label = describeBinding(config, oldQuad);
  assert.match(label, /GLM/);
});

// ===== getPrimaryQuad / getAllQuads =====

test("getPrimaryQuad：从 candidates 列表取第一个有效四元组", () => {
  const binding = {
    candidates: [
      { providerId: null }, // 无效（空）
      { providerId: "glm", baseUrlId: "b1", keyId: "k1", modelId: "m1" },
    ],
  };
  const quad = getPrimaryQuad(binding);
  assert.deepEqual(quad, { providerId: "glm", baseUrlId: "b1", keyId: "k1", modelId: "m1" });
});

test("getPrimaryQuad：空列表返回 null", () => {
  assert.equal(getPrimaryQuad({ candidates: [] }), null);
  assert.equal(getPrimaryQuad(null), null);
});

test("getPrimaryQuad：兼容旧单四元组", () => {
  const quad = getPrimaryQuad({ providerId: "glm", baseUrlId: "b1" });
  assert.equal(quad.providerId, "glm");
});

test("getAllQuads：返回所有有效候选", () => {
  const config = makeConfig();
  const all = getAllQuads(config, "opus");
  assert.equal(all.length, 1);
  assert.equal(all[0].providerId, "glm");
});

test("getAllQuads：未配置 family 返回空数组", () => {
  const config = makeConfig();
  assert.equal(getAllQuads(config, "sonnet").length, 0);
});

// ===== findProvider* =====

test("findProviderModel：按 id 查找 model", () => {
  const provider = makeProvider();
  assert.equal(findProviderModel(provider, "m1")?.model, "glm-5");
  assert.equal(findProviderModel(provider, "nonexistent"), null);
  assert.equal(findProviderModel(null, "m1"), null);
});

test("findProviderKey：按 id 查找 key", () => {
  const provider = makeProvider();
  assert.equal(findProviderKey(provider, "k1")?.token, "tok");
  assert.equal(findProviderKey(provider, "x"), null);
});

test("findProviderBaseUrl：按 id 查找 baseUrl", () => {
  const provider = makeProvider();
  assert.equal(findProviderBaseUrl(provider, "b1")?.url, "https://api.example.com");
  assert.equal(findProviderBaseUrl(provider, "b2")?.note, "backup");
  assert.equal(findProviderBaseUrl(provider, "x"), null);
});

// ===== formatFamiliesLine / summarizeFamilyRoute =====

test("formatFamiliesLine：已配置 family 显示 provider:model，未配置显示 (未配置)", () => {
  const config = makeConfig();
  const line = formatFamiliesLine(config);
  assert.match(line, /opus->glm:glm-5/);
  assert.match(line, /sonnet>\(未配置\)/);
  assert.match(line, /haiku>\(未配置\)/);
});

test("summarizeFamilyRoute：已配置返回完整 route 摘要", () => {
  const config = makeConfig();
  const summary = summarizeFamilyRoute(config, "opus");
  assert.equal(summary.status, "ok");
  assert.equal(summary.providerId, "glm");
  assert.equal(summary.providerName, "GLM");
  assert.equal(summary.modelModel, "glm-5");
  assert.match(summary.label, /GLM · GLM 5/);
});

test("summarizeFamilyRoute：未配置 family 返回 unconfigured 状态", () => {
  const config = makeConfig();
  const summary = summarizeFamilyRoute(config, "sonnet");
  assert.equal(summary.status, "unconfigured");
  assert.equal(summary.label, "未配置");
});

// ===== resolveBoundRoute 边界 =====

test("resolveBoundRoute：不存在的 family 返回 unknown_family", () => {
  const config = makeConfig();
  const r = resolveBoundRoute(config, "ghost");
  assert.equal(r.kind, "unknown_family");
});

test("resolveBoundRoute：引用失效返回 unconfigured", () => {
  const config = {
    providers: {},
    modelFamilies: {
      opus: {
        candidates: [{ providerId: "ghost", baseUrlId: "g", keyId: "g", modelId: "g" }],
        strategy: "failover",
      },
    },
  };
  const r = resolveBoundRoute(config, "opus");
  assert.equal(r.kind, "unconfigured");
});

// ===== getRecentLogs 缓冲 =====

test("getRecentLogs：返回最近 N 条，受 limit 上限", () => {
  // logRaw 入缓冲；用唯一标记验证顺序和 limit
  const marker = `route-utils-test-${Date.now()}`;
  for (let i = 0; i < 10; i++) {
    logRaw(`${marker}-${i}`);
  }
  const recent = getRecentLogs(3);
  const mine = recent.filter((l) => l.includes(marker));
  assert.equal(mine.length, 3, "limit=3 应只返回最后 3 条");
  assert.ok(mine[2].includes(`${marker}-9`), "最后一条应是 -9");
});

// ===== recordRouteUpstreamError / getLastUpstreamError =====

test("recordRouteUpstreamError：从 route 提取 family/providerId", () => {
  recordRouteUpstreamError(
    { modelFamily: "opus", providerId: "glm" },
    { kind: "upstream-5xx", status: 503, summary: "GLM 503" },
  );
  const err = getLastUpstreamError(60_000);
  assert.equal(err.family, "opus");
  assert.equal(err.providerId, "glm");
  assert.equal(err.kind, "upstream-5xx");
  assert.equal(err.status, 503);
  assert.match(err.summary, /GLM 503/);
});

test("recordRouteUpstreamError：route=null 时 family/providerId 为 null", () => {
  recordRouteUpstreamError(null, { kind: "upstream-fetch", summary: "net err" });
  const err = getLastUpstreamError(60_000);
  assert.equal(err.family, null);
  assert.equal(err.providerId, null);
});

test("getLastUpstreamError：超过新鲜度窗口返回 null", async () => {
  recordUpstreamError({ family: "haiku", kind: "test", summary: "fresh" });
  assert.ok(getLastUpstreamError(60_000), "窗口内应返回");
  // 跨过毫秒边界确保 ts 与 now 不同毫秒，再用 maxAgeMs=-1 强制判定过期
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(getLastUpstreamError(-1), null, "负窗口应视为过期");
});

// ===== log*Change 格式 =====

test("logFamilySwitch：格式含 [config-change] + family + from/to + source", () => {
  const marker = `fam-switch-${Date.now()}`;
  logFamilySwitch({ family: "opus", fromLabel: "A", toLabel: marker, source: "cli" });
  const recent = getRecentLogs(5);
  const found = recent.find((l) => l.includes(marker));
  assert.ok(found, "family switch 日志应入缓冲");
  assert.match(found, /\[config-change\]/);
  assert.match(found, /family=opus/);
  assert.match(found, /source=cli/);
});

test("logPortChange：格式含 port from/to", () => {
  const marker = `port-${Date.now()}`;
  logPortChange({ from: 8000, to: 9000, source: marker });
  const recent = getRecentLogs(5);
  const found = recent.find((l) => l.includes(marker));
  assert.ok(found);
  assert.match(found, /from=8000/);
  assert.match(found, /to=9000/);
});

// ===== setSuppressConsole =====

test("setSuppressConsole：切换抑制开关并保持可查询", () => {
  const before = isConsoleSuppressed();
  setSuppressConsole(true);
  assert.equal(isConsoleSuppressed(), true);
  setSuppressConsole(false);
  assert.equal(isConsoleSuppressed(), false);
  // 恢复原状
  setSuppressConsole(before);
});
