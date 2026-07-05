// 请求方向转换：OpenAI Responses API body → Anthropic Messages API body。
// Codex（wire_api="responses"）只发 /v1/responses，上游全是 Anthropic 兼容端点，
// 网关在调 tryWithFailover 前用本模块把请求体预转成 Anthropic 格式。
//
// 设计要点：
// - 主动丢弃 Responses 独有、Anthropic 无对应、且上游国产模型支持参差的字段：
//   reasoning / previous_response_id / text.format / parallel_tool_calls / strict。
//   （reasoning/thinking 映射留到阶段4，按 per-family capabilities 开关开启。）
// - function_call ↔ tool_use、function_call_output ↔ tool_result 双向对齐，
//   call_id 必须透传，保证多轮工具调用的配对。
// - 连续同 role 的内容（如 assistant 的 text + function_call）合并到同一条 message，
//   以满足 Anthropic 的「messages 必须 user/assistant 交替」约束。

// 模块级自增计数器：仅用于极罕见的 call_id 缺失兜底，保证 tool_use id 唯一。
let fallbackCallSeq = 0;
function nextFallbackCallId() {
  fallbackCallSeq += 1;
  return `call_fallback_${fallbackCallSeq}`;
}

// 容错 JSON.parse：function_call.arguments 是 JSON 字符串，可能空串或不完整。
function safeParseJSON(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    return fallback;
  }
}

// function_call_output.output 可能是 string 或对象；Anthropic tool_result.content 接受 string。
function normalizeToolOutput(output) {
  if (output == null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

// 把内容（string 或 part 数组）转成 Anthropic content block 数组。
// Responses 的 input_text/output_text/裸 text 都映射为 Anthropic {type:"text"}。
// input_image / input_file / reasoning_text / refusal 等阶段1-3 忽略。
function convertMessageContent(content) {
  const blocks = [];
  if (typeof content === "string") {
    if (content.length) blocks.push({ type: "text", text: content });
    return blocks;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const t = part.type;
      if (t === "input_text" || t === "output_text" || t === "text") {
        if (typeof part.text === "string" && part.text.length) {
          blocks.push({ type: "text", text: part.text });
        }
      }
    }
  }
  return blocks;
}

// 把 blocks 追加到 messages 末尾的同 role message；不存在则新建。
// 保证连续同 role 内容合并，避免违反 Anthropic 交替约束。
function appendMessage(messages, role, blocks) {
  const last = messages[messages.length - 1];
  if (last && last.role === role) {
    last.content.push(...blocks);
  } else {
    messages.push({ role, content: [...blocks] });
  }
}

// Responses input（string | item[]）→ Anthropic messages + 额外 system 文本。
// system/developer role 的 message 内容收集到 systemParts（最终并入顶层 system 字段）。
export function convertInputToMessages(input) {
  const messages = [];
  const systemParts = [];

  if (typeof input === "string") {
    if (input.length) {
      messages.push({ role: "user", content: [{ type: "text", text: input }] });
    }
    return { messages, systemParts };
  }
  if (!Array.isArray(input)) {
    return { messages, systemParts };
  }

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    switch (item.type) {
      case "message": {
        const rawRole = item.role;
        let role;
        if (rawRole === "assistant") {
          role = "assistant";
        } else if (rawRole === "system" || rawRole === "developer") {
          role = "system";
        } else {
          role = "user"; // user / tool / 未知 → user
        }
        const blocks = convertMessageContent(item.content);
        if (role === "system") {
          const txt = blocks.map((b) => (typeof b.text === "string" ? b.text : "")).join("\n");
          if (txt.length) systemParts.push(txt);
        } else if (blocks.length) {
          appendMessage(messages, role, blocks);
        }
        break;
      }
      case "function_call": {
        // 上轮 assistant 产出的工具调用 → 合进 assistant message 的 tool_use block
        const block = {
          type: "tool_use",
          id: item.call_id || item.id || nextFallbackCallId(),
          name: item.name,
          input: safeParseJSON(item.arguments, {}),
        };
        appendMessage(messages, "assistant", [block]);
        break;
      }
      case "function_call_output": {
        // 工具执行结果 → user message 的 tool_result block，tool_use_id 必须对得上
        const block = {
          type: "tool_result",
          tool_use_id: item.call_id || item.id,
          content: normalizeToolOutput(item.output),
        };
        appendMessage(messages, "user", [block]);
        break;
      }
      default:
        // reasoning / web_search_call / file_search_call 等：阶段1-3 忽略
        break;
    }
  }

  return { messages, systemParts };
}

