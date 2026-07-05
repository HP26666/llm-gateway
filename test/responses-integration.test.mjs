// /v1/responses 端到端集成测试：failover + 上游路径断言 + 流式 SSE + 工具调用。
// 镜像 failover.test.mjs 的 stub 模式：随机端口 stub 上游 + stub 网关，fetch 真实 HTTP。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGatewayRequestHandler } from "../server.mjs";
import { _resetBreakersForTest } from "../circuit-breaker.mjs";

// 记录式 stub 上游：记录每次请求的 url/headers/body，由 responder 决定响应。
async function startRecordingStub(responder) {
  const hits = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    hits.push({ url: req.url, method: req.method, headers: req.headers, body: parsed });
    const r = responder(hits.length);
    res.writeHead(r.status, { "content-type": r.contentType || "application/json", ...(r.headers || {}) });
    res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise((r) => server.close(r)),
    getHits: () => hits,
  };
}

async function startGateway(config, metrics = {}) {
  const handler = createGatewayRequestHandler(config, metrics);
  const server = createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(r)) };
}

function buildConfig(family, specs) {
  const providers = {};
  const candidates = [];
  for (const spec of specs) {
    const pid = spec.id;
    const model = spec.model || `model_${pid}`;
    providers[pid] = {
      id: pid,
      name: pid,
      authHeader: "Authorization",
      authScheme: "Bearer",
      baseUrls: [{ id: `b_${pid}`, url: spec.url, note: "stub" }],
      keys: [{ id: `k_${pid}`, token: "stub-token", note: "stub", createdAt: "1970-01-01T00:00:00.000Z" }],
      models: [{ id: `m_${pid}`, model, name: model }],
    };
    candidates.push({ providerId: pid, baseUrlId: `b_${pid}`, keyId: `k_${pid}`, modelId: `m_${pid}` });
  }
  const empty = { candidates: [], strategy: "failover", circuitBreaker: null };
  const modelFamilies = { opus: { ...empty }, sonnet: { ...empty }, "sonnet[1m]": { ...empty }, haiku: { ...empty } };
  modelFamilies[family] = { candidates, strategy: "failover", circuitBreaker: null };
  return {
    gateway: { host: "127.0.0.1", port: 0, sharedToken: null },
    circuitBreaker: null,
    providers,
    modelFamilies,
    history: [],
  };
}

