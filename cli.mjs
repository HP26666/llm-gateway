import readline from "node:readline";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FAMILY_ORDER, getLastUpstreamError, getRecentLogs, setSuppressConsole, getPrimaryQuad } from "./route-utils.mjs";
import { CIRCUIT_BREAKER_DEFAULTS } from "./circuit-breaker.mjs";
import { selectValue, fallbackPickOptionByNumber, CancelledError } from "./cli-select.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXPORT_DEFAULT_DIR = path.join(__dirname, "data", "export");

const CLI_LOG_LIMIT = 50;
const DEFAULT_WIDTH = 80;
const MIN_WIDTH = 60;
// box 总宽上限：终端再宽也不超过 100 列，避免窄屏被拉得太宽。
const MAX_WIDTH = 100;

// V5.1 §5.2：footer 状态纯函数，60s 新鲜度窗口，每次重绘都基于状态快照计算。
// 优先级:无法连接网关 > 上游异常 > CLI 操作结果 > 就绪
export function computeStatusLine({
  configError,
  upstreamError,
  lastOpResult,
  lastOpError,
}) {
  if (configError) {
    return `! 无法连接网关: ${configError}`;
  }
  if (upstreamError) {
    const familyTag = upstreamError.family ? `[${upstreamError.family}]` : "";
    const statusBit = upstreamError.status ? ` ${upstreamError.status}` : "";
    return `! 上游异常${familyTag} ${upstreamError.kind}${statusBit}: ${upstreamError.summary}`;
  }
  if (lastOpResult === "error") {
    return `状态: 上次操作失败（${lastOpError || "请按 8 查看日志"}）`;
  }
  if (lastOpResult === "ok") {
    return "状态: 上次操作成功";
  }
  return "状态: 就绪";
}

let gatewayUrl = "http://127.0.0.1:8000";

// 由 startCli 创建 readline 后赋值，供 pickOption / 子菜单的 selectValue 复用方向键选择。
let globalRl = null;

// 命令面板选项：label 复用 renderCommandList 字符串，value 与 handleCommand case 对齐。
// 数字/字母全作 hotkey 即时执行；方向键移动高亮，回车确认当前项。
const COMMAND_OPTIONS = [
  { label: "1=新建Provider", value: "1" },
  { label: "2=BaseUrl",      value: "2" },
  { label: "3=Key",          value: "3" },
  { label: "4=Model",        value: "4" },
  { label: "5=切换Family",  value: "5" },
  { label: "6=修改端口",    value: "6" },
  { label: "7=历史",         value: "7" },
  { label: "8=日志",         value: "8" },
  { label: "9=导出",         value: "9" },
  { label: "0=删除Provider", value: "0" },
  { label: "u=用量",         value: "u" },
  { label: "r=刷新",         value: "r" },
  { label: "q=退出",         value: "q" },
];
const COMMAND_HOTKEYS = Object.fromEntries(
  COMMAND_OPTIONS.map((o) => [o.value, { value: o.value }]),
);
let lastCommandIndex = 0;

function setGatewayUrl(url) {
  gatewayUrl = String(url || gatewayUrl);
}

function getGatewayUrl() {
  return gatewayUrl;
}

// admin 鉴权 token(由 startCli 从 config.gateway.adminToken 注入)。
// 默认 null = 不带 X-Admin-Token 头,与 ensureAdminAuth 的 null 放行一致(向后兼容)。
let adminToken = null;

function setAdminToken(token) {
  adminToken = token ? String(token) : null;
}

// 构造 admin 请求头。token 非空时带 X-Admin-Token;extra 允许调用方覆盖(含 token 本身)。
export function buildAdminHeaders(extra, token) {
  return {
    "Content-Type": "application/json",
    "X-Admin-Source": "cli",
    ...(token ? { "X-Admin-Token": token } : {}),
    ...(extra || {}),
  };
}

// 导出供测试驱动：setGatewayUrl 指向测试 server，api() 走真实 HTTP。
// 生产代码里这两者由 startCli 内部设置，测试外不会被外部调用。
export { api as _apiForTest, setGatewayUrl as _setGatewayUrlForTest, setAdminToken as _setAdminTokenForTest };

async function api(path, options = {}) {
  const init = {
    method: options.method || "GET",
    headers: buildAdminHeaders(options.headers, adminToken),
  };
  if (options.body !== undefined) {
    init.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }

  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    response = await fetch(`${getGatewayUrl()}/admin${path}`, { ...init, signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    const msg = isTimeout
      ? `请求超时(30s): ${path}`
      : `无法连接到网关 ${getGatewayUrl()}: ${error.message}`;
    const wrapped = new Error(msg);
    wrapped.payload = { error: { message: wrapped.message } };
    wrapped.status = isTimeout ? 408 : 0;
    throw wrapped;
  }
  clearTimeout(timer);
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const message = data?.error?.message || `请求失败: ${response.status}`;
    const err = new Error(message);
    err.payload = data;
    err.status = response.status;
    throw err;
  }
  return data;
}

