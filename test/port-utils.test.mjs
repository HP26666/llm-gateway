// port-utils.mjs 测试：端口探测、进程查询、进程杀死、端口校验。
//
// 此前零覆盖。这些是平台相关的系统调用封装（netstat/lsof/ss/taskkill），
// 测试策略：
//   - isValidPort：纯函数，全边界值
//   - checkPortFree：用真实 listen(0) 随机端口，测空闲/占用两种状态
//   - findPortOccupant：占一个端口后查询，应返回 pid（跨平台）
//   - killProcess：非法 pid 守卫（不真杀进程，避免影响测试环境）
//
// 不测平台特定的 netstat/lsof 输出解析细节（parseNetstatListeningPid 是内部函数），
// 但通过 findPortOccupant 的真实调用间接覆盖当前平台分支。

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createServer } from "node:http";

import { checkPortFree, findPortOccupant, killProcess, isValidPort } from "../port-utils.mjs";

// 占用一个端口，返回 { port, release }。
async function occupyPort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    port,
    release: () => new Promise((r) => server.close(r)),
  };
}

test("isValidPort：合法端口", () => {
  assert.equal(isValidPort(1), true);
  assert.equal(isValidPort(80), true);
  assert.equal(isValidPort(8000), true);
  assert.equal(isValidPort(65535), true);
});

test("isValidPort：边界外/非法值", () => {
  assert.equal(isValidPort(0), false, "0 保留");
  assert.equal(isValidPort(-1), false, "负数");
  assert.equal(isValidPort(65536), false, "超上限");
  assert.equal(isValidPort(100000), false);
  assert.equal(isValidPort(null), false);
  assert.equal(isValidPort(undefined), false);
  assert.equal(isValidPort(""), false);
  assert.equal(isValidPort("abc"), false);
  assert.equal(isValidPort(NaN), false);
  assert.equal(isValidPort(Infinity), false);
  assert.equal(isValidPort(true), false);
});

test("isValidPort：字符串数字也被接受（Number.parseInt 语义）", () => {
  assert.equal(isValidPort("8000"), true);
  assert.equal(isValidPort(" 80 "), true); // parseInt 容忍空格
  assert.equal(isValidPort("0"), false);
});

test("checkPortFree：未被占用的随机端口应返回 true", async () => {
  // 先占一个端口拿到可用端口号，释放后再测它空闲
  const occ = await occupyPort();
  const port = occ.port;
  await occ.release();
  // release 后端口应空闲（TIME_WAIT 不影响 listen 同地址，SO_REUSEADDR 默认）
  const free = await checkPortFree(port, "127.0.0.1");
  assert.equal(free, true);
});

test("checkPortFree：已被占用的端口应返回 false", async () => {
  const occ = await occupyPort();
  try {
    const free = await checkPortFree(occ.port, "127.0.0.1");
    assert.equal(free, false);
  } finally {
    await occ.release();
  }
});

test("checkPortFree：默认 host 参数（不传 host）", async () => {
  const occ = await occupyPort();
  try {
    // 不传 host，默认 127.0.0.1
    const free = await checkPortFree(occ.port);
    assert.equal(free, false);
  } finally {
    await occ.release();
  }
});

test("findPortOccupant：占用端口应返回包含 pid 的对象", async (t) => {
  const occ = await occupyPort();
  t.after(async () => { await occ.release(); });

  const occupant = await findPortOccupant(occ.port);
  // 不同平台/权限下可能拿不到 pid（返回 null），但拿到了就应有 pid 字段
  if (occupant !== null) {
    assert.equal(typeof occupant.pid, "number");
    assert.ok(occupant.pid > 0, "pid 应为正数");
  }
  // 注意：不强制要求非 null——某些 CI/容器环境 lsof/ss 权限不足会返回 null。
  // 这里主要验证函数不抛错、返回值类型正确。
});

test("findPortOccupant：空闲端口应返回 null", async () => {
  // 用一个几乎不可能被占的高位端口范围里挑一个
  const occ = await occupyPort();
  const port = occ.port;
  await occ.release();
  const occupant = await findPortOccupant(port);
  assert.equal(occupant, null);
});

test("findPortOccupant：非法端口返回 null（不抛错）", async () => {
  assert.equal(await findPortOccupant(0), null);
  assert.equal(await findPortOccupant(-1), null);
  assert.equal(await findPortOccupant(NaN), null);
});

test("killProcess：非法 pid 返回 false（不抛错）", async () => {
  assert.equal(await killProcess(0), false);
  assert.equal(await killProcess(-1), false);
  assert.equal(await killProcess(NaN), false);
  assert.equal(await killProcess(null), false);
  assert.equal(await killProcess(undefined), false);
});

test("killProcess：不存在的 pid 返回 false（命令失败被 catch）", async () => {
  // 用一个极大、几乎不可能存在的 pid
  const result = await killProcess(99999999);
  assert.equal(result, false);
});

test("checkPortFree 与 findPortOccupant 行为一致（同一端口的占用判定）", async (t) => {
  const occ = await occupyPort();
  t.after(async () => { await occ.release(); });

  const isFree = await checkPortFree(occ.port, "127.0.0.1");
  const occupant = await findPortOccupant(occ.port);
  // 占用时：checkPortFree=false 且（findPortOccupant 返回 null 或 非 null）
  // 关键一致性：不空闲时不应同时 findPortOccupant 返回 null && checkPortFree 返回 true
  assert.equal(isFree, false);
  // occupant 可能 null（权限），但不应与 isFree=true 矛盾
  if (isFree === false && occupant !== null) {
    assert.ok(occupant.pid > 0);
  }
});
