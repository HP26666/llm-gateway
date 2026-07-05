// 响应方向转换：Anthropic Messages 响应 → OpenAI Responses API 响应。
// 非流式：anthropicResponseToResponses，把 Anthropic message 对象整体翻成 Responses 对象。
// 流式：createAnthropicToResponsesStream，一个 Transform 流，把上游 Anthropic SSE 事件流
//       实时翻译成 Codex 期望的 Responses SSE 事件流（state machine）。
//
// 关键不变量：
// - sequence_number 跨所有事件类型单调递增（客户端靠它排序/去重）。
// - output_index 每个新 content block（item）+1；同一 item 内的 content part 共享 output_index。
// - response.completed 必须带完整累积的 output[] 和 usage（流过程中累积，终态整体输出）。
// - function_call 的 call_id 直接用 Anthropic tool_use 的 id，保证下一轮 function_call_output 配对。
// - 流式断流（未收到 message_stop）要补发 error 事件并正常 end，不挂死客户端。

import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  createSequenceCounter,
  encodeResponsesSSE,
  parseAnthropicSSEChunk,
  buildResponsesEnvelope,
  makeResponsesItemId,
} from "./responses-protocol.mjs";

// 取数值，非有限数归 0。
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// 从 Anthropic usage 对象提取网关内部统计用的四元组。
export function extractUsage(u) {
  if (!u || typeof u !== "object") return { in: 0, out: 0, cacheR: 0, cacheW: 0 };
  return {
    in: num(u.input_tokens),
    out: num(u.output_tokens),
    cacheR: num(u.cache_read_input_tokens),
    cacheW: num(u.cache_creation_input_tokens),
  };
}

// 把 Anthropic tool_use.input（对象）序列化成 Responses function_call.arguments（JSON 字符串）。
function safeStringifyInput(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ===== 非流式 =====
// json: Anthropic /v1/messages 响应对象；requestId: 本次请求的 resp_ id。
// 返回 { responsesObject, usage:{in,out,cacheR,cacheW} }。
export function anthropicResponseToResponses(json, requestId) {
  const usage = extractUsage(json?.usage);
  const output = [];
  let msgSeq = 0;
  let fcSeq = 0;
  let rsSeq = 0;
  let pendingMessage = null; // 累积连续 text block 到同一个 message item

  for (const block of Array.isArray(json?.content) ? json.content : []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      if (!pendingMessage) {
        pendingMessage = {
          type: "message",
          id: makeResponsesItemId("msg", requestId, msgSeq++),
          role: "assistant",
          status: "completed",
          content: [],
        };
      }
      pendingMessage.content.push({
        type: "output_text",
        text: typeof block.text === "string" ? block.text : "",
        annotations: [],
      });
    } else if (block.type === "tool_use") {
      if (pendingMessage) {
        output.push(pendingMessage);
        pendingMessage = null;
      }
      output.push({
        type: "function_call",
        id: makeResponsesItemId("fc", requestId, fcSeq++),
        call_id: block.id,
        name: block.name,
        arguments: safeStringifyInput(block.input),
        status: "completed",
      });
    } else if (block.type === "thinking") {
      if (pendingMessage) {
        output.push(pendingMessage);
        pendingMessage = null;
      }
      output.push({
        type: "reasoning",
        id: makeResponsesItemId("rs", requestId, rsSeq++),
        summary: [{ type: "summary_text", text: typeof block.thinking === "string" ? block.thinking : "" }],
        status: "completed",
      });
    }
  }
  if (pendingMessage) output.push(pendingMessage);

  const status = json?.stop_reason === "max_tokens" ? "incomplete" : "completed";
  const responsesObject = buildResponsesEnvelope({
    id: requestId,
    model: typeof json?.model === "string" ? json.model : "unknown",
    status,
    output,
    usage: {
      input_tokens: usage.in,
      output_tokens: usage.out,
      total_tokens: usage.in + usage.out,
    },
  });

  return { responsesObject, usage };
}

