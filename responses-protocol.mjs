// Responses API 的 SSE 序列化/解析、envelope 构造、sequence 计数。
// 纯函数 + 轻量状态，零依赖。供 responses-response-adapter.mjs 把上游 Anthropic SSE
// 翻译成 Codex（Responses wire_api）期望的 SSE 事件流。
//
// 这里只处理「线格式」，不涉及 Anthropic ↔ Responses 的语义映射（那部分在 adapter 里）。

// 每个流实例一个计数器：Responses SSE 的每个事件都要带单调递增的 sequence_number，
// 客户端靠它排序、去重。跨事件类型共享一个计数器。
export function createSequenceCounter(start = 0) {
  let n = start;
  return () => n++;
}

// 把一个 Responses SSE 事件编码成 wire 格式块："event: <type>\ndata: <json>\n\n"
// 与 OpenAI Responses 流式协议一致（event 行 + data 行 + 空行分隔）。
export function encodeResponsesSSE(eventType, dataObj) {
  return `event: ${eventType}\ndata: ${JSON.stringify(dataObj)}\n\n`;
}

// 解析单个 Anthropic SSE 块（已按 "\n\n" 切出的一段）。
// Anthropic 格式：event: <type>\ndata: <json> ；data 理论上可多行，这里按换行拼接后 JSON.parse。
// 返回 { event, data } 或 null（无 data / 解析失败，例如 [DONE] 哨兵）。
function parseAnthropicSSEBlock(block) {
  if (!block) return null;
  let event = null;
  const dataLines = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

// 解析 Anthropic SSE 字节流：累积 buffer 中按 "\n\n" 切出完整事件块。
// 处理「半个事件跨 chunk」：返回的 rest 是尚未闭合的尾部，调用方下次拼上新 chunk 再切。
// 用法：const { events, rest } = parseAnthropicSSEChunk(buffer += chunk); buffer = rest;
export function parseAnthropicSSEChunk(buffer) {
  const events = [];
  let acc = buffer;
  let idx;
  while ((idx = acc.indexOf("\n\n")) >= 0) {
    const block = acc.slice(0, idx);
    acc = acc.slice(idx + 2);
    const parsed = parseAnthropicSSEBlock(block);
    if (parsed) events.push(parsed);
  }
  return { events, rest: acc };
}

// 构造 Responses 顶层 response 对象骨架（非流式终态 / 流式 response.created、completed 都用）。
// status: "in_progress" | "completed" | "incomplete" | "failed"
// output: 顶层 output 数组（message/function_call/reasoning item）
// usage: 可选，终态时带 { input_tokens, output_tokens, total_tokens }
export function buildResponsesEnvelope({ id, model, status = "in_progress", output = [], usage = null }) {
  const obj = {
    object: "response",
    id,
    status,
    model,
    output,
  };
  if (usage) {
    obj.usage = usage;
  }
  return obj;
}

// 生成稳定的 Responses item id（Codex 用 item_id 关联增量与 done 事件，必须跨事件稳定）。
// prefix: "msg" | "fc" | "rs" ；index 保证同一响应内唯一。
export function makeResponsesItemId(prefix, requestId, index) {
  return `${prefix}_${requestId}_${index}`;
}
