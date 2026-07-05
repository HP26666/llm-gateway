// CLI admin 请求头构造(buildAdminHeaders)测试。
// 验证:adminToken=null 不带 X-Admin-Token(向后兼容)、非空则带、extra 可覆盖。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAdminHeaders } from "../cli.mjs";

test("buildAdminHeaders:无 token 不含 X-Admin-Token", () => {
  const h = buildAdminHeaders(undefined, null);
  assert.equal(h["X-Admin-Token"], undefined);
  assert.equal(h["X-Admin-Source"], "cli");
  assert.equal(h["Content-Type"], "application/json");
});

test("buildAdminHeaders:有 token 含 X-Admin-Token", () => {
  const h = buildAdminHeaders(undefined, "s3cret-key");
  assert.equal(h["X-Admin-Token"], "s3cret-key");
  assert.equal(h["X-Admin-Source"], "cli");
});

test("buildAdminHeaders:extra headers 正常合并", () => {
  const h = buildAdminHeaders({ "X-Custom": "x" }, "s3cret-key");
  assert.equal(h["X-Custom"], "x");
  assert.equal(h["X-Admin-Token"], "s3cret-key");
});

test("buildAdminHeaders:调用方 extra 可覆盖 token(调用方优先)", () => {
  const h = buildAdminHeaders({ "X-Admin-Token": "override" }, "s3cret-key");
  assert.equal(h["X-Admin-Token"], "override");
});