function visualWidth(text) {
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

function truncateForWidth(text, maxWidth) {
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
  const ellipsisWidth = 1;
  const target = maxWidth - ellipsisWidth;
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

function padEnd(text, width) {
  const str = String(text ?? "");
  const vw = visualWidth(str);
  if (vw >= width) {
    return truncateForWidth(str, width);
  }
  return str + " ".repeat(width - vw);
}

// 视觉宽度恰好为 width 的字符串（超长截断 + 省略号，短则右侧补空格）
function fitInside(text, width) {
  return padEnd(text, width);
}

function terminalWidth() {
  const fromEnv = Number.parseInt(process.stdout.columns ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv >= MIN_WIDTH) {
    return Math.min(fromEnv, MAX_WIDTH);
  }
  return DEFAULT_WIDTH;
}

// 清屏并清 scrollback：[2J 清屏，[3J 清 scrollback，[H 光标归位。
// console.clear() 在某些 Windows 终端只清当前屏，scrollback 仍残留，
// 用显式转义保证每次主界面渲染都是"全新一屏"。
function fullClear() {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

export function describeRouteLabel(config, binding) {
  // 兼容新形态（{candidates,strategy,circuitBreaker}）与旧四元组：统一取主候选。
  const quad = getPrimaryQuad(binding) ?? binding;
  if (!quad || !quad.providerId || !quad.baseUrlId || !quad.modelId || !quad.keyId) {
    return "(未配置)";
  }
  const provider = config.providers?.[quad.providerId];
  if (!provider) {
    return "(配置已失效)";
  }
  const baseUrl = provider.baseUrls?.find((b) => b.id === quad.baseUrlId);
  const model = provider.models?.find((m) => m.id === quad.modelId);
  const key = provider.keys?.find((k) => k.id === quad.keyId);
  if (!baseUrl || !model || !key) {
    return "(配置已失效)";
  }
  const urlHost = (() => {
    try {
      return new URL(baseUrl.url).host;
    } catch {
      return baseUrl.url.slice(0, 20);
    }
  })();
  return `${provider.name} · ${model.name || model.model} · ${baseUrl.note || urlHost} · ${key.note || key.id}`;
}

// width 参数语义：框的总宽（含左右两侧的 │ 边框）。
// 边框行：┌ + ─*(width-2) + ┐，共 width 列。
// 内容行：│ + space + content(VW=inner) + space + │，共 width 列 → inner = width - 4。
function renderBox(title, lines, opts = {}) {
  const totalWidth = opts.width || terminalWidth();
  const inner = Math.max(10, totalWidth - 4);
  const border = "─".repeat(Math.max(2, totalWidth - 2));
  const out = [];
  out.push(`┌${border}┐`);
  if (title) {
    out.push(`│ ${fitInside(title, inner)} │`);
    out.push(`├${border}┤`);
  }
  for (const line of lines) {
    out.push(`│ ${fitInside(line, inner)} │`);
  }
  if (opts.footer) {
    out.push(`├${border}┤`);
    out.push(`│ ${fitInside(opts.footer, inner)} │`);
  }
  out.push(`└${border}┘`);
  return out.join("\n");
}

// ===== 用量图表渲染（纯 Unicode，零依赖）=====

const SPARK_BLOCKS = " ▁▂▃▄▅▆▇█";

// 微型折线图：8 级高度。空数据返回空串。所有值相同时显示中间高度，避免全空。
function sparkline(values) {
  if (!Array.isArray(values) || values.length === 0) return "";
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min;
  return values
    .map((v) => {
      const norm = range === 0 ? 4 : Math.round(((v - min) / range) * 8);
      return SPARK_BLOCKS[Math.max(0, Math.min(8, norm))];
    })
    .join("");
}

// 把 token 数格式化成人类可读：1.2K / 3.4M / 5.6B
function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

// 横向柱状图一行：label + 按比例填充的 █ 条 + 数值。
// maxVal 是所有项中的最大值，用于计算填充比例；barWidth 是 █ 条的最大宽度。
function barLine(label, value, maxVal, barWidth) {
  const safeMax = maxVal > 0 ? maxVal : 1;
  const ratio = Math.min(1, (Number(value) || 0) / safeMax);
  const filled = Math.max(ratio > 0 ? 1 : 0, Math.round(ratio * barWidth));
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barWidth - filled));
  return { label, bar, value };
}

// 命令面板：所有命令按视觉宽度对齐成多列；列数随终端宽度自适应。
function renderCommandList(totalWidth) {
  const commands = [
    "1=新建Provider", "2=BaseUrl", "3=Key", "4=Model",
    "5=切换Family", "6=修改端口", "7=历史", "8=日志",
    "9=导出", "0=删除Provider", "u=用量", "r=刷新", "q=退出",
  ];
  const colWidth = 16;
  const prefix = "  ";
  const cols = Math.max(1, Math.min(4, Math.floor((totalWidth - prefix.length) / colWidth)));
  const lines = ["命令:"];
  for (let i = 0; i < commands.length; i += cols) {
    const row = commands.slice(i, i + cols).map((c) => padEnd(c, colWidth)).join("");
    lines.push(prefix + row.trimEnd());
  }
  return lines;
}

function renderHome({ config, runtime, statusLine }) {
  fullClear();
  const totalWidth = terminalWidth();
  const lines = [];
  const host = runtime ? runtime.getHost() : config.gateway.host;
  const port = runtime ? runtime.getPort() : config.gateway.port;
  lines.push(`监听: http://${host}:${port}`);

  lines.push("");
  lines.push("Family 路由");
  for (const family of FAMILY_ORDER) {
    const binding = config.modelFamilies?.[family] || {};
    const label = describeRouteLabel(config, binding);
    lines.push(`  ${padEnd(family, 12)} -> ${label}`);
  }

  lines.push("");
  lines.push("Providers");
  const providerList = Object.values(config.providers || {});
  if (providerList.length === 0) {
    lines.push("  (暂无，请按 1 新建)");
  } else {
    for (const provider of providerList) {
      const stats = `baseUrls:${provider.baseUrls?.length ?? 0} keys:${provider.keys?.length ?? 0} models:${provider.models?.length ?? 0}`;
      const head = `  ${padEnd(provider.name, 20)} | ${stats}`;
      lines.push(head);
    }
  }

  const footer = statusLine || "状态: 就绪";
  const body = renderBox("LLM Gateway CLI", lines, { footer, width: totalWidth });
  console.log(body);
}

async function awaitCommandPanel(ask, totalWidth) {
  if (process.env.LLM_CLI_NO_KEYSELECT === "1") {
    return fallbackMainCommand(ask, totalWidth);
  }
  const value = await selectValue(
    globalRl,
    "命令（数字/字母直接执行 · 方向键移动 · 回车确认高亮 · r 刷新 · q 退出 · Esc 回顶部）",
    COMMAND_OPTIONS,
    {
      layout: "grid",
      colWidth: 16,
      hotkeys: COMMAND_HOTKEYS,
      cancelOnEsc: true,
      cancelOnQ: false,
      startIndex: lastCommandIndex,
      onFallback: async () => {
        const cmd = await fallbackMainCommand(ask, totalWidth);
        return { value: cmd, cancelled: false };
      },
    },
  );
  if (value !== null) {
    const idx = COMMAND_OPTIONS.findIndex((o) => o.value === value);
    if (idx >= 0) lastCommandIndex = idx;
  }
  return value;
}

async function fallbackMainCommand(ask, totalWidth) {
  for (const line of renderCommandList(totalWidth)) console.log(line);
  return await ask("> ");
}

function makeAsk(rl) {
  let closed = false;
  const waiters = [];
  rl.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter("");
    }
  });
  return (prompt) =>
    new Promise((resolve) => {
      if (closed) {
        resolve("");
        return;
      }
      waiters.push(resolve);
      rl.question(prompt, (answer) => {
        const idx = waiters.indexOf(resolve);
        if (idx >= 0) {
          waiters.splice(idx, 1);
        }
        resolve(answer ?? "");
      });
    });
}

