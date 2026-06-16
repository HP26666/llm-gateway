// 方向键选择器纯函数单测（第一批）。
// 只测与 stdin/stdout 解耦的纯函数：按键映射、网格导航、布局、渲染、宽度工具。
// 仿 footer-status.test.mjs：node:test + assert/strict。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  visualWidth,
  padEnd,
  truncateForWidth,
  resolveKeyAction,
  computeLayout,
  renderRow,
  gridLeft,
  gridRight,
  gridUp,
  gridDown,
  rowIndexOf,
} from "../cli-select.mjs";

// ---------------- resolveKeyAction: single 布局 ----------------

test("resolveKeyAction single: 上下移动 + 左右同义上下 + clamp", () => {
  const ctx = { index: 1, count: 3, layout: "single" };
  assert.deepEqual(resolveKeyAction({ name: "up" }, ctx), { type: "move", index: 0 });
  assert.deepEqual(resolveKeyAction({ name: "down" }, ctx), { type: "move", index: 2 });
  assert.deepEqual(resolveKeyAction({ name: "left" }, ctx), { type: "move", index: 0 }); // left = 上
  assert.deepEqual(resolveKeyAction({ name: "right" }, ctx), { type: "move", index: 2 }); // right = 下

  // 边界 clamp（不循环）
  assert.deepEqual(resolveKeyAction({ name: "up" }, { index: 0, count: 3, layout: "single" }), { type: "move", index: 0 });
  assert.deepEqual(resolveKeyAction({ name: "down" }, { index: 2, count: 3, layout: "single" }), { type: "move", index: 2 });
  assert.deepEqual(resolveKeyAction({ name: "left" }, { index: 0, count: 3, layout: "single" }), { type: "move", index: 0 });
  assert.deepEqual(resolveKeyAction({ name: "right" }, { index: 2, count: 3, layout: "single" }), { type: "move", index: 2 });
});

test("resolveKeyAction: 回车确认 / Esc / Ctrl-C 取消", () => {
  const ctx = { index: 0, count: 3, layout: "single" };
  assert.equal(resolveKeyAction({ name: "return" }, ctx).type, "confirm");
  assert.equal(resolveKeyAction({ name: "escape" }, ctx).type, "cancel");
  assert.equal(resolveKeyAction({ name: "c", sequence: "", ctrl: true }, ctx).type, "cancel");
});

test("resolveKeyAction: cancelOnEsc=false 时 Esc 不取消", () => {
  const ctx = { index: 0, count: 3, layout: "single", cancelOnEsc: false };
  assert.equal(resolveKeyAction({ name: "escape" }, ctx).type, "noop");
});

test("resolveKeyAction: q 受 cancelOnQ 控制", () => {
  assert.equal(resolveKeyAction({ name: "q", sequence: "q" }, { index: 0, count: 3, layout: "single", cancelOnQ: true }).type, "cancel");
  assert.equal(resolveKeyAction({ name: "q", sequence: "q" }, { index: 0, count: 3, layout: "single", cancelOnQ: false }).type, "noop");
});

test("resolveKeyAction: 语义热键即时返回（优先于数字跳转）", () => {
  const ctx = {
    index: 0, count: 4, layout: "inline",
    hotkeys: { "1": { value: "add" }, "0": { value: "back" } },
  };
  assert.deepEqual(resolveKeyAction({ sequence: "1" }, ctx), { type: "hotkey", value: "add" });
  assert.deepEqual(resolveKeyAction({ sequence: "0" }, ctx), { type: "hotkey", value: "back" });
});

test("resolveKeyAction: 数字键 1-9 跳转高亮，超范围/0 为 noop（无 hotkeys）", () => {
  const ctx = { index: 0, count: 5, layout: "single" };
  assert.deepEqual(resolveKeyAction({ sequence: "1" }, ctx), { type: "move", index: 0 });
  assert.deepEqual(resolveKeyAction({ sequence: "3" }, ctx), { type: "move", index: 2 });
  assert.deepEqual(resolveKeyAction({ sequence: "5" }, ctx), { type: "move", index: 4 });
  assert.equal(resolveKeyAction({ sequence: "9" }, ctx).type, "noop"); // 超范围
  assert.equal(resolveKeyAction({ sequence: "0" }, ctx).type, "noop"); // 资源列表 0 无意义
});

test("resolveKeyAction: count<=0 时方向键 noop", () => {
  assert.equal(resolveKeyAction({ name: "down" }, { index: 0, count: 0, layout: "single" }).type, "noop");
});

// ---------------- resolveKeyAction: inline 布局（一维，左=上/右=下） ----------------

test("resolveKeyAction inline: 左=上、右=下 一维导航 + clamp", () => {
  const ctx = { index: 1, count: 4, layout: "inline" };
  assert.deepEqual(resolveKeyAction({ name: "up" }, ctx), { type: "move", index: 0 });
  assert.deepEqual(resolveKeyAction({ name: "down" }, ctx), { type: "move", index: 2 });
  assert.deepEqual(resolveKeyAction({ name: "left" }, ctx), { type: "move", index: 0 }); // left = 上
  assert.deepEqual(resolveKeyAction({ name: "right" }, ctx), { type: "move", index: 2 }); // right = 下
  // clamp 边界
  assert.deepEqual(resolveKeyAction({ name: "up" }, { index: 0, count: 4, layout: "inline" }), { type: "move", index: 0 });
  assert.deepEqual(resolveKeyAction({ name: "down" }, { index: 3, count: 4, layout: "inline" }), { type: "move", index: 3 });
});

// ---------------- resolveKeyAction: grid 布局 ----------------

