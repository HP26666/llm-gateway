// responses-request-adapter 单元测试：Responses body → Anthropic body 纯函数映射。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  responsesBodyToAnthropic,
  convertInputToMessages,
  convertToolsToAnthropic,
  convertToolChoiceToAnthropic,
  resolveModelFromResponses,
  isResponsesStream,
} from "../responses-request-adapter.mjs";

test("input string → 单条 user message", () => {
  const { ok, body } = responsesBodyToAnthropic({ model: "sonnet", input: "hello" });
  assert.ok(ok);
  assert.deepEqual(body.messages, [{ role: "user", content: [{ type: "text", text: "hello" }] }]);
});

test("input message item：input_text/output_text → text block，role 透传", () => {
  const { ok, body } = responsesBodyToAnthropic({
    model: "sonnet",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    ],
  });
  assert.ok(ok);
  assert.equal(body.messages.length, 2);
  assert.deepEqual(body.messages[0], { role: "user", content: [{ type: "text", text: "hi" }] });
  assert.deepEqual(body.messages[1], { role: "assistant", content: [{ type: "text", text: "hello" }] });
});

test("function_call → assistant tool_use；function_call_output → user tool_result，配对保序", () => {
  const { ok, body } = responsesBodyToAnthropic({
    model: "sonnet",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "天气" }] },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"NYC"}' },
      { type: "function_call_output", call_id: "call_1", output: '{"temp":72}' },
    ],
  });
  assert.ok(ok);
  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[1].role, "assistant");
  assert.deepEqual(body.messages[1].content[0], {
    type: "tool_use", id: "call_1", name: "get_weather", input: { city: "NYC" },
  });
  assert.equal(body.messages[2].role, "user");
  assert.deepEqual(body.messages[2].content[0], {
    type: "tool_result", tool_use_id: "call_1", content: '{"temp":72}',
  });
});

test("tools：type:function → {name,description,input_schema}；非 function 忽略；缺 parameters 用默认 schema", () => {
  const tools = convertToolsToAnthropic([
    { type: "function", name: "a", description: "d", parameters: { type: "object", properties: { x: { type: "string" } } }, strict: true },
    { type: "web_search" },
    { type: "function", name: "b" },
  ]);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, "a");
  assert.equal(tools[0].description, "d");
  assert.deepEqual(tools[0].input_schema, { type: "object", properties: { x: { type: "string" } } });
  assert.ok(!("strict" in tools[0]), "strict 不应透传到 Anthropic");
  assert.deepEqual(tools[1].input_schema, { type: "object", properties: {} });
});

test("tool_choice 三态 + 对象形式", () => {
  assert.deepEqual(convertToolChoiceToAnthropic("auto"), { type: "auto" });
  assert.deepEqual(convertToolChoiceToAnthropic("required"), { type: "any" });
  assert.equal(convertToolChoiceToAnthropic("none"), undefined);
  assert.deepEqual(convertToolChoiceToAnthropic({ type: "function", name: "x" }), { type: "tool", name: "x" });
  assert.equal(convertToolChoiceToAnthropic(undefined), undefined);
});

test("max_output_tokens → max_tokens（缺失默认 4096）；temperature/top_p 透传", () => {
  const { body } = responsesBodyToAnthropic({ model: "sonnet", input: "x", max_output_tokens: 100, temperature: 0.5, top_p: 0.9 });
  assert.equal(body.max_tokens, 100);
  assert.equal(body.temperature, 0.5);
  assert.equal(body.top_p, 0.9);

  const { body: b2 } = responsesBodyToAnthropic({ model: "sonnet", input: "x" });
  assert.equal(b2.max_tokens, 4096);
});

test("instructions → system；system/developer message 文本并入 system", () => {
  const { body } = responsesBodyToAnthropic({
    model: "sonnet",
    instructions: "be helpful",
    input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "extra rule" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
  });
  assert.ok(body.system.includes("be helpful"));
  assert.ok(body.system.includes("extra rule"));
});

test("缺 model / 缺 input / 空 input → 400", () => {
  assert.equal(responsesBodyToAnthropic({ input: "x" }).ok, false);
  assert.equal(responsesBodyToAnthropic({ model: "sonnet" }).ok, false);
  assert.equal(responsesBodyToAnthropic({ model: "sonnet", input: [] }).ok, false);
});

test("arguments JSON.parse 容错：空串 / 非法 JSON / 已是对象 → 安全回退", () => {
  const { messages } = convertInputToMessages([
    { type: "function_call", call_id: "c1", name: "n", arguments: "" },
    { type: "function_call", call_id: "c2", name: "n", arguments: "{broken" },
    { type: "function_call", call_id: "c3", name: "n", arguments: { already: "object" } },
  ]);
  // 3 个 function_call 合并到同一条 assistant message（满足 Anthropic 交替约束 + 并行 tool_use 语义）
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].content.length, 3);
  assert.deepEqual(messages[0].content[0].input, {});
  assert.deepEqual(messages[0].content[1].input, {});
  assert.deepEqual(messages[0].content[2].input, { already: "object" });
});

test("function_call_output.output 对象 → stringify；null → 空串", () => {
  const { messages } = convertInputToMessages([
    { type: "function_call_output", call_id: "c1", output: { temp: 72 } },
    { type: "function_call_output", call_id: "c2", output: null },
  ]);
  // 2 个 tool_result 合并到同一条 user message
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content.length, 2);
  assert.equal(messages[0].content[0].content, '{"temp":72}');
  assert.equal(messages[0].content[1].content, "");
});

test("resolveModelFromResponses / isResponsesStream", () => {
  assert.equal(resolveModelFromResponses({ model: "sonnet" }), "sonnet");
  assert.equal(isResponsesStream({ stream: true }), true);
  assert.equal(isResponsesStream({}), false);
});

test("reasoning / previous_response_id / parallel_tool_calls / strict 阶段1-3 被丢弃", () => {
  const { body } = responsesBodyToAnthropic({
    model: "sonnet",
    input: "x",
    reasoning: { effort: "high" },
    previous_response_id: "resp_xx",
    parallel_tool_calls: true,
  });
  assert.equal(body.reasoning, undefined);
  assert.equal(body.previous_response_id, undefined);
  assert.equal(body.parallel_tool_calls, undefined);
});