// 包装 ask 支持中途取消：输入 q（trim 后）抛 CancelledError。
// keepBlank=true（默认，可留空字段）：空回车返回 ""；keepBlank=false（必填字段）：空回车也取消。
// 用于 createProvider 等多步文本输入流程，让用户中途能退出而不必填完全部信息。
async function askCancelable(ask, prompt, { keepBlank = true } = {}) {
  const answer = (await ask(prompt)).trim();
  if (answer.toLowerCase() === "q") {
    throw new CancelledError();
  }
  if (!keepBlank && answer === "") {
    throw new CancelledError();
  }
  return answer;
}

async function pickOption(ask, message, options) {
  if (!options || options.length === 0) {
    console.log(`\n${message}`);
    console.log("(无可用选项)");
    await ask("按回车返回... ");
    return null;
  }
  // 方向键高亮选择（raw mode，单列：上下/左右移动选中、回车确认、Esc/q 取消、数字跳转高亮）。
  // 非 TTY 或 LLM_CLI_NO_KEYSELECT=1 时 onFallback 走原数字模式。
  // 对外签名 (ask, message, options) => value|null 不变：取消 -> null。
  return selectValue(globalRl, message, options, {
    layout: "single",
    cancelOnEsc: true,
    cancelOnQ: true,
    onFallback: () => fallbackPickOptionByNumber(ask, message, options),
  });
}

function fetchProviders(config) {
  return Object.values(config.providers || {});
}

async function refreshConfig() {
  return api("/config");
}

async function pickProvider(ask, config, message = "选择 Provider：") {
  const providers = fetchProviders(config);
  if (providers.length === 0) throw new Error("还没有 Provider，请先 1 新建");
  return pickOption(
    ask,
    message,
    providers.map((p) => ({ label: `${p.name} (${p.id})`, value: p })),
  );
}

async function createProviderFlow(ask, pushLog) {
  const name = await askCancelable(ask, "\nProvider 名称（如 GLM、Kimi、DeepSeek，q 取消）: ", { keepBlank: false });
  const baseUrl = await askCancelable(ask, "Base URL（可留空，q 取消）: ", { keepBlank: true });
  let baseUrlNote = "";
  if (baseUrl) {
    baseUrlNote = await askCancelable(ask, "Base URL 备注（可留空，q 取消）: ", { keepBlank: true });
  }
  const apiKey = await askCancelable(ask, "API Key（可留空，q 取消）: ", { keepBlank: true });
  let keyNote = "";
  if (apiKey) {
    keyNote = await askCancelable(ask, "API Key 备注（可留空，q 取消）: ", { keepBlank: true });
  }

  const body = { name };
  if (baseUrl) {
    body.baseUrl = baseUrl;
    body.baseUrlNote = baseUrlNote;
  }
  if (apiKey) {
    body.apiKey = apiKey;
    body.keyNote = keyNote;
  }

  const result = await api("/providers", { method: "POST", body });
  pushLog(`已新建 Provider ${result.provider.id} (${result.provider.name})`);
}

async function addBaseUrlFlow(ask, pushLog) {
  const config = await refreshConfig();
  const provider = await pickProvider(ask, config);
  if (!provider) throw new CancelledError();

  const url = await askCancelable(ask, "\nBase URL（q 取消）: ", { keepBlank: false });
  const note = await askCancelable(ask, "备注（可留空，q 取消）: ", { keepBlank: true });

  const result = await api(`/providers/${encodeURIComponent(provider.id)}/baseUrls`, {
    method: "POST",
    body: { url, note },
  });
  pushLog(`已为 ${provider.id} 添加 BaseUrl (${result.baseUrl.note || "default"})`);
}

async function updateBaseUrlFlow(ask, pushLog) {
  const config = await refreshConfig();
  const provider = await pickProvider(ask, config);
  if (!provider) throw new CancelledError();
  if (!provider.baseUrls?.length) throw new Error(`Provider ${provider.id} 没有 BaseUrl`);

  const baseUrl = await pickOption(
    ask,
    "选择要修改的 BaseUrl：",
    provider.baseUrls.map((b) => ({
      label: `${b.note || "(无备注)"} -> ${b.url}`,
      value: b,
    })),
  );
  if (!baseUrl) throw new CancelledError();

  console.log(`\n当前 URL: ${baseUrl.url}`);
  console.log(`当前备注: ${baseUrl.note || "(无)"}`);
  const url = await askCancelable(ask, "新 URL（可留空保持不变，q 取消）: ", { keepBlank: true });
  const note = await askCancelable(ask, "新备注（可留空保持不变，q 取消）: ", { keepBlank: true });

  const body = {};
  if (url) body.url = url;
  if (note) body.note = note;
  if (Object.keys(body).length === 0) {
    pushLog("未输入任何变更");
    return;
  }

  await api(`/providers/${encodeURIComponent(provider.id)}/baseUrls/${encodeURIComponent(baseUrl.id)}`, {
    method: "PATCH",
    body,
  });
  pushLog(`已修改 BaseUrl ${baseUrl.id}`);
}

async function deleteBaseUrlFlow(ask, pushLog) {
  const config = await refreshConfig();
  const provider = await pickProvider(ask, config);
  if (!provider) throw new CancelledError();
  if (!provider.baseUrls?.length) throw new Error(`Provider ${provider.id} 没有 BaseUrl`);

  const baseUrl = await pickOption(
    ask,
    "选择要删除的 BaseUrl：",
    provider.baseUrls.map((b) => ({
      label: `${b.note || "(无备注)"} -> ${b.url}`,
      value: b,
    })),
  );
  if (!baseUrl) throw new CancelledError();

  const confirm = (await ask(`\n确认删除 BaseUrl "${baseUrl.note || baseUrl.id}"? (y/N): `)).trim().toLowerCase();
  if (confirm !== "y") {
    pushLog("取消删除");
    return;
  }

  await api(`/providers/${encodeURIComponent(provider.id)}/baseUrls/${encodeURIComponent(baseUrl.id)}`, {
    method: "DELETE",
  });
  pushLog(`已删除 BaseUrl ${baseUrl.id}`);
}

async function addKeyFlow(ask, pushLog) {
  const config = await refreshConfig();
  const provider = await pickProvider(ask, config);
  if (!provider) throw new CancelledError();

  const token = await askCancelable(ask, "\nAPI Token（q 取消）: ", { keepBlank: false });
  const note = await askCancelable(ask, "备注（可留空，q 取消）: ", { keepBlank: true });

  await api(`/providers/${encodeURIComponent(provider.id)}/keys`, {
    method: "POST",
    body: { token, note },
  });
  pushLog(`已为 ${provider.id} 添加 Key (${note || "default"})`);
}