// Responses tools[] → Anthropic tools[]。只转 type:"function"（内置工具无对应，忽略）。
export function convertToolsToAnthropic(tools) {
  const result = [];
  if (!Array.isArray(tools)) return result;
  for (const t of tools) {
    if (!t || typeof t !== "object" || t.type !== "function") continue;
    if (!t.name || typeof t.name !== "string") continue;
    result.push({
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      input_schema: t.parameters && typeof t.parameters === "object"
        ? t.parameters
        : { type: "object", properties: {} },
    });
  }
  return result;
}

// Responses tool_choice → Anthropic tool_choice。
// "auto"→{type:auto}，"required"→{type:any}，{type:"function",name}→{type:tool,name}，"none"/无→undefined
export function convertToolChoiceToAnthropic(tc) {
  if (!tc) return undefined;
  if (tc === "auto") return { type: "auto" };
  if (tc === "required") return { type: "any" };
  if (tc === "none") return undefined;
  if (typeof tc === "object") {
    if (tc.type === "function" && tc.name) return { type: "tool", name: tc.name };
    if (tc.type === "auto") return { type: "auto" };
    if (tc.type === "required") return { type: "any" };
  }
  return undefined;
}

export function resolveModelFromResponses(body) {
  return body?.model;
}

export function isResponsesStream(body) {
  return body?.stream === true;
}

// 主入口：Responses body → Anthropic /v1/messages body。
// 成功返回 { ok:true, body }；失败返回 { ok:false, statusCode, type, message }。
// 注意：不在此设置 stream 字段——由 handleResponsesProxy 根据客户端 body.stream 统一注入，
// 这样上游按客户端期望的流/非流式响应。
export function responsesBodyToAnthropic(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, statusCode: 400, type: "invalid_request_error", message: "Request body must be a JSON object." };
  }
  const model = body.model;
  if (!model || typeof model !== "string") {
    return { ok: false, statusCode: 400, type: "invalid_request_error", message: "Request JSON must include a string `model` field." };
  }

  const { messages, systemParts } = convertInputToMessages(body.input);
  if (messages.length === 0) {
    return { ok: false, statusCode: 400, type: "invalid_request_error", message: "A valid `input` (string or non-empty item array) is required." };
  }

  const anthropic = {
    model,
    messages,
    max_tokens: typeof body.max_output_tokens === "number" && body.max_output_tokens > 0
      ? body.max_output_tokens
      : 4096,
  };

  // system：顶层 instructions + input 里的 system/developer message 文本
  const sysParts = [];
  if (typeof body.instructions === "string" && body.instructions.length) sysParts.push(body.instructions);
  if (systemParts.length) sysParts.push(systemParts.join("\n\n"));
  if (sysParts.length) anthropic.system = sysParts.join("\n\n");

  if (typeof body.temperature === "number") anthropic.temperature = body.temperature;
  if (typeof body.top_p === "number") anthropic.top_p = body.top_p;
  if (Array.isArray(body.stop)) anthropic.stop_sequences = body.stop;

  const tools = convertToolsToAnthropic(body.tools);
  if (tools.length) anthropic.tools = tools;

  const toolChoice = convertToolChoiceToAnthropic(body.tool_choice);
  if (toolChoice) anthropic.tool_choice = toolChoice;

  return { ok: true, body: anthropic };
}