// ===== 流式 =====
// Transform 工厂：吃 Anthropic SSE 字节，吐 Responses SSE 字节。
// onUsage(status)：流结束（正常或异常）时回调一次，传出 {in,out,cacheR,cacheW}。
export function createAnthropicToResponsesStream({ requestId, model, onUsage = null }) {
  const nextSeq = createSequenceCounter(0);
  // StringDecoder 缓存跨 chunk 边界的不完整多字节序列，避免中文 UTF-8 被拆成替换符。
  const decoder = new StringDecoder("utf8");
  const state = {
    buffer: "",
    requestId,
    model,
    onUsage,
    outputIndex: 0,
    current: null, // {kind:"message"|"function_call"|"reasoning", id, ...}
    output: [], // 累积完整 item，供 response.completed
    inputTokens: 0,
    outputTokens: 0,
    cacheR: 0,
    cacheW: 0,
    finalStatus: "completed",
    created: false,
    finished: false,
    errored: false,
    usageReported: false,
  };

  function reportUsage() {
    if (state.usageReported || !state.onUsage) return;
    state.usageReported = true;
    state.onUsage({
      in: state.inputTokens,
      out: state.outputTokens,
      cacheR: state.cacheR,
      cacheW: state.cacheW,
    });
  }

  function emitError(errObj) {
    if (state.errored) return;
    state.errored = true;
    stream.push(encodeResponsesSSE("error", {
      type: "error",
      sequence_number: nextSeq(),
      code: errObj?.code || "upstream_stream_error",
      message: errObj?.message || "upstream stream error",
    }));
  }

  // 关闭并发出 current item 的 done 事件，累积到 output，outputIndex 前进。
  function flushCurrent() {
    if (!state.current) return;
    const c = state.current;
    const idx = state.outputIndex;
    if (c.kind === "message") {
      stream.push(encodeResponsesSSE("response.output_text.done", {
        type: "response.output_text.done",
        sequence_number: nextSeq(),
        output_index: idx,
        content_index: 0,
        text: c.text,
      }));
      stream.push(encodeResponsesSSE("response.content_part.done", {
        type: "response.content_part.done",
        sequence_number: nextSeq(),
        output_index: idx,
        content_index: 0,
        part: { type: "output_text", text: c.text, annotations: [] },
      }));
      const item = {
        type: "message",
        id: c.id,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: c.text, annotations: [] }],
      };
      stream.push(encodeResponsesSSE("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: idx,
        item,
      }));
      state.output.push(item);
    } else if (c.kind === "function_call") {
      stream.push(encodeResponsesSSE("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        sequence_number: nextSeq(),
        output_index: idx,
        arguments: c.arguments,
      }));
      const item = {
        type: "function_call",
        id: c.id,
        call_id: c.call_id,
        name: c.name,
        arguments: c.arguments,
        status: "completed",
      };
      stream.push(encodeResponsesSSE("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: idx,
        item,
      }));
      state.output.push(item);
    } else if (c.kind === "reasoning") {
      stream.push(encodeResponsesSSE("response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        sequence_number: nextSeq(),
        output_index: idx,
        text: c.text,
      }));
      const item = {
        type: "reasoning",
        id: c.id,
        summary: [{ type: "summary_text", text: c.text }],
        status: "completed",
      };
      stream.push(encodeResponsesSSE("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: nextSeq(),
        output_index: idx,
        item,
      }));
      state.output.push(item);
    }
    state.outputIndex += 1;
    state.current = null;
  }

  function ensureCreated() {
    if (state.created) return;
    state.created = true;
    const env = () => buildResponsesEnvelope({ id: state.requestId, model: state.model, status: "in_progress" });
    stream.push(encodeResponsesSSE("response.created", {
      type: "response.created",
      sequence_number: nextSeq(),
      response: env(),
    }));
    stream.push(encodeResponsesSSE("response.in_progress", {
      type: "response.in_progress",
      sequence_number: nextSeq(),
      response: env(),
    }));
  }

  function handleEvent(data) {
    if (!data || typeof data !== "object") return;
    switch (data.type) {
      case "message_start": {
        const u = data.message?.usage;
        if (u) {
          state.inputTokens = num(u.input_tokens);
          state.cacheW = num(u.cache_creation_input_tokens);
          state.cacheR = num(u.cache_read_input_tokens);
        }
        ensureCreated();
        break;
      }
      case "content_block_start": {
        const cb = data.content_block;
        if (!cb || typeof cb !== "object") break;
        flushCurrent(); // 关闭上一个 item（若有）
        if (cb.type === "text") {
          const id = makeResponsesItemId("msg", state.requestId, state.outputIndex);
          state.current = { kind: "message", id, text: "" };
          ensureCreated();
          stream.push(encodeResponsesSSE("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: nextSeq(),
            output_index: state.outputIndex,
            item: { type: "message", id, role: "assistant", status: "in_progress", content: [] },
          }));
          stream.push(encodeResponsesSSE("response.content_part.added", {
            type: "response.content_part.added",
            sequence_number: nextSeq(),
            output_index: state.outputIndex,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }));
        } else if (cb.type === "tool_use") {
          const id = makeResponsesItemId("fc", state.requestId, state.outputIndex);
          state.current = {
            kind: "function_call",
            id,
            call_id: cb.id,
            name: cb.name,
            arguments: "",
          };
          ensureCreated();
          stream.push(encodeResponsesSSE("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: nextSeq(),
            output_index: state.outputIndex,
            item: { type: "function_call", id, call_id: cb.id, name: cb.name, arguments: "", status: "in_progress" },
          }));
        } else if (cb.type === "thinking") {
          const id = makeResponsesItemId("rs", state.requestId, state.outputIndex);
          state.current = { kind: "reasoning", id, text: "" };
          ensureCreated();
          stream.push(encodeResponsesSSE("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: nextSeq(),
            output_index: state.outputIndex,
            item: { type: "reasoning", id, summary: [], status: "in_progress" },
          }));
        }
        break;
      }
      case "content_block_delta": {
        const d = data.delta;
        if (!d || !state.current) break;
        if (d.type === "text_delta" && state.current.kind === "message") {
          const piece = typeof d.text === "string" ? d.text : "";
          state.current.text += piece;
          stream.push(encodeResponsesSSE("response.output_text.delta", {
            type: "response.output_text.delta",
            sequence_number: nextSeq(),
            output_index: state.outputIndex,
            content_index: 0,
            delta: piece,
          }));
        } else if (d.type === "input_json_delta" && state.current.kind === "function_call") {
          const piece = typeof d.partial_json === "string" ? d.partial_json : "";
          state.current.arguments += piece;
          stream.push(encodeResponsesSSE("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            sequence_number: nextSeq(),
            output_index: state.outputIndex,
            delta: piece,
          }));
        } else if (d.type === "thinking_delta" && state.current.kind === "reasoning") {
          const piece = typeof d.thinking === "string" ? d.thinking : "";
          state.current.text += piece;
          stream.push(encodeResponsesSSE("response.reasoning_summary_text.delta", {
            type: "response.reasoning_summary_text.delta",
            sequence_number: nextSeq(),
            output_index: state.outputIndex,
            delta: piece,
          }));
        }
        break;
      }
      case "content_block_stop": {
        flushCurrent();
        break;
      }
      case "message_delta": {
        if (data.usage && typeof data.usage.output_tokens === "number") {
          state.outputTokens = num(data.usage.output_tokens);
        }
        if (data.delta && data.delta.stop_reason === "max_tokens") {
          state.finalStatus = "incomplete";
        }
        break;
      }
      case "message_stop": {
        flushCurrent();
        const usage = {
          input_tokens: state.inputTokens,
          output_tokens: state.outputTokens,
          total_tokens: state.inputTokens + state.outputTokens,
        };
        const completed = buildResponsesEnvelope({
          id: state.requestId,
          model: state.model,
          status: state.finalStatus,
          output: state.output,
          usage,
        });
        stream.push(encodeResponsesSSE("response.completed", {
          type: "response.completed",
          sequence_number: nextSeq(),
          response: completed,
        }));
        reportUsage();
        state.finished = true;
        break;
      }
      case "error": {
        emitError(data.error || { message: "upstream error event" });
        break;
      }
      default:
        // ping / 未知事件：忽略
        break;
    }
  }

  const stream = new Transform({
    transform(chunk, _enc, callback) {
      state.buffer += decoder.write(chunk);
      const { events, rest } = parseAnthropicSSEChunk(state.buffer);
      state.buffer = rest;
      try {
        for (const { data } of events) {
          handleEvent(data);
        }
      } catch (err) {
        emitError({ message: err?.message || "translate error" });
      }
      callback();
    },
    flush(callback) {
      // flush StringDecoder 缓存的不完整多字节尾部，尽力解析残留事件
      const tail = decoder.end();
      if (tail) {
        state.buffer += tail;
        const { events } = parseAnthropicSSEChunk(state.buffer);
        state.buffer = "";
        try {
          for (const { data } of events) {
            handleEvent(data);
          }
        } catch {
          // ignore
        }
      }
      // 上游结束：补发收尾。正常情况 message_stop 已处理（finished=true）。
      try {
        flushCurrent();
      } catch {
        // ignore
      }
      if (!state.finished) {
        reportUsage();
        if (!state.errored) {
          emitError({ message: "upstream stream ended before completion" });
        }
      }
      callback();
    },
  });

  return stream;
}
