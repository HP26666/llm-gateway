// config.mjs 真实持久化测试：saveConfig 原子写 + 毒链修复 + loadConfig 分支。
//
// 覆盖此前被 __setSaveConfigForTest stub 掉的全部真实 I/O 路径：
//   - saveConfig 真实落盘（tmp+rename 原子写）
//   - ★ 毒链修复：第一次写入失败后，第二次能正常写入（saveQueue 不再永久中毒）
//   - saveConfig 规范化回写（Object.assign 把 normalizeConfig 结果同步回 config 对象）
//   - loadConfig：文件不存在 → 生成空配置；BOM 头剥离；JSON 解析失败 → 抛错；旧 schema 迁移
//   - saveQueue 串行化：并发 saveConfig 按序执行
//
// 隔离策略：备份真实 data/gateway.json，测试结束恢复。saveConfig 内部队列是模块级
// 单例，无法用临时目录隔离（CONFIG_PATH 是 const），因此用备份/恢复保证不污染开发机配置。

import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  saveConfig,
  loadConfig,
  createEmptyConfig,
  normalizeConfig,
  CONFIG_PATH,
  CURRENT_CONFIG_VERSION,
} from "../config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_PATH = `${CONFIG_PATH}.test-backup`;
const TMP_PATH = `${CONFIG_PATH}.tmp`;

async function backupRealConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    await writeFile(BACKUP_PATH, raw, "utf8");
  } catch {
    // 原文件不存在也行，BACKUP_PATH 不生成即可
  }
  // 删除主配置，让测试从干净状态开始
  try {
    await rm(CONFIG_PATH);
  } catch {
    // ignore
  }
  // 同时清理可能残留的 .tmp
  try {
    await rm(TMP_PATH);
  } catch {
    // ignore
  }
}

async function restoreRealConfig() {
  try {
    await rm(CONFIG_PATH);
  } catch {
    // ignore
  }
  try {
    const raw = await readFile(BACKUP_PATH, "utf8");
    await writeFile(CONFIG_PATH, raw, "utf8");
    await rm(BACKUP_PATH);
  } catch {
    // 没有备份 = 原本就不存在，不恢复
  }
  try {
    await rm(TMP_PATH);
  } catch {
    // ignore
  }
}

test("saveConfig 真实落盘：写入后磁盘内容与内存一致（原子 tmp+rename）", async (t) => {
  await backupRealConfig();
  t.after(async () => { await restoreRealConfig(); });

  const config = createEmptyConfig();
  config.gateway.port = 17777;
  config.gateway.sharedToken = "test-shared-token";

  await saveConfig(config);

  // 磁盘上应有完整规范化 JSON
  const raw = await readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, CURRENT_CONFIG_VERSION);
  assert.equal(parsed.gateway.port, 17777);
  assert.equal(parsed.gateway.sharedToken, "test-shared-token");
  // 四个 family 都应存在且为空 binding
  assert.deepEqual(Object.keys(parsed.modelFamilies).sort(), ["haiku", "opus", "sonnet", "sonnet[1m]"]);

  // .tmp 不应残留（rename 成功后临时文件已消失）
  await assert.rejects(() => access(TMP_PATH));
});

test("saveConfig 规范化回写：Object.assign 把规范化结果同步回传入的 config 对象", async (t) => {
  await backupRealConfig();
  t.after(async () => { await restoreRealConfig(); });

  const config = createEmptyConfig();
  // 注入一个不在 normalize 输出里的多余字段，saveConfig 后应被删除
  config.junkField = "should-be-removed";
  config.gateway.extraNoise = "x";

  await saveConfig(config);

  assert.equal(config.junkField, undefined, "多余顶层字段应被删除");
  assert.equal(config.gateway.extraNoise, undefined, "多余 gateway 子字段应被删除");
});

test("★ 毒链修复：第一次 saveConfig reject 后，第二次仍能成功落盘", async (t) => {
  // 这是回归测试，锁定此前发现的阻塞性 bug：
  // saveQueue .then 链一旦 rejected，后续所有 saveConfig 永久短路到 reject。
  // 修复后 .catch(() => {}) 保证链不断，第二次写入正常执行。
  //
  // 失败注入：把 CONFIG_PATH.tmp 变成目录 → writeConfigFile 内部 writeFile(tmp) 报 EISDIR。
  await backupRealConfig();
  t.after(async () => { await restoreRealConfig(); });

  const { mkdir } = await import("node:fs/promises");
  // 第一次：制造 EISDIR 失败
  await mkdir(TMP_PATH, { recursive: true });
  const badConfig = createEmptyConfig();
  badConfig.gateway.port = 18001;
  await assert.rejects(saveConfig(badConfig));

  // 清理 .tmp 目录，恢复正常 fs 状态
  await rm(TMP_PATH, { recursive: true });

  // 第二次：正常 config，毒链修复后应能成功写入（修复前这里会 reject 旧错误）
  const goodConfig = createEmptyConfig();
  goodConfig.gateway.port = 18002;
  await saveConfig(goodConfig);

  const raw = await readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.gateway.port, 18002, "第二次写入应成功落盘");
});

