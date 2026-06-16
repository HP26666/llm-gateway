// 方向键高亮选择器（第一批）。原生 node:readline + ANSI，零依赖。
//
// 设计要点（详见 plans/concurrent-sniffing-hellman.md）：
// - raw mode + keypress 范式照搬 cli.mjs 的 viewLogsLiveFlow：进入前记 wasRaw，
//   try/finally 成对恢复，cleanup 清 rl.line/rl.cursor，绝不 rl.pause()。
// - raw mode 期间 readline 行编辑失效（Enter 是 \r），选择器全权接管输入，不用 ask。
// - 局部重绘：\x1b[<n>A 回列表首行 + 逐行 \r\x1b[K 重画，不碰上方 message，避免全屏闪烁。
// - 反色高亮 \x1b[7m / 复位 \x1b[0m。
// - 安全阀：canRaw（setRawMode 存在 + isTTY）或 env LLM_CLI_NO_KEYSELECT=1 → onFallback 走原数字模式。
// - 按键→动作、布局、渲染都抽成纯函数，便于单测（test/cli-select.test.mjs）。

// ---------------- 取消错误（输入流程中途取消的统一信号） ----------------

// 多步文本输入流程（createProvider 等）中途取消时抛出；上层 catch 据此显示"已取消"而非"错误"。
export class CancelledError extends Error {
  constructor(message = "已取消") {
    super(message);
    this.name = "CancelledError";
    this.cancelled = true;
  }
}

// ---------------- 终端宽度工具（自包含，不依赖 cli.mjs，便于单测） ----------------

export function visualWidth(text) {
  let width = 0;
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0x303e)
      || (code >= 0x3041 && code <= 0x33ff)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0xa000 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe4f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function truncateForWidth(text, maxWidth) {
  const str = String(text ?? "");
  if (visualWidth(str) <= maxWidth) {
    return str;
  }
  if (maxWidth <= 1) {
    return "";
  }
  let width = 0;
  let result = "";
  const ellipsis = "…";
  const target = maxWidth - 1; // 省略号视觉宽 1
  for (const ch of str) {
    const w = visualWidth(ch);
    if (width + w > target) {
      break;
    }
    result += ch;
    width += w;
  }
  return result + ellipsis;
}

export function padEnd(text, width) {
  const str = String(text ?? "");
  const vw = visualWidth(str);
  if (vw >= width) {
    return truncateForWidth(str, width);
  }
  return str + " ".repeat(width - vw);
}

