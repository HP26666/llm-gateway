import readline from "node:readline";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FAMILY_ORDER, getLastUpstreamError, getRecentLogs, setSuppressConsole } from "./route-utils.mjs";

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

function setGatewayUrl(url) {
  gatewayUrl = String(url || gatewayUrl);
}

function getGatewayUrl() {
  return gatewayUrl;
}

async function api(path, options = {}) {
  const init = {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Source": "cli",
      ...(options.headers || {}),
    },
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

function describeRouteLabel(config, binding) {
  if (!binding || !binding.providerId || !binding.baseUrlId || !binding.modelId || !binding.keyId) {
    return "(未配置)";
  }
  const provider = config.providers?.[binding.providerId];
  if (!provider) {
    return "(配置已失效)";
  }
  const baseUrl = provider.baseUrls?.find((b) => b.id === binding.baseUrlId);
  const model = provider.models?.find((m) => m.id === binding.modelId);
  const key = provider.keys?.find((k) => k.id === binding.keyId);
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

// 命令面板：所有命令按视觉宽度对齐成多列；列数随终端宽度自适应。
function renderCommandList(totalWidth) {
  const commands = [
    "1=新建Provider", "2=BaseUrl", "3=Key", "4=Model",
    "5=切换Family", "6=修改端口", "7=历史", "8=日志",
    "9=导出", "0=删除Provider", "r=刷新", "q=退出",
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
  console.log("");
  for (const line of renderCommandList(totalWidth)) {
    console.log(line);
  }
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

async function pickOption(ask, message, options) {
  console.log(`\n${message}`);
  if (!options || options.length === 0) {
    console.log("(无可用选项)");
    await ask("按回车返回... ");
    return null;
  }
  options.forEach((option, index) => {
    console.log(`  [${index + 1}] ${option.label}`);
  });
  const answer = await ask("> ");
  const trimmed = answer.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "q") {
    return null;
  }
  const idx = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(idx) || idx < 1 || idx > options.length) {
    throw new Error("无效的选项");
  }
  return options[idx - 1].value;
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
  const name = (await ask("\nProvider 名称（如 GLM、Kimi、DeepSeek）: ")).trim();
  if (!name) throw new Error("已取消");
  const baseUrl = (await ask("Base URL（可留空，稍后通过 2 添加）: ")).trim();
  let baseUrlNote = "";
  if (baseUrl) {
    baseUrlNote = (await ask("Base URL 备注（可留空）: ")).trim();
  }
  const apiKey = (await ask("API Key（可留空）: ")).trim();
  let keyNote = "";
  if (apiKey) {
    keyNote = (await ask("API Key 备注（可留空）: ")).trim();
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
  if (!provider) throw new Error("已取消");

  const url = (await ask("\nBase URL: ")).trim();
  if (!url) throw new Error("已取消");
  const note = (await ask("备注（可留空）: ")).trim();

  const result = await api(`/providers/${encodeURIComponent(provider.id)}/baseUrls`, {
    method: "POST",
    body: { url, note },
  });
  pushLog(`已为 ${provider.id} 添加 BaseUrl (${result.baseUrl.note || "default"})`);
}

async function updateBaseUrlFlow(ask, pushLog) {
  const config = await refreshConfig();
  const provider = await pickProvider(ask, config);
  if (!provider) throw new Error("已取消");
  if (!provider.baseUrls?.length) throw new Error(`Provider ${provider.id} 没有 BaseUrl`);

  const baseUrl = await pickOption(
    ask,
    "选择要修改的 BaseUrl：",
    provider.baseUrls.map((b) => ({
      label: `${b.note || "(无备注)"} -> ${b.url}`,
      value: b,
    })),
  );
  if (!baseUrl) throw new Error("已取消");

  console.log(`\n当前 URL: ${baseUrl.url}`);
  console.log(`当前备注: ${baseUrl.note || "(无)"}`);
  const url = (await ask("新 URL（可留空保持不变）: ")).trim();
  const note = (await ask("新备注（可留空保持不变）: ")).trim();

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
  if (!provider) throw new Error("已取消");
  if (!provider.baseUrls?.length) throw new Error(`Provider ${provider.id} 没有 BaseUrl`);

  const baseUrl = await pickOption(
    ask,
    "选择要删除的 BaseUrl：",
    provider.baseUrls.map((b) => ({
      label: `${b.note || "(无备注)"} -> ${b.url}`,
      value: b,
    })),
  );
  if (!baseUrl) throw new Error("已取消");

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
  if (!provider) throw new Error("已取消");

  const token = (await ask("\nAPI Token: ")).trim();
  if (!token) throw new Error("已取消");
  const note = (await ask("备注（可留空）: ")).trim();

  await api(`/providers/${encodeURIComponent(provider.id)}/keys`, {
    method: "POST",
    body: { token, note },
  });
  pushLog(`已为 ${provider.id} 添加 Key (${note || "default"})`);
}

async function updateKeyFlow(ask, pushLog) {
  const config = await refreshConfig();
  const provider = await pickProvider(ask, config);
  if (!provider) throw new Error("已取消");
  if (!provider.keys?.length) throw new Error(`Provider ${provider.id} 没有 Key`);

  const key = await pickOption(
    ask,
    "选择要修改的 Key：",
    provider.keys.map((k) => ({
      label: `${k.note || k.id} (token: ${k.token || "***"})`,
      value: k,
    })),
  );
  if (!key) throw new Error("已取消");

  console.log(`\n当前备注: ${key.note || "(无)"}`);
  const token = (await ask("新 Token（可留空保持不变）: ")).trim();
  const note = (await ask("新备注（可留空保持不变）: ")).trim();

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
  if (!provider) throw new Error("已取消");
  if (!provider.keys?.length) throw new Error(`Provider ${provider.id} 没有 Key`);

  const key = await pickOption(
    ask,
    "选择要删除的 Key：",
    provider.keys.map((k) => ({
      label: `${k.note || k.id} (token: ${k.token || "***"})`,
      value: k,
    })),
  );
  if (!key) throw new Error("已取消");

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
  if (!provider) throw new Error("已取消");

  const modelValue = (await ask("\n上游 Model 型号（如 glm-5.1）: ")).trim();
  if (!modelValue) throw new Error("已取消");
  const nameValue = (await ask("显示名称（可留空，默认与型号相同）: ")).trim();

  const result = await api(`/providers/${encodeURIComponent(provider.id)}/models`, {
    method: "POST",
    body: { model: modelValue, name: nameValue },
  });
  pushLog(`已为 ${provider.id} 添加 Model ${result.model.model} (${result.model.name})`);
}

async function updateModelFlow(ask, pushLog) {
  const config = await refreshConfig();
  const provider = await pickProvider(ask, config);
  if (!provider) throw new Error("已取消");
  if (!provider.models?.length) throw new Error(`Provider ${provider.id} 没有 Model`);

  const model = await pickOption(
    ask,
    "选择要修改的 Model：",
    provider.models.map((m) => ({
      label: `${m.name} (型号: ${m.model})`,
      value: m,
    })),
  );
  if (!model) throw new Error("已取消");

  console.log(`\n当前型号: ${model.model}`);
  console.log(`当前名称: ${model.name}`);
  const modelValue = (await ask("新型号（可留空保持不变）: ")).trim();
  const nameValue = (await ask("新名称（可留空保持不变）: ")).trim();

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
  if (!provider) throw new Error("已取消");
  if (!provider.models?.length) throw new Error(`Provider ${provider.id} 没有 Model`);

  const model = await pickOption(
    ask,
    "选择要删除的 Model：",
    provider.models.map((m) => ({
      label: `${m.name} (型号: ${m.model})`,
      value: m,
    })),
  );
  if (!model) throw new Error("已取消");

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

// 子菜单通用入口：1=新增 2=修改 3=删除 0=返回
async function manageResourceSubmenu(ask, pushLog, title, { add, update, remove }) {
  while (true) {
    console.log(`\n=== ${title} ===`);
    console.log("1=新增  2=修改  3=删除  0=返回");
    const action = (await ask("> ")).trim().toLowerCase();
    if (action === "0" || action === "" || action === "q") return;
    try {
      if (action === "1") await add(ask, pushLog);
      else if (action === "2") await update(ask, pushLog);
      else if (action === "3") await remove(ask, pushLog);
      else pushLog(`未知命令: ${action}`);
    } catch (err) {
      pushLog(`错误: ${err.message}`);
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
  if (!provider) throw new Error("已取消");

  const confirm = (await ask(`\n确认删除 ${provider.name}? (y/N): `)).trim().toLowerCase();
  if (confirm !== "y") {
    pushLog("取消删除");
    return;
  }

  await api(`/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
  pushLog(`已删除 Provider ${provider.id}`);
}

async function switchFamilyFlow(ask, pushLog) {
  const config = await refreshConfig();
  const family = await pickOption(
    ask,
    "选择要切换的 Claude 模型族：",
    FAMILY_ORDER.map((name) => ({ label: name, value: name })),
  );
  if (!family) throw new Error("已取消");

  const provider = await pickProvider(ask, config);
  if (!provider) throw new Error("已取消");

  if (!provider.baseUrls || provider.baseUrls.length === 0) {
    throw new Error(`Provider ${provider.id} 还没有 BaseUrl，请先 2 添加`);
  }
  const baseUrl = await pickOption(
    ask,
    "选择 BaseUrl：",
    provider.baseUrls.map((b) => ({
      label: `${b.note || "(无备注)"} -> ${b.url}`,
      value: b,
    })),
  );
  if (!baseUrl) throw new Error("已取消");

  if (!provider.keys || provider.keys.length === 0) {
    throw new Error(`Provider ${provider.id} 还没有 Key，请先 3 添加`);
  }
  const key = await pickOption(
    ask,
    "选择 Key：",
    provider.keys.map((k) => ({
      label: `${k.note || k.id} (token: ${k.token || "***"})`,
      value: k,
    })),
  );
  if (!key) throw new Error("已取消");

  if (!provider.models || provider.models.length === 0) {
    throw new Error(`Provider ${provider.id} 还没有 Model，请先 4 添加`);
  }
  const model = await pickOption(
    ask,
    "选择 Model：",
    provider.models.map((m) => ({
      label: `${m.name} (型号: ${m.model})`,
      value: m,
    })),
  );
  if (!model) throw new Error("已取消");

  await api(`/families/${encodeURIComponent(family)}`, {
    method: "PUT",
    body: {
      providerId: provider.id,
      baseUrlId: baseUrl.id,
      keyId: key.id,
      modelId: model.id,
    },
  });
  pushLog(`已切换 ${family} -> ${provider.name} · ${model.name}`);
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
      renderedOnce = true;
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
  const input = (await ask("导出路径（回车=默认，输入 q 取消）: ")).trim();

  let targetPath;
  if (input === "" ) {
    targetPath = defaultPath;
  } else if (input.toLowerCase() === "q" || input.toLowerCase() === "quit") {
    pushLog("取消导出");
    return;
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
  const input = (await ask("\n新的监听端口（1-65535）: ")).trim();
  if (!input) throw new Error("已取消");
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
    console.warn(`端口 ${port} 已被占用`);
    if (occ.pid) {
      console.warn(`占用进程: PID=${occ.pid} name=${occ.name || "?"}${occ.cmdline ? " cmd=" + occ.cmdline : ""}`);
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

    const cmd = await ask("> ");
    try {
      const result = await handleCommand(cmd.trim(), { ask, pushLog, runtime, rl });
      if (result === "exit") {
        running = false;
      }
      lastOpResult = "ok";
      lastOpError = null;
    } catch (err) {
      pushLog(`错误: ${err.message}`);
      lastOpResult = "error";
      lastOpError = err.message;
    }
  }

  console.log("\n再见。");
  rl.close();
}