test("resolveKeyAction grid: 上下跨行、左右跨列", () => {
  const ctx = { index: 5, count: 12, layout: "grid", columns: 4 };
  assert.deepEqual(resolveKeyAction({ name: "down" }, ctx), { type: "move", index: 9 });
  assert.deepEqual(resolveKeyAction({ name: "up" }, ctx), { type: "move", index: 1 });
  assert.deepEqual(resolveKeyAction({ name: "right" }, ctx), { type: "move", index: 6 });
  assert.deepEqual(resolveKeyAction({ name: "left" }, ctx), { type: "move", index: 4 });
});

test("resolveKeyAction grid: 行首/行末/首末行不动（不循环）", () => {
  const base = { count: 12, layout: "grid", columns: 4 };
  assert.deepEqual(resolveKeyAction({ name: "left" }, { ...base, index: 4 }), { type: "move", index: 4 }); // 行首
  assert.deepEqual(resolveKeyAction({ name: "right" }, { ...base, index: 3 }), { type: "move", index: 3 }); // 行末
  assert.deepEqual(resolveKeyAction({ name: "up" }, { ...base, index: 2 }), { type: "move", index: 2 }); // 首行
  assert.deepEqual(resolveKeyAction({ name: "down" }, { ...base, index: 10 }), { type: "move", index: 10 }); // 末行
});

// ---------------- 网格导航纯函数 ----------------

test("gridLeft/gridRight: 行内移动", () => {
  assert.equal(gridLeft(5, 4), 4);
  assert.equal(gridLeft(4, 4), 4); // 行首不动
  assert.equal(gridRight(5, 4, 12), 6);
  assert.equal(gridRight(7, 4, 12), 7); // 行末不动
  assert.equal(gridRight(11, 4, 12), 11); // 末项不动
});

test("gridUp/gridDown: 跨行移动", () => {
  assert.equal(gridUp(5, 4), 1);
  assert.equal(gridUp(2, 4), 2); // 首行不动
  assert.equal(gridDown(5, 4, 12), 9);
  assert.equal(gridDown(10, 4, 12), 10); // 末行不动
});

test("rowIndexOf: 按列数算行号", () => {
  assert.equal(rowIndexOf(0, 4), 0);
  assert.equal(rowIndexOf(3, 4), 0);
  assert.equal(rowIndexOf(4, 4), 1);
  assert.equal(rowIndexOf(7, 4), 1);
});

// ---------------- 宽度工具 ----------------

test("visualWidth: CJK 宽 2，ASCII 宽 1", () => {
  assert.equal(visualWidth("abc"), 3);
  assert.equal(visualWidth("中文"), 4);
  assert.equal(visualWidth("a中"), 3);
  assert.equal(visualWidth(""), 0);
});

test("truncateForWidth: 超长截断加省略号", () => {
  assert.equal(truncateForWidth("abcdef", 4), "abc…");
  assert.equal(truncateForWidth("abc", 5), "abc");
  assert.equal(truncateForWidth("ab", 1), "");
  assert.equal(visualWidth(truncateForWidth("中文字符", 5)), 5); // CJK 截断后视觉宽正好 5
});

test("padEnd: 按视觉宽度补空格 / 超长截断", () => {
  assert.equal(padEnd("ab", 5), "ab   ");
  assert.equal(padEnd("中", 4), "中  ");
  assert.equal(visualWidth(padEnd("中", 4)), 4);
  assert.equal(padEnd("abcdef", 3), "ab…"); // 超长走截断
});

// ---------------- 布局 / 渲染 ----------------

test("computeLayout: single 列宽按终端自适应并设上限", () => {
  const info = computeLayout([{ label: "a" }, { label: "b" }], { layout: "single", termWidth: 80 });
  assert.equal(info.layout, "single");
  assert.equal(info.columns, 1);
  assert.equal(info.colWidth, 76); // 80 - 4
  assert.equal(info.rows, 2);
  const wide = computeLayout([{ label: "a" }], { layout: "single", termWidth: 200 });
  assert.equal(wide.colWidth, 96); // 上限 96
});

test("computeLayout: grid 列数自适应 + inline", () => {
  const grid = computeLayout(
    Array.from({ length: 12 }, (_, i) => ({ label: String(i) })),
    { layout: "grid", colWidth: 16, termWidth: 80 },
  );
  assert.equal(grid.layout, "grid");
  assert.equal(grid.columns, 4); // (80-2)/16 = 4
  assert.equal(grid.rows, 3);
  const inline = computeLayout([{ label: "1" }, { label: "2" }], { layout: "inline" });
  assert.equal(inline.layout, "inline");
  assert.equal(inline.columns, 2);
  assert.equal(inline.rows, 1);
});

test("renderRow: 单列格式 [n] label + 选中整格反色", () => {
  const opts = [{ label: "one" }, { label: "two" }, { label: "three" }];
  const info = computeLayout(opts, { layout: "single", termWidth: 80 });
  const normal = renderRow(opts, 0, -1, info);
  assert.match(normal, /\[1\] one/);
  assert.ok(!normal.includes("\x1b[7m"), "未选中行无反色");

  const selected = renderRow(opts, 1, 1, info);
  assert.ok(selected.includes("\x1b[7m"), "选中行含反色起始");
  assert.ok(selected.includes("\x1b[0m"), "选中行含复位");
  assert.ok(selected.includes("[2] two"));
});

test("renderRow: grid 多格横排，仅命中格高亮", () => {
  const opts = [{ label: "1=a" }, { label: "2=b" }, { label: "3=c" }, { label: "4=d" }];
  const info = computeLayout(opts, { layout: "inline" });
  const row = renderRow(opts, 0, 1, info);
  assert.ok(row.includes("1=a"));
  assert.ok(row.includes("2=b"));
  assert.ok(row.includes("\x1b[7m"), "第二格高亮");
});