function clamp(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// ---------------- 网格导航纯函数（grid/inline 用；单列用 clamp） ----------------

export function rowIndexOf(index, columns) {
  return Math.floor(index / Math.max(1, columns));
}

// 同行左移一项；行首不动（不循环，避免误触跳到行尾）
export function gridLeft(index, columns) {
  const cols = Math.max(1, columns);
  if (index % cols === 0) {
    return index;
  }
  return index - 1;
}

// 同行右移一项；行末/末项不动
export function gridRight(index, columns, count) {
  const cols = Math.max(1, columns);
  if (index >= count - 1) {
    return index;
  }
  const rowEnd = Math.min((Math.floor(index / cols) + 1) * cols - 1, count - 1);
  if (index >= rowEnd) {
    return index;
  }
  return index + 1;
}

// 上移一行；首行不动
export function gridUp(index, columns) {
  const target = index - Math.max(1, columns);
  return target < 0 ? index : target;
}

// 下移一行；末行（含不满列的最后一行）不动
export function gridDown(index, columns, count) {
  const target = index + Math.max(1, columns);
  return target >= count ? index : target;
}

// ---------------- 按键 → 动作（核心可测单元） ----------------
// 返回 { type: "move"|"confirm"|"cancel"|"hotkey"|"noop", index?, value? }
//   move    -> { type:"move", index }  改变选中（调用方负责重绘）
//   confirm -> { type:"confirm" }       确认当前选中
//   cancel  -> { type:"cancel" }        Esc / q(cancelOnQ) / Ctrl-C
//   hotkey  -> { type:"hotkey", value } 语义热键即时返回
//   noop    -> { type:"noop" }          忽略
export function resolveKeyAction(key, ctx) {
  const {
    index,
    count,
    layout = "single",
    columns = 1,
    hotkeys = {},
    cancelOnEsc = true,
    cancelOnQ = false,
  } = ctx || {};

  const name = key?.name;
  const seq = key?.sequence || "";
  const ctrl = !!key?.ctrl;

  if (ctrl && name === "c") {
    return { type: "cancel" };
  }
  if (name === "escape" && cancelOnEsc) {
    return { type: "cancel" };
  }
  if ((seq === "q" || seq === "Q") && cancelOnQ) {
    return { type: "cancel" };
  }
  if (name === "return" || name === "enter") {
    return { type: "confirm" };
  }

  // 语义热键优先（命令面板/子菜单的数字、字母），即时返回
  if (hotkeys[seq]) {
    return { type: "hotkey", value: hotkeys[seq].value };
  }

  if (!count || count <= 0) {
    return { type: "noop" };
  }

  // single 和 inline 都按一维导航（左=上、右=下，满足"四键都能切"）；
  // 仅 grid（第二批命令面板）用二维跨列/跨行。
  const isLinear = layout !== "grid";

  if (name === "up") {
    return { type: "move", index: isLinear ? clamp(index - 1, 0, count - 1) : gridUp(index, columns) };
  }
  if (name === "down") {
    return { type: "move", index: isLinear ? clamp(index + 1, 0, count - 1) : gridDown(index, columns, count) };
  }
  if (name === "left") {
    return { type: "move", index: isLinear ? clamp(index - 1, 0, count - 1) : gridLeft(index, columns) };
  }
  if (name === "right") {
    return { type: "move", index: isLinear ? clamp(index + 1, 0, count - 1) : gridRight(index, columns, count) };
  }

  // 数字键 1-9：资源列表语义 = 跳转高亮（回车确认）；超范围 noop
  if (/^[1-9]$/.test(seq)) {
    const target = Number(seq) - 1;
    if (target < count) {
      return { type: "move", index: target };
    }
  }
  return { type: "noop" };
}

// ---------------- 布局 / 渲染（纯函数） ----------------

// layout: "single"（单列垂直）/ "grid"（多列网格）/ "inline"（单行横排，grid 的特例）
// 返回 { layout, columns, colWidth, rows }
export function computeLayout(options, { layout = "single", columns, colWidth, termWidth = 80 } = {}) {
  const count = options.length;
  const tw = termWidth || 80;
  if (layout === "single") {
    // 单列可用宽度：终端宽 - 前缀2 - 右侧余量，上限 96
    const cw = Math.max(10, Math.min(tw - 4, 96));
    return { layout: "single", columns: 1, colWidth: cw, rows: count };
  }
  const cw = colWidth || 16;
  let cols = columns;
  if (!cols || cols < 1) {
    cols = Math.max(1, Math.min(4, Math.floor((tw - 2) / cw)));
  }
  cols = Math.max(1, Math.min(cols, count));
  const rows = Math.ceil(count / cols);
  return { layout: layout === "inline" ? "inline" : "grid", columns: cols, colWidth: cw, rows };
}

// 渲染一行（一个 row，可能含多个 grid cell）。返回不含末尾换行的完整行。
// 选中 cell 用反色覆盖整格 padding；单列格式为 "[n] label"，grid/inline 直接用 label（自带序号）。
export function renderRow(options, rowIndex, selectedIdx, info) {
  const { columns, colWidth } = info;
  const start = rowIndex * columns;
  const PREFIX = "  ";
  const SEP = "  ";
  const cells = [];
  for (let c = 0; c < columns; c++) {
    const i = start + c;
    let text;
    if (i >= options.length) {
      text = ""; // 网格末行空位补齐，保持对齐
    } else {
      const opt = options[i];
      text = info.layout === "single"
        ? `[${i + 1}] ${opt?.label ?? ""}`
        : String(opt?.label ?? "");
    }
    const padded = padEnd(text, colWidth);
    const selected = i === selectedIdx;
    cells.push(selected ? `\x1b[7m${padded}\x1b[0m` : padded);
  }
  return PREFIX + cells.join(SEP);
}

// ---------------- 运行时辅助（非纯，不单测） ----------------

function shouldUseRaw(options) {
  return (
    process.env.LLM_CLI_NO_KEYSELECT !== "1"
    && typeof process.stdin.setRawMode === "function"
    && !!process.stdout.isTTY
    && Array.isArray(options)
    && options.length > 0
  );
}

function readTermWidth() {
  const fromEnv = Number.parseInt(process.stdout.columns ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv >= 60) {
    return Math.min(fromEnv, 100);
  }
  return 80;
}

// ---------------- 主函数 ----------------

// 返回 Promise<{ value, cancelled }>：
//   确认/热键 -> { value, cancelled:false }
//   取消      -> { value:null, cancelled:true }
//   降级      -> onFallback() 的结果（也应是 { value, cancelled }）；无 onFallback -> { value:null, cancelled:true }
export async function selectWithKeys(options, opts = {}) {
  const {
    rl,
    message = "",
    layout = "single",
    columns,
    colWidth,
    startIndex = 0,
    cancelOnEsc = true,
    cancelOnQ = false,
    hotkeys = {},
    onFallback,
  } = opts;

  if (!shouldUseRaw(options)) {
    return onFallback ? await onFallback() : { value: null, cancelled: true };
  }

  const info = computeLayout(options, { layout, columns, colWidth, termWidth: readTermWidth() });
  const totalRows = info.rows;
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  let index = clamp(startIndex, 0, options.length - 1);

  // 进入 raw mode；失败降级
  try {
    stdin.setRawMode(true);
  } catch {
    return onFallback ? await onFallback() : { value: null, cancelled: true };
  }

  // mute readline 的 output：raw mode 下 readline 仍把 ↑↓ 当输入历史导航并 _refreshLine
  // 输出到 stdout，与选择器局部 redraw 冲突（表现为"按上下触发命令历史"）。
  // 换成哑 output 吞噬 readline 的写入；我们的 redraw 直接走 process.stdout 不受影响。
  const realOutput = rl && rl.output ? rl.output : null;
  let outputMuted = false;
  if (realOutput) {
    try {
      const muted = Object.create(realOutput);
      muted.write = function () { return true; };
      rl.output = muted;
      outputMuted = true;
    } catch {}
  }

  // 清 readline 残留 buffer，防 raw 期间被 _refreshLine 画出
  try {
    if (rl) {
      rl.line = "";
      rl.cursor = 0;
    }
  } catch {}

  const drawAll = () => {
    for (let r = 0; r < totalRows; r++) {
      process.stdout.write(renderRow(options, r, index, info) + "\n");
    }
  };
  const redraw = () => {
    if (totalRows > 0) {
      process.stdout.write(`\x1b[${totalRows}A`);
    }
    for (let r = 0; r < totalRows; r++) {
      process.stdout.write("\r\x1b[K" + renderRow(options, r, index, info) + "\n");
    }
  };

  let onKey = null;
  try {
    if (message) {
      process.stdout.write("\n" + message + "\n");
    }
    return await new Promise((resolve) => {
      onKey = (str, key) => {
        const act = resolveKeyAction(key, {
          index,
          count: options.length,
          layout: info.layout,
          columns: info.columns,
          hotkeys,
          cancelOnEsc,
          cancelOnQ,
        });
        switch (act.type) {
          case "move":
            if (act.index !== index) {
              index = act.index;
              redraw();
            }
            break;
          case "confirm":
            process.stdout.write("\n");
            resolve({ value: options[index].value, cancelled: false });
            break;
          case "cancel":
            process.stdout.write("\n");
            resolve({ value: null, cancelled: true });
            break;
          case "hotkey":
            process.stdout.write("\n");
            resolve({ value: act.value, cancelled: false });
            break;
          default:
            break; // noop
        }
      };
      stdin.on("keypress", onKey);
      drawAll();
    });
  } finally {
    if (onKey) {
      try { stdin.removeListener("keypress", onKey); } catch {}
    }
    if (outputMuted) {
      try { rl.output = realOutput; } catch {}
    }
    try { stdin.setRawMode(wasRaw); } catch {}
    try {
      if (rl) {
        rl.line = "";
        rl.cursor = 0;
      }
    } catch {}
  }
}

// 薄适配：返回 value|null（cancel/降级取消 -> null）。onFallback 抛错（非法数字）原样传播。
export async function selectValue(rl, message, options, opts = {}) {
  const ret = await selectWithKeys(options, { rl, message, ...opts });
  if (!ret || ret.cancelled) {
    return null;
  }
  return ret.value;
}

// 非 TTY / env 禁用 时的降级：复刻原 pickOption 的数字模式（空/q 返回取消，非法数字 throw）。
export async function fallbackPickOptionByNumber(ask, message, options) {
  console.log(`\n${message}`);
  if (!options || options.length === 0) {
    console.log("(无可用选项)");
    return { value: null, cancelled: true };
  }
  options.forEach((option, i) => {
    console.log(`  [${i + 1}] ${option.label}`);
  });
  const answer = await ask("> ");
  const trimmed = answer.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "q") {
    return { value: null, cancelled: true };
  }
  const idx = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(idx) || idx < 1 || idx > options.length) {
    throw new Error("无效的选项");
  }
  return { value: options[idx - 1].value, cancelled: false };
}