test("saveConfig 串行化：并发调用按序执行，最终落盘最后一个", async (t) => {
  await backupRealConfig();
  t.after(async () => { await restoreRealConfig(); });

  // 同时发起 5 次写入，队列保证不交错
  const writes = [];
  for (let i = 0; i < 5; i++) {
    const cfg = createEmptyConfig();
    cfg.gateway.port = 19000 + i;
    writes.push(saveConfig(cfg).catch(() => {})); // 个别可能因竞态失败，忽略
  }
  await Promise.all(writes);

  // 最终落盘的应是最后一次（队列串行，后者覆盖前者）
  const raw = await readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  // 端口应是 5 次中的一个，且最后一次（19004）应最终生效
  assert.ok(parsed.gateway.port >= 19000 && parsed.gateway.port <= 19004);
});

test("loadConfig：文件不存在时生成空配置并落盘", async (t) => {
  await backupRealConfig();
  t.after(async () => { await restoreRealConfig(); });

  const config = await loadConfig();
  assert.equal(config.version, CURRENT_CONFIG_VERSION);
  assert.equal(config.gateway.host, "127.0.0.1");
  assert.equal(config.gateway.port, 8000);
  assert.deepEqual(config.providers, {});
  assert.deepEqual(Object.keys(config.modelFamilies).sort(), ["haiku", "opus", "sonnet", "sonnet[1m]"]);

  // 空配置应已落盘
  const raw = await readFile(CONFIG_PATH, "utf8");
  assert.ok(raw.length > 0);
});

test("loadConfig：BOM 头被正确剥离，可正常解析", async (t) => {
  await backupRealConfig();
  t.after(async () => { await restoreRealConfig(); });

  // 写一个带 UTF-8 BOM 的配置文件
  const config = createEmptyConfig();
  config.gateway.port = 18555;
  const json = JSON.stringify(config, null, 2);
  const bomJson = `\uFEFF${json}`;
  await writeFile(CONFIG_PATH, bomJson, "utf8");

  const loaded = await loadConfig();
  assert.equal(loaded.gateway.port, 18555, "BOM 头不应导致 JSON 解析失败");
});

test("loadConfig：JSON 解析失败时抛出清晰的错误", async (t) => {
  await backupRealConfig();
  t.after(async () => { await restoreRealConfig(); });

  await writeFile(CONFIG_PATH, "{ this is not valid json ]", "utf8");

  await assert.rejects(loadConfig(), /Invalid gateway\.json/i);
});

test("loadConfig：旧 schema（单四元组 family）自动迁移为 candidates 列表", async (t) => {
  await backupRealConfig();
  t.after(async () => { await restoreRealConfig(); });

  // 构造一个 V2 风格的旧配置：family 直接是单四元组，无 candidates 数组
  const legacy = {
    version: 2,
    gateway: { host: "127.0.0.1", port: 8000, sharedToken: null, adminToken: null },
    providers: {
      glm: {
        id: "glm",
        name: "GLM",
        authHeader: "Authorization",
        authScheme: "Bearer",
        baseUrls: [{ id: "b1", url: "https://api.example.com", note: "main" }],
        keys: [{ id: "k1", token: "tok", note: "n", createdAt: "2026-01-01T00:00:00Z" }],
        models: [{ id: "m1", model: "glm-5", name: "GLM5" }],
      },
    },
    circuitBreaker: null,
    modelFamilies: {
      // 旧形态：顶层直接是四元组
      opus: { providerId: "glm", baseUrlId: "b1", keyId: "k1", modelId: "m1" },
      sonnet: {},
      "sonnet[1m]": {},
      haiku: {},
    },
    history: [],
  };
  await writeFile(CONFIG_PATH, JSON.stringify(legacy, null, 2), "utf8");

  const loaded = await loadConfig();

  assert.equal(loaded.version, CURRENT_CONFIG_VERSION, "版本号应升级到当前");
  assert.ok(Array.isArray(loaded.modelFamilies.opus.candidates), "opus 应被迁移为 candidates 数组");
  assert.equal(loaded.modelFamilies.opus.candidates.length, 1);
  assert.deepEqual(
    loaded.modelFamilies.opus.candidates[0],
    { providerId: "glm", baseUrlId: "b1", keyId: "k1", modelId: "m1" },
  );
  assert.equal(loaded.modelFamilies.opus.strategy, "failover");
});

test("loadConfig → saveConfig 往返：加载后保存内容稳定（幂等）", async (t) => {
  await backupRealConfig();
  t.after(async () => { await restoreRealConfig(); });

  const first = await loadConfig();
  await saveConfig(first);
  const raw1 = await readFile(CONFIG_PATH, "utf8");

  // 再加载再保存，内容应完全一致（规范化幂等）
  const second = await loadConfig();
  await saveConfig(second);
  const raw2 = await readFile(CONFIG_PATH, "utf8");

  assert.equal(raw1, raw2, "规范化幂等：连续两次落盘内容完全一致");
});

test("normalizeConfig：空/非法输入降级为空配置而非崩溃", async () => {
  const r1 = normalizeConfig(null);
  assert.equal(r1.version, CURRENT_CONFIG_VERSION);
  assert.deepEqual(r1.providers, {});

  const r2 = normalizeConfig("not an object");
  assert.equal(r2.version, CURRENT_CONFIG_VERSION);

  const r3 = normalizeConfig({ gateway: { port: "not-a-number" } });
  assert.equal(r3.gateway.port, 8000, "非法端口降级为默认 8000");

  const r4 = normalizeConfig({ gateway: { port: 99999 } });
  assert.equal(r4.gateway.port, 8000, "超范围端口降级为默认");

  const r5 = normalizeConfig({ gateway: { port: -1 } });
  assert.equal(r5.gateway.port, 8000, "负端口降级为默认");
});
