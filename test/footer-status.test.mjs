// V5.1 §5.6: footer 状态优先级回归保护
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStatusLine } from "../cli.mjs";
import { recordUpstreamError, getLastUpstreamError } from "../route-utils.mjs";

test("footer: 无法连接网关 优先", () => {
  const line = computeStatusLine({
    configError: "ECONNREFUSED",
    upstreamError: { kind: "stream-error", family: "opus", summary: "x" },
    lastOpResult: "error",
    lastOpError: "boom",
  });
  assert.match(line, /无法连接网关/);
  assert.match(line, /ECONNREFUSED/);
});

test("footer: 上游异常 次之", () => {
  const line = computeStatusLine({
    configError: null,
    upstreamError: { kind: "stream-error", family: "opus", summary: "x" },
    lastOpResult: "error",
    lastOpError: "boom",
  });
  assert.match(line, /上游异常/);
  assert.match(line, /\[opus\]/);
});

test("footer: 上次操作失败 再次", () => {
  const line = computeStatusLine({
    configError: null,
    upstreamError: null,
    lastOpResult: "error",
    lastOpError: "boom",
  });
  assert.match(line, /上次操作失败/);
  assert.match(line, /boom/);
});

test("footer: 上次操作成功", () => {
  const line = computeStatusLine({
    configError: null,
    upstreamError: null,
    lastOpResult: "ok",
  });
  assert.equal(line, "状态: 上次操作成功");
});

test("footer: 默认就绪", () => {
  const line = computeStatusLine({});
  assert.equal(line, "状态: 就绪");
});

test("footer: 上游异常带 status 位", () => {
  const line = computeStatusLine({
    configError: null,
    upstreamError: { kind: "upstream-5xx", family: "sonnet", status: 503, summary: "boom" },
  });
  assert.match(line, /upstream-5xx/);
  assert.match(line, /503/);
});

test("60s 窗口: 未过期能读到，过期返回 null", async () => {
  recordUpstreamError({ family: "opus", kind: "rate-limited", status: 429, summary: "test 60s" });
  const fresh = getLastUpstreamError(60_000);
  assert.ok(fresh, "freshly recorded should be visible");
  assert.equal(fresh.kind, "rate-limited");

  // 模拟过期：maxAgeMs = -1 任何非未来记录都过期
  const expired = getLastUpstreamError(-1);
  assert.equal(expired, null);
});

test("状态快照: 同一窗口内多次读取结果一致（不一次性消费）", () => {
  recordUpstreamError({ family: "haiku", kind: "api-error", status: 401, summary: "auth" });
  const a = getLastUpstreamError(60_000);
  const b = getLastUpstreamError(60_000);
  const c = getLastUpstreamError(60_000);
  assert.ok(a && b && c, "all three reads should see the alert");
  assert.equal(a.kind, "api-error");
  assert.equal(b.kind, "api-error");
  assert.equal(c.kind, "api-error");
});