async function updateKeyFlow(ask, pushLog) {
  const config = await refreshConfig();
  const provider = await pickProvider(ask, config);
  if (!provider) throw new CancelledError();
  if (!provider.keys?.length) throw new Error(`Provider ${provider.id} 没有 Key`);

  const key = await pickOption(
    ask,
    "选择要修改的 Key：",
    provider.keys.map((k) => ({
      label: `${k.note || k.id} (token: ${k.token || "***"})`,
      value: k,
    })),
  );
  if (!key) throw new CancelledError();

  console.log(`\n当前备注: ${key.note || "(无)"}`);
  const token = await askCancelable(ask, "新 Token（可留空保持不变，q 取消）: ", { keepBlank: true });
  const note = await askCancelable(ask, "新备注（可留空保持不变，q 取消）: ", { keepBlank: true });

  const body = {};
  if (token) body.token = token;
  if (note) body.note = note;
  if (Object.keys(body).length === 0) {
    pushLog("未输入任何变更");
    return;
  }

  await api(`/providers/${encodeURIComponent(provider.id)}/keys/${encodeURIComponent(key.id)}`, {
    method: "PATCH",
    body,
  });
  pushLog(`已修改 Key ${key.id}`);
}

async function deleteKeyFlow(ask, pushLog) {
  const config = await refreshConfig();
  const provider = await pickProvider(ask, config);
  if (!provider) throw new CancelledError();
  if (!provider.keys?.length) throw new Error(`Provider ${provider.id} 没有 Key`);

  const key = await pickOption(
    ask,
    "选择要删除的 Key：",
    provider.keys.map((k) => ({
      label: `${k.note || k.id} (token: ${k.token || "***"})`,
      value: k,
    })),
  );
  if (!key) throw new CancelledError();

  const confirm = (await ask(`\n确认删除 Key "${key.note || key.id}"? (y/N): `)).trim().toLowerCase();
  if (confirm !== "y") {
    pushLog("取消删除");
    return;
  }

  await api(`/providers/${encodeURIComponent(provider.id)}/keys/${encodeURIComponent(key.id)}`, {
    method: "DELETE",
  });
  pushLog(`已删除 Key ${key.id}`);
}

async function addModelFlow(ask, pushLog) {
  const config = await refreshConfig();
  const provider = await pickProvider(ask, config);
  if (!provider) throw new CancelledError();

  const modelValue = await askCancelable(ask, "\n上游 Model 型号（如 glm-5.1，q 取消）: ", { keepBlank: false });
  const nameValue = await askCancelable(ask, "显示名称（可留空，默认与型号相同，q 取消）: ", { keepBlank: true });

  const result = await api(`/providers/${encodeURIComponent(provider.id)}/models`, {
    method: "POST",
    body: { model: modelValue, name: nameValue },
  });
  pushLog(`已为 ${provider.id} 添加 Model ${result.model.model} (${result.model.name})`);
}

async function updateModelFlow(ask, pushLog) {
  const config = await refreshConfig();
  const provider = await pickProvider(ask, config);
  if (!provider) throw new CancelledError();
  if (!provider.models?.length) throw new Error(`Provider ${provider.id} 没有 Model`);

  const model = await pickOption(
    ask,
    "选择要修改的 Model：",
    provider.models.map((m) => ({
      // 演示模式：隐藏括号里的真实上游型号，只显示显示名。
      // 需要恢复时——取消注释下面那行、并删掉紧随其后的 label 行即可。
      // label: `${m.name} (型号: ${m.model})`,
      label: `${m.name}`,
      value: m,
    })),
  );
  if (!model) throw new CancelledError();

  console.log(`\n当前型号: ${model.model}`);
  console.log(`当前名称: ${model.name}`);
  const modelValue = await askCancelable(ask, "新型号（可留空保持不变，q 取消）: ", { keepBlank: true });
  const nameValue = await askCancelable(ask, "新名称（可留空保持不变，q 取消）: ", { keepBlank: true });

  const body = {};
  if (modelValue) body.model = modelValue;
  if (nameValue) body.name = nameValue;
  if (Object.keys(body).length === 0) {
    pushLog("未输入任何变更");
    return;
  }

  await api(`/providers/${encodeURIComponent(provider.id)}/models/${encodeURIComponent(model.id)}`, {
    method: "PATCH",
    body,
  });
  pushLog(`已修改 Model ${model.id}`);
}

async function deleteModelFlow(ask, pushLog) {
  const config = await refreshConfig();
  const provider = await pickProvider(ask, config);
  if (!provider) throw new CancelledError();
  if (!provider.models?.length) throw new Error(`Provider ${provider.id} 没有 Model`);

  const model = await pickOption(
    ask,
    "选择要删除的 Model：",
    provider.models.map((m) => ({
      // 演示模式：隐藏括号里的真实上游型号，只显示显示名。
      // 需要恢复时——取消注释下面那行、并删掉紧随其后的 label 行即可。
      // label: `${m.name} (型号: ${m.model})`,
      label: `${m.name}`,
      value: m,
    })),
  );
  if (!model) throw new CancelledError();

  const confirm = (await ask(`\n确认删除 Model "${model.name}"? (y/N): `)).trim().toLowerCase();
  if (confirm !== "y") {
    pushLog("取消删除");
    return;
  }

  await api(`/providers/${encodeURIComponent(provider.id)}/models/${encodeURIComponent(model.id)}`, {
    method: "DELETE",
  });
  pushLog(`已删除 Model ${model.id}`);
}

