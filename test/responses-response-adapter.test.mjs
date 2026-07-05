// responses-response-adapter 单元测试：Anthropic 响应 → Responses 响应（非流式 + 流式状态机）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicResponseToResponses,
  createAnthropicToResponsesStream,
} from "../responses-response-adapter.mjs";
import { parseAnthropicSSEChunk } from "../responses-protocol.mjs";

// ===== 非流式 =====

test("非流式 text → message output item + usage 提取（含 cache_*）", () => {
  const { responsesObject, usage } = anthropicResponseToResponses({
    id: "msg_1", model: "m", role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
  }, "resp_t");
  assert.equal(responsesObject.object, "response");
  assert.equal(responsesObject.id, "resp_t");
  assert.equal(responsesObject.status, "completed");
  assert.equal(responsesObject.output.length, 1);
  assert.equal(responsesObject.output[0].type, "message");
  assert.equal(responsesObject.output[0].content[0].type, "output_text");
  assert.equal(responsesObject.output[0].content[0].text, "Hello");
  assert.deepEqual(responsesObject.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  assert.deepEqual(usage, { in: 10, out: 5, cacheR: 2, cacheW: 1 });
});

test("非流式 tool_use → function_call（call_id 透传，arguments stringify）", () => {
  const { responsesObject } = anthropicResponseToResponses({
    model: "m",
    content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "NYC" } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 3, output_tokens: 1 },
  }, "resp_t");
  const fc = responsesObject.output[0];
  assert.equal(fc.type, "function_call");
  assert.equal(fc.call_id, "toolu_1");
  assert.equal(fc.name, "get_weather");
  assert.equal(fc.arguments, '{"city":"NYC"}');
  assert.equal(responsesObject.status, "completed", "tool_use 的 stop_reason 仍 completed");
});

test("非流式 max_tokens → status incomplete", () => {
  const { responsesObject } = anthropicResponseToResponses({
    model: "m", content: [{ type: "text", text: "..." }], stop_reason: "max_tokens",
    usage: { input_tokens: 1, output_tokens: 1 },
  }, "resp_t");
  assert.equal(responsesObject.status, "incomplete");
});

test("非流式 thinking → reasoning item", () => {
  const { responsesObject } = anthropicResponseToResponses({
    model: "m", content: [{ type: "thinking", thinking: "reasoning here" }], stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  }, "resp_t");
  assert.equal(responsesObject.output[0].type, "reasoning");
  assert.equal(responsesObject.output[0].summary[0].text, "reasoning here");
});

// ===== 流式 =====

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function translateSse(anthropicSse, opts = {}) {
  const stream = createAnthropicToResponsesStream({
    requestId: opts.requestId || "resp_t",
    model: opts.model || "m",
    onUsage: opts.onUsage || null,
  });
  let out = "";
  stream.on("data", (c) => { out += c.toString(); });
  const done = new Promise((res) => stream.on("end", res));
  stream.end(anthropicSse);
  await done;
  return out;
}

test("流式 text：完整事件序列 + sequence_number 单调 + completed 带完整 output+usage", async () => {
  const anthropic = [
    sse("message_start", { type: "message_start", message: { id: "msg_1", model: "m", usage: { input_tokens: 10, cache_read_input_tokens: 3 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");

  const out = await translateSse(anthropic);
  const events = parseAnthropicSSEChunk(out).events;

  assert.deepEqual(
    events.map((e) => e.event),
    [
      "response.created", "response.in_progress",
      "response.output_item.added", "response.content_part.added",
      "response.output_text.delta", "response.output_text.delta",
      "response.output_text.done", "response.content_part.done", "response.output_item.done",
      "response.completed",
    ],
  );

  // sequence_number 跨事件类型单调递增
  const seqs = events.map((e) => e.data.sequence_number);
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i] > seqs[i - 1], `sequence_number ${seqs[i]} 未大于 ${seqs[i - 1]}`);
  }

  const completed = events.find((e) => e.event === "response.completed").data.response;
  assert.equal(completed.output.length, 1);
  assert.equal(completed.output[0].content[0].text, "Hello world");
  assert.deepEqual(completed.usage, { input_tokens: 10, output_tokens: 3, total_tokens: 13 });
});

test("流式 tool_use：function_call_arguments.delta/.done + call_id 透传", async () => {
  const anthropic = [
    sse("message_start", { type: "message_start", message: { id: "m", model: "m", usage: { input_tokens: 5 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"NYC"}' } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");
  const out = await translateSse(anthropic);
  const events = parseAnthropicSSEChunk(out).events;
  const completed = events.find((e) => e.event === "response.completed").data.response;
  const fc = completed.output[0];
  assert.equal(fc.type, "function_call");
  assert.equal(fc.call_id, "toolu_1");
  assert.equal(fc.arguments, '{"city":"NYC"}');
  assert.equal(fc.name, "get_weather");
  // 拆分 delta 事件存在
  assert.ok(events.some((e) => e.event === "response.function_call_arguments.delta" && e.data.delta === '{"city":'));
  assert.ok(events.some((e) => e.event === "response.function_call_arguments.done"));
});

test("流式断流（无 content_block_stop / message_stop）→ 补发 error 事件", async () => {
  const anthropic = [
    sse("message_start", { type: "message_start", message: { id: "m", model: "m", usage: { input_tokens: 5 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }),
    // 故意截断
  ].join("");
  const out = await translateSse(anthropic);
  const events = parseAnthropicSSEChunk(out).events.map((e) => e.event);
  assert.ok(events.includes("error"), "上游断流应补发 error 事件");
});

test("流式 onUsage 回调：正常完成时回调一次，含 cache_*", async () => {
  let captured = null;
  await translateSse(
    [
      sse("message_start", { type: "message_start", message: { id: "m", model: "m", usage: { input_tokens: 7, cache_creation_input_tokens: 4 } } }),
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse("content_block_stop", { type: "content_block_stop", index: 0 }),
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
      sse("message_stop", { type: "message_stop" }),
    ].join(""),
    { onUsage: (u) => { captured = u; } },
  );
  assert.deepEqual(captured, { in: 7, out: 9, cacheR: 0, cacheW: 4 });
});