const ANTHROPIC_TEXT = {
  id: "msg_x",
  type: "message",
  role: "assistant",
  model: "stub",
  content: [{ type: "text", text: "Hello from upstream" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
};

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseResponsesSSE(text) {
  const events = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const el = lines.find((l) => l.startsWith("event:"));
    const dl = lines.find((l) => l.startsWith("data:"));
    if (el && dl) {
      events.push({ event: el.slice(6).trim(), data: JSON.parse(dl.slice(5).trim()) });
    }
  }
  return events;
}

test("Responses 入口：failover 生效 + 上游被打路径是 /v1/messages + body 是 Anthropic 格式 + 认证头正确", async (t) => {
  _resetBreakersForTest();
  const primary = await startRecordingStub(() => ({ status: 500, body: { error: { message: "bad" } } }));
  const backup = await startRecordingStub(() => ({ status: 200, body: ANTHROPIC_TEXT }));
  t.after(async () => { await primary.stop(); await backup.stop(); });

  const config = buildConfig("sonnet", [{ id: "p1", url: primary.url }, { id: "p2", url: backup.url }]);
  const gw = await startGateway(config);
  t.after(() => gw.stop());

  const res = await fetch(`${gw.url}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "sonnet",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "response");
  assert.equal(body.output[0].content[0].text, "Hello from upstream");

  assert.equal(primary.getHits().length, 1, "主候选被打 1 次（500 不重试）");
  assert.equal(backup.getHits().length, 1, "备候选 failover 接管 1 次");

  const hit = backup.getHits()[0];
  assert.equal(hit.url, "/v1/messages", "Responses 入口上游必须打 /v1/messages，不是 /v1/responses");
  assert.ok(hit.body.messages, "上游收到的应是 Anthropic messages 结构");
  assert.equal(hit.body.max_tokens, 4096, "max_output_tokens 缺失默认 4096");
  assert.equal(hit.body.model, "model_p2", "上游 body.model 应被覆盖为 upstreamModel");
  assert.equal(hit.headers.authorization, "Bearer stub-token", "上游认证头应为 provider key");
});

test("Responses 流式：stub 返回 Anthropic SSE → 网关吐完整 Responses SSE 序列 + completed.usage", async (t) => {
  _resetBreakersForTest();
  const sseBody = [
    sse("message_start", { type: "message_start", message: { id: "m", model: "s", usage: { input_tokens: 8 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi there" } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    sse("message_stop", { type: "message_stop" }),
  ].join("");
  const up = await startRecordingStub(() => ({ status: 200, contentType: "text/event-stream", body: sseBody }));
  t.after(async () => up.stop());
  const config = buildConfig("haiku", [{ id: "p1", url: up.url }]);
  const gw = await startGateway(config);
  t.after(() => gw.stop());

  const res = await fetch(`${gw.url}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "haiku",
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const text = await res.text();
  const events = parseResponsesSSE(text);

  assert.ok(events.some((e) => e.event === "response.created"), "应有 response.created");
  assert.ok(events.some((e) => e.event === "response.output_text.delta" && e.data.delta === "Hi there"), "应有文本 delta");
  const completed = events.find((e) => e.event === "response.completed").data.response;
  assert.deepEqual(completed.usage, { input_tokens: 8, output_tokens: 1, total_tokens: 9 });

  // 上游 body.stream 被注入为 true
  assert.equal(up.getHits()[0].body.stream, true, "Responses 入口应把 stream 透传给上游 Anthropic body");
});

test("Responses 工具调用：tools 转换 + tool_use→function_call + 二轮 tool_result 回传上游", async (t) => {
  _resetBreakersForTest();
  const up = await startRecordingStub(() => ({
    status: 200,
    body: {
      id: "msg_x",
      model: "stub",
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_9", name: "get_weather", input: { city: "NYC" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  }));
  t.after(async () => up.stop());
  const config = buildConfig("opus", [{ id: "p1", url: up.url }]);
  const gw = await startGateway(config);
  t.after(() => gw.stop());

  // 第一轮：发 tools，断言上游收到 Anthropic tools 格式 + 客户端收到 function_call
  const res1 = await fetch(`${gw.url}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "opus",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "天气?" }] }],
      tools: [{ type: "function", name: "get_weather", description: "d", parameters: { type: "object", properties: { city: { type: "string" } } } }],
    }),
  });
  const b1 = await res1.json();
  const fc = b1.output[0];
  assert.equal(fc.type, "function_call");
  assert.equal(fc.call_id, "toolu_9");
  assert.equal(fc.arguments, '{"city":"NYC"}');

  const hit1 = up.getHits()[0];
  assert.equal(hit1.body.tools[0].name, "get_weather", "上游收到 Anthropic tools（name 透传）");
  assert.ok(hit1.body.tools[0].input_schema, "上游 tools 用 input_schema 而非 parameters");

  // 第二轮：带 function_call_output，断言上游收到 tool_result
  const res2 = await fetch(`${gw.url}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "opus",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "天气?" }] },
        { type: "function_call", call_id: "toolu_9", name: "get_weather", arguments: '{"city":"NYC"}' },
        { type: "function_call_output", call_id: "toolu_9", output: '{"temp":72}' },
      ],
    }),
  });
  assert.equal(res2.status, 200);
  const hit2 = up.getHits()[1];
  const bodyStr = JSON.stringify(hit2.body.messages);
  assert.ok(bodyStr.includes('"type":"tool_result"'), "二轮请求上游 messages 应含 tool_result block");
  assert.ok(bodyStr.includes('"toolu_9"'), "tool_result 的 tool_use_id 应正确配对");
});