// 子菜单通用入口：1=新增 2=修改 3=删除 0=返回。
// 方向键高亮选择（inline 单行横排，左=上/右=下一维导航）+ 数字热键即时；Esc/q=返回；非 TTY 降级数字模式。
async function manageResourceSubmenu(ask, pushLog, title, { add, update, remove }) {
  const MENU = [
    { label: "1=新增", value: "add" },
    { label: "2=修改", value: "update" },
    { label: "3=删除", value: "remove" },
    { label: "0=返回", value: "back" },
  ];
  while (true) {
    let action;
    try {
      action = await selectValue(globalRl, title, MENU, {
        layout: "inline",
        cancelOnEsc: true,
        cancelOnQ: true,
        hotkeys: {
          "1": { value: "add" },
          "2": { value: "update" },
          "3": { value: "remove" },
          "0": { value: "back" },
        },
        onFallback: async () => {
          console.log(`\n=== ${title} ===`);
          console.log("1=新增  2=修改  3=删除  0=返回");
          const a = (await ask("> ")).trim().toLowerCase();
          if (a === "1") return { value: "add", cancelled: false };
          if (a === "2") return { value: "update", cancelled: false };
          if (a === "3") return { value: "remove", cancelled: false };
          if (a === "0" || a === "" || a === "q") return { value: null, cancelled: true };
          pushLog(`未知命令: ${a}`);
          return { value: "noop", cancelled: false };
        },
      });
    } catch (err) {
      if (err instanceof CancelledError) pushLog("已取消");
      else pushLog(`错误: ${err.message}`);
      continue;
    }
    if (!action || action === "back") return;
    if (action === "noop") continue;
    try {
      if (action === "add") await add(ask, pushLog);
      else if (action === "update") await update(ask, pushLog);
      else if (action === "remove") await remove(ask, pushLog);
    } catch (err) {
      if (err instanceof CancelledError) pushLog("已取消");
      else pushLog(`错误: ${err.message}`);
    }
  }
}

async function manageBaseUrlsFlow(ask, pushLog) {
  return manageResourceSubmenu(ask, pushLog, "BaseUrl 管理", {
    add: addBaseUrlFlow,
    update: updateBaseUrlFlow,
    remove: deleteBaseUrlFlow,
  });
}

async function manageKeysFlow(ask, pushLog) {
  return manageResourceSubmenu(ask, pushLog, "Key 管理", {
    add: addKeyFlow,
    update: updateKeyFlow,
    remove: deleteKeyFlow,
  });
}

async function manageModelsFlow(ask, pushLog) {
  return manageResourceSubmenu(ask, pushLog, "Model 管理", {
    add: addModelFlow,
    update: updateModelFlow,
    remove: deleteModelFlow,
  });
}

async function deleteProviderFlow(ask, pushLog) {
  const config = await refreshConfig();
  const provider = await pickProvider(ask, config, "选择要删除的 Provider：");
  if (!provider) throw new CancelledError();

  const confirm = (await ask(`\n确认删除 ${provider.name}? (y/N): `)).trim().toLowerCase();
  if (confirm !== "y") {
    pushLog("取消删除");
    return;
  }

  await api(`/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
  pushLog(`已删除 Provider ${provider.id}`);
}

// 把单个候选四元组显示成可读标签（provider · model · baseUrl · key）
function describeCandidate(config, quad) {
  const p = config.providers?.[quad?.providerId];
  if (!p) return `(失效 ${quad?.providerId || "?"})`;
  const b = p.baseUrls?.find((x) => x.id === quad.baseUrlId);
  const m = p.models?.find((x) => x.id === quad.modelId);
  const k = p.keys?.find((x) => x.id === quad.keyId);
  return [p.name, m?.name || m?.model || "?", b?.note || b?.url || "?", k?.note || k?.id || "?"].join(" · ");
}

// 熔断/TTFB 参数配置子流程。
// current: 该 family 当前的 circuitBreaker 对象（null = 用全局默认）。
// 返回 circuitBreaker 对象（null = 清除覆盖，用全局默认）。
// 逐项询问，回车=保持当前值/全局默认，输入数字=覆盖；非法输入提示重试。
async function editBreakerConfig(ask, current) {
  const fields = [
    { key: "ttfbTimeoutMs", label: "TTFB 超时", unit: "毫秒", hint: "首字节超时，大上下文冷缓存建议 30000+" },
    { key: "failureThreshold", label: "失败阈值", unit: "次", hint: "连续失败几次后熔断" },
    { key: "coolDownMs", label: "冷却时长", unit: "毫秒", hint: "熔断后多久尝试恢复" },
    { key: "successThreshold", label: "恢复成功数", unit: "次", hint: "HALF_OPEN 连续成功几次后恢复" },
  ];

  const result = {};
  console.log("\n--- 熔断/TTFB 配置 ---");
  console.log("（每项回车=保持当前值；全部回车=清除 family 覆盖，用全局默认；输入 q 取消）");

  for (const f of fields) {
    const fallback = CIRCUIT_BREAKER_DEFAULTS[f.key];
    const existing = (current && typeof current[f.key] === "number") ? current[f.key] : fallback;
    while (true) {
      const raw = await askCancelable(ask, `${f.label} [${f.unit}]（当前 ${existing}，默认 ${fallback}）${f.hint ? ` ${f.hint}` : ""}: `);
      if (raw === "") {
        // 空输入：用当前值
        result[f.key] = existing;
        break;
      }
      const num = Number(raw);
      if (!Number.isFinite(num) || num <= 0) {
        console.log(`  无效值「${raw}」，请输入正数或回车保持。`);
        continue;
      }
      result[f.key] = num;
      break;
    }
  }

  // 判断结果是否和全局默认一致——一致就返回 null（不留无意义的覆盖）
  const allDefault = fields.every((f) => result[f.key] === CIRCUIT_BREAKER_DEFAULTS[f.key]);
  if (allDefault) {
    console.log("（所有值与全局默认一致，不保留 family 覆盖）");
    return null;
  }
  return result;
}

// 选 provider -> baseUrl -> key -> model，返回四元组或 null（取消）。
async function pickCandidateQuad(ask, config) {
  const provider = await pickProvider(ask, config);
  if (!provider) return null;

  if (!provider.baseUrls || provider.baseUrls.length === 0) {
    throw new Error(`Provider ${provider.id} 还没有 BaseUrl，请先 2 添加`);
  }
  const baseUrl = await pickOption(
    ask,
    "选择 BaseUrl：",
    provider.baseUrls.map((b) => ({ label: `${b.note || "(无备注)"} -> ${b.url}`, value: b })),
  );
  if (!baseUrl) return null;

  if (!provider.keys || provider.keys.length === 0) {
    throw new Error(`Provider ${provider.id} 还没有 Key，请先 3 添加`);
  }
  const key = await pickOption(
    ask,
    "选择 Key：",
    provider.keys.map((k) => ({ label: `${k.note || k.id} (token: ${k.token || "***"})`, value: k })),
  );
  if (!key) return null;

  if (!provider.models || provider.models.length === 0) {
    throw new Error(`Provider ${provider.id} 还没有 Model，请先 4 添加`);
  }
  const model = await pickOption(
    ask,
    "选择 Model：",
    provider.models.map((m) => ({ label: `${m.name}`, value: m })),
  );
  if (!model) return null;

  return { providerId: provider.id, baseUrlId: baseUrl.id, keyId: key.id, modelId: model.id };
}

async function switchFamilyFlow(ask, pushLog) {
  const config = await refreshConfig();
  const family = await pickOption(
    ask,
    "选择要配置的 Claude 模型族：",
    FAMILY_ORDER.map((name) => ({ label: name, value: name })),
  );
  if (!family) throw new CancelledError();

  const rawBinding = config.modelFamilies?.[family] || {};
  // 兼容新旧形态：新 {candidates,strategy} 与旧单四元组
  let candidates;
  if (Array.isArray(rawBinding.candidates)) {
    candidates = rawBinding.candidates.filter(
      (c) => c && (c.providerId || c.baseUrlId || c.keyId || c.modelId),
    );
  } else if (rawBinding.providerId || rawBinding.modelId) {
    candidates = [rawBinding];
  } else {
    candidates = [];
  }
  let strategy = ["failover", "round_robin", "weighted"].includes(rawBinding.strategy)
    ? rawBinding.strategy
    : "failover";
  // circuitBreaker 覆盖：编辑期间存本地变量，保存时随 PUT 一起提交。
  let breakerConfig = rawBinding.circuitBreaker ?? null;

  const STRATEGY_OPTIONS = ["failover", "round_robin", "weighted"].map((s) => ({ label: s, value: s }));

  // 候选列表编辑子菜单
  while (true) {
    const breakerLabel = breakerConfig
      ? `TTFB ${breakerConfig.ttfbTimeoutMs ?? "?"}ms`
      : "全局默认";
    console.log(`\n===== ${family} 候选列表（策略: ${strategy} | 熔断: ${breakerLabel}）=====`);
    if (candidates.length === 0) {
      console.log("(空 —— 需追加候选)");
    }
    candidates.forEach((c, i) => {
      console.log(`  ${i === 0 ? "[主]" : ` ${i}.`}  ${describeCandidate(config, c)}`);
    });

    const action = await pickOption(ask, "\n操作：", [
      { label: "追加候选", value: "add" },
      { label: "删除候选", value: "del" },
      { label: "设为主候选（置顶）", value: "promote" },
      { label: `切换策略（当前 ${strategy}）`, value: "strategy" },
      { label: `熔断/TTFB 配置（当前 ${breakerLabel}）`, value: "breaker" },
      { label: "保存并返回", value: "save" },
      { label: "放弃返回", value: "cancel" },
    ]);

    if (!action || action === "cancel") {
      pushLog(`取消编辑 ${family}`);
      return;
    }
    if (action === "save") break;
    if (action === "add") {
      const quad = await pickCandidateQuad(ask, config);
      if (quad) candidates.push(quad);
      continue;
    }
    if (action === "strategy") {
      const next = await pickOption(ask, "选择策略：", STRATEGY_OPTIONS);
      if (next) strategy = next;
      continue;
    }
    if (action === "breaker") {
      breakerConfig = await editBreakerConfig(ask, breakerConfig);
      continue;
    }
    if (candidates.length === 0) {
      console.log("(列表为空，无可操作候选)");
      continue;
    }
    // del / promote 需先选一个候选
    const idx = await pickOption(
      ask,
      "选择候选：",
      candidates.map((c, i) => ({
        label: `${i}${i === 0 ? " (主)" : ""}  ${describeCandidate(config, c)}`,
        value: i,
      })),
    );
    if (idx === null || idx === undefined) continue;
    if (action === "del") {
      candidates.splice(idx, 1);
    } else if (action === "promote" && idx > 0) {
      const [moved] = candidates.splice(idx, 1);
      candidates.unshift(moved);
    }
  }

  await api(`/families/${encodeURIComponent(family)}/candidates`, {
    method: "PUT",
    body: { candidates, strategy, circuitBreaker: breakerConfig },
  });
  pushLog(`已保存 ${family}：${candidates.length} 个候选，策略 ${strategy}`);
}

async function viewHistoryFlow(ask, pushLog) {
  const data = await api("/history");
  const history = data.history || [];
  console.log("\n===== 切换历史 =====");
  if (history.length === 0) {
    console.log("(暂无)");
  } else {
    for (const h of history) {
      console.log(`[${h.ts}] ${h.family} | ${h.from || "(空)"} -> ${h.to || "(空)"} | source=${h.source || "unknown"}`);
    }
  }
  console.log("===================");
  await ask("\n按回车返回... ");
  pushLog(`查看历史（${history.length} 条）`);
}

// 用量统计视图：支持切换时间范围（今日/7天/30天），展示 token 趋势 sparkline、
// 按 family / provider 分布柱状图、输入/输出/缓存构成。参考 viewLogsLiveFlow 的按键退出模式。
async function viewUsageFlow(ask, pushLog) {
  const RANGE_OPTIONS = [
    { label: "今日", value: "today" },
    { label: "7天", value: "7d" },
    { label: "30天", value: "30d" },
  ];

  let currentRange = "today";

  while (true) {
    let data;
    try {
      data = await api(`/usage/${currentRange}`);
    } catch (err) {
      console.log(`\n获取用量失败: ${err.message}`);
      await ask("按回车返回... ");
      pushLog(`查看用量失败: ${err.message}`);
      return;
    }

    fullClear();
    const totalWidth = terminalWidth();
    const rangeLabel = RANGE_OPTIONS.find((r) => r.value === currentRange)?.label || currentRange;
    const lines = [];

    lines.push(`范围: ${rangeLabel}    总计 ${formatTokens(data.totals.total)} · 请求 ${data.totals.reqs} 次 · 错误 ${data.totals.errors}`);
    lines.push("");

    // —— 时间趋势 sparkline ——
    const spark = sparkline(data.timeBuckets);
    if (spark) {
      lines.push(`Token 趋势（${currentRange === "today" ? "每小时" : "每天"}）`);
      lines.push(`  ${spark}`);
      if (data.peak > 0) {
        lines.push(`  峰值 ${formatTokens(data.peak)} @ ${data.peakLabel}`);
      }
    } else {
      lines.push("Token 趋势: (暂无数据)");
    }
    lines.push("");

    // —— 按 Family 分布 ——
    const familyEntries = Object.entries(data.byFamily).sort((a, b) => b[1].tokens - a[1].tokens);
    if (familyEntries.length > 0) {
      const maxFamTokens = familyEntries[0][1].tokens;
      const famBarWidth = 20;
      lines.push("按 Family 分布");
      for (const [fam, info] of familyEntries) {
        const { bar } = barLine(fam, info.tokens, maxFamTokens, famBarWidth);
        const pct = data.totals.total > 0 ? ((info.tokens / data.totals.total) * 100).toFixed(0) : 0;
        lines.push(`  ${padEnd(fam, 12)} ${bar} ${formatTokens(info.tokens)} (${pct}%, ${info.reqs}次)`);
      }
    } else {
      lines.push("按 Family 分布: (暂无数据)");
    }
    lines.push("");

    // —— 按 Provider 分布 ——
    const providerEntries = Object.entries(data.byProvider).sort((a, b) => b[1].tokens - a[1].tokens);
    if (providerEntries.length > 0) {
      const maxProvTokens = providerEntries[0][1].tokens;
      const provBarWidth = 20;
      lines.push("按 Provider 分布");
      for (const [prov, info] of providerEntries) {
        const { bar } = barLine(prov, info.tokens, maxProvTokens, provBarWidth);
        lines.push(`  ${padEnd(prov, 14)} ${bar} ${formatTokens(info.tokens)} (${info.reqs}次)`);
      }
    }
    lines.push("");

    // —— 输入/输出/缓存构成 ——
    const compItems = [
      { label: "输入", value: data.totals.in },
      { label: "输出", value: data.totals.out },
      { label: "缓存读", value: data.totals.cacheR },
      { label: "缓存写", value: data.totals.cacheW },
    ];
    const maxComp = Math.max(1, ...compItems.map((c) => c.value));
    const compBarWidth = 24;
    lines.push("输入/输出/缓存 构成");
    for (const { label, value } of compItems) {
      const { bar } = barLine(label, value, maxComp, compBarWidth);
      lines.push(`  ${padEnd(label, 6)} ${bar} ${formatTokens(value)}`);
    }

    const footer = `[1]今日 [2]7天 [3]30天 切换范围 · q/Esc/回车 返回`;
    const body = renderBox("用量统计", lines, { footer, width: totalWidth });
    console.log(body);

    // 等待按键选择下一个操作
    const action = await pickOption(ask, "\n操作：", [
      { label: "切换到 今日", value: "today" },
      { label: "切换到 7天", value: "7d" },
      { label: "切换到 30天", value: "30d" },
      { label: "返回主界面", value: "back" },
    ]);

    if (!action || action === "back") {
      pushLog(`查看用量（${rangeLabel}）`);
      return;
    }
    currentRange = action;
  }
}

// 实时日志视图：清屏后只显示日志，每秒重新拉取最近 50 条；按 q/Ctrl-C/Esc 返回。
// 关键约束：**不能调用 rl.pause()**——readline 的 pause 会让 stdin 进入 paused 状态，
// 不再 emit 'data'/'keypress'，导致按键无响应。改成不 pause，让 readline 和我们的
// keypress listener 同时触发；cleanup 时清空 readline 的 line buffer（readline 在
// 监听 keypress 时已经把按键 buffer 到 rl.line，下次 ask 会拿到残留）。
async function viewLogsLiveFlow(rl, pushLog) {
  const stdin = process.stdin;
  const canRaw = typeof stdin.setRawMode === "function";
  const wasRaw = canRaw ? stdin.isRaw : false;

  return new Promise((resolve) => {
    let stopped = false;
    let interval;
    let renderedOnce = false;

    const render = () => {
      if (stopped) return;
      // renderedOnce 必须在 try 之前设，否则首次 render 抛错会永远不响应退出按键
      renderedOnce = true;
      try {
        fullClear();
        const recent = getRecentLogs(50);
        console.log("===== 实时网关日志（最近 50 条，每秒刷新）=====");
        if (recent.length === 0) {
          console.log("(暂无日志)");
        } else {
          for (const line of recent) console.log(line);
        }
        console.log("=".repeat(40));
        console.log("[按 q / Ctrl-C / Esc 返回主界面]");
      } catch {}
    };

    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      stdin.removeListener("keypress", onKey);
      if (canRaw) {
        try { stdin.setRawMode(wasRaw); } catch {}
      }
      // 清空 readline 在 keypress 期间 buffer 的按键，避免下次 ask 拿到 "q" 残留
      try {
        rl.line = "";
        rl.cursor = 0;
      } catch {}
      resolve();
    };

    const onKey = (str, key) => {
      if (stopped || !renderedOnce) return;
      const seq = (key && key.sequence) || str || "";
      const name = key && key.name;
      const code = seq ? seq.charCodeAt(0) : 0;
      const isQ = seq === "q" || seq === "Q";
      const isEsc = code === 0x1b || name === "escape";
      const isCtrlC = code === 0x03 || (key && key.ctrl && name === "c");
      if (isQ || isEsc || isCtrlC) {
        cleanup();
      }
    };

    if (canRaw) {
      try { stdin.setRawMode(true); } catch {}
    }
    stdin.on("keypress", onKey);

    render();
    interval = setInterval(render, 1000);
  }).finally(() => {
    pushLog("退出实时日志视图");
  });
}

function timestampForFile(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

// 真正的文件导出：默认写到 ./data/export/gateway-<timestamp>.json，
// 用户也可以输入绝对/相对路径覆盖（包含分隔符或 .json 后缀视为文件路径，否则视为目录）。
async function exportConfigFlow(ask, pushLog) {
  const config = await refreshConfig();
  const defaultPath = path.join(EXPORT_DEFAULT_DIR, `gateway-${timestampForFile()}.json`);
  console.log(`\n默认导出路径: ${defaultPath}`);
  const input = await askCancelable(ask, "导出路径（回车=默认，q 取消）: ", { keepBlank: true });

  let targetPath;
  if (input === "" ) {
    targetPath = defaultPath;
  } else if (input.endsWith(path.sep) || input.endsWith("/") || input.endsWith("\\")) {
    targetPath = path.join(input, `gateway-${timestampForFile()}.json`);
  } else if (input.includes(path.sep) || input.includes("/") || input.includes("\\") || input.endsWith(".json")) {
    targetPath = input;
  } else {
    // 短名字当目录
    targetPath = path.join(input, `gateway-${timestampForFile()}.json`);
  }

  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
  } catch (err) {
    throw new Error(`创建目录失败: ${err.message}`);
  }

  const json = JSON.stringify(config, null, 2);
  try {
    await writeFile(targetPath, json, "utf8");
  } catch (err) {
    throw new Error(`写入文件失败: ${err.message}`);
  }

  console.log(`\n已导出到: ${targetPath}（${json.length} 字节）`);
  pushLog(`导出配置到 ${targetPath}`);
  await ask("按回车返回... ");
}

async function changePortFlow(ask, pushLog, runtime) {
  const input = await askCancelable(ask, "\n新的监听端口（1-65535，q 取消）: ", { keepBlank: false });
  const port = Number.parseInt(input, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error("端口不合法（1-65535）");
  }
  const currentPort = runtime ? runtime.getPort() : null;
  if (currentPort === port) {
    pushLog(`端口已是 ${port}，无变化`);
    return;
  }

  const probe = await api("/runtime/port/probe", {
    method: "POST",
    body: { port },
  });
  if (!probe.free) {
    const occ = probe.occupant || {};
    console.log(`端口 ${port} 已被占用`);
    if (occ.pid) {
      console.log(`占用进程: PID=${occ.pid} name=${occ.name || "?"}${occ.cmdline ? " cmd=" + occ.cmdline : ""}`);
    }
    const answer = (await ask("是否杀掉占用进程并继续？(y/N): ")).trim().toLowerCase();
    if (answer !== "y") {
      pushLog("取消切换端口");
      return;
    }
  }

  // V5.1 §5.3：事务式 PATCH。失败时如果服务端带 details 透出当前 runtimePort/persistedPort，
  // 明确打印帮助用户判断"实际监听在哪个端口"。
  try {
    await api("/runtime/port", {
      method: "PATCH",
      body: { port, killIfOccupied: !probe.free },
    });
  } catch (err) {
    const details = err?.payload?.error?.details;
    let extra = "";
    if (details && typeof details === "object") {
      const bits = [];
      if (details.runtimePort) bits.push(`runtimePort=${details.runtimePort}`);
      if (details.persistedPort) bits.push(`persistedPort=${details.persistedPort}`);
      if (details.saveError) bits.push(`saveError=${details.saveError}`);
      if (details.commitError) bits.push(`commitError=${details.commitError}`);
      if (bits.length) extra = ` [${bits.join(", ")}]`;
    }
    throw new Error(`切换端口失败（旧端口仍可用）: ${err.message}${extra}`);
  }

  if (runtime) {
    setGatewayUrl(runtime.getBaseUrl());
  }
  pushLog(`已切换监听端口 -> ${port}`);
}

async function handleCommand(cmd, ctx) {
  const { ask, pushLog, runtime, rl } = ctx;
  switch (cmd) {
    case "1":
      await createProviderFlow(ask, pushLog);
      return null;
    case "2":
      await manageBaseUrlsFlow(ask, pushLog);
      return null;
    case "3":
      await manageKeysFlow(ask, pushLog);
      return null;
    case "4":
      await manageModelsFlow(ask, pushLog);
      return null;
    case "5":
      await switchFamilyFlow(ask, pushLog);
      return null;
    case "6":
      await changePortFlow(ask, pushLog, runtime);
      return null;
    case "7":
      await viewHistoryFlow(ask, pushLog);
      return null;
    case "8":
      await viewLogsLiveFlow(rl, pushLog);
      return null;
    case "u":
      await viewUsageFlow(ask, pushLog);
      return null;
    case "9":
      await exportConfigFlow(ask, pushLog);
      return null;
    case "0":
      await deleteProviderFlow(ask, pushLog);
      return null;
    case "r":
    case "refresh":
      pushLog("手动刷新");
      return null;
    case "q":
    case "quit":
    case "exit":
      return "exit";
    case "":
      return null;
    default:
      pushLog(`未知命令: ${cmd}`);
      return null;
  }
}

export async function startCli({ config, runtime }) {
  if (runtime) {
    setGatewayUrl(runtime.getBaseUrl());
  }
  setAdminToken(config?.gateway?.adminToken);

  // 关闭 gateway 日志的 stdout 打印：CLI 主循环 await ask() 期间，gateway 仍会
  // 并发处理请求并调用 logRequest 等。打开 suppress 后这些日志只进 buffer，
  // 不再抢屏主界面；按 8 进入实时日志视图仍可看到全部内容。
  setSuppressConsole(true);

  const cliLogs = [];
  function pushLog(msg) {
    const ts = new Date().toISOString().slice(11, 19);
    cliLogs.push(`[${ts}] ${msg}`);
    while (cliLogs.length > CLI_LOG_LIMIT) {
      cliLogs.shift();
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  globalRl = rl;
  const ask = makeAsk(rl);

  pushLog("CLI 就绪，输入命令后回车");

  let running = true;
  let lastOpResult = null; // null=就绪 / "ok" / "error"
  let lastOpError = null;
  // V5.1 §5.2：UI 渲染不依赖 errorBus；事件总线保留以备未来扩展。
  // footer 直接读 getLastUpstreamError(60000) 状态快照，60s 窗口过期自然回落。
  // 不主动重绘（避免 ask() 抢屏），等用户按下一个键自然刷新。

  while (running) {
    let liveConfig;
    let configError = null;
    try {
      liveConfig = await refreshConfig();
    } catch (err) {
      liveConfig = config;
      configError = err.message;
    }

    // 状态快照：每次重绘都直接读 60s 窗口内的最近一次上游异常。
    const upstreamError = getLastUpstreamError(60000);

    const statusLine = computeStatusLine({
      configError,
      upstreamError,
      lastOpResult,
      lastOpError,
    });

    renderHome({
      config: liveConfig,
      runtime,
      statusLine,
    });

    const cmd = await awaitCommandPanel(ask, terminalWidth());
    try {
      const result = await handleCommand(cmd == null ? "" : cmd.trim(), { ask, pushLog, runtime, rl });
      if (result === "exit") {
        running = false;
      }
      // cmd 为 null（Esc/Ctrl-C 取消）不记为"成功"，避免覆盖错误态
      if (cmd == null) {
        lastOpResult = null;
        lastOpError = null;
      } else {
        lastOpResult = "ok";
        lastOpError = null;
      }
    } catch (err) {
      if (err instanceof CancelledError) {
        pushLog("已取消");
        lastOpResult = null;
        lastOpError = null;
      } else {
        pushLog(`错误: ${err.message}`);
        lastOpResult = "error";
        lastOpError = err.message;
      }
      try {
        if (process.stdin.isTTY
            && typeof process.stdin.setRawMode === "function"
            && process.stdin.isRaw) {
          process.stdin.setRawMode(false);
        }
      } catch {}
    }
  }

  console.log("\n再见。");
  rl.close();
}
