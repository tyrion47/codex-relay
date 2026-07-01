function esc(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}
function sse(event, data) { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  const mapped = content.map((c) => ({ ...c, type: c.type === "input_text" ? "text" : c.type }));
  if (mapped.length === 1 && mapped[0].text !== undefined) return mapped[0].text;
  return mapped;
}
function responsesToChat(body) {
  const out = {};
  for (const k of Object.keys(body || {})) {
    if (["input", "instructions", "object", "metadata", "parallel_tool_calls"].includes(k)) continue;
    out[k] = body[k];
  }
  if (out.max_output_tokens) { out.max_tokens = out.max_output_tokens; delete out.max_output_tokens; }
  if (Array.isArray(out.tools)) {
    out.tools = out.tools
      .filter((t) => !t.type || t.type === "function")
      .filter((t) => t.function || t.name)
      .map((t) => t.function ? t : { type: "function", function: { name: t.name, description: t.description || "", parameters: t.parameters || {} } });
    if (!out.tools.length) delete out.tools;
  }
  if (out.tool_choice && typeof out.tool_choice === "object" && out.tool_choice.type === "function" && out.tool_choice.name) {
    out.tool_choice = { type: "function", function: { name: out.tool_choice.name } };
  }
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  for (const item of body.input || []) {
    let role = item.role || "user";
    if (role === "developer") role = "system";
    const msg = { role, content: normalizeContent(item.content) };
    if (item.name) msg.name = item.name;
    if (item.tool_calls) msg.tool_calls = item.tool_calls;
    if (item.tool_call_id) msg.tool_call_id = item.tool_call_id;
    if (item.reasoning_content) msg.reasoning_content = item.reasoning_content;
    messages.push(msg);
  }
  out.messages = messages;
  return out;
}
function usageFromChat(u) {
  return u ? {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    total_tokens: u.total_tokens || 0,
    input_tokens_details: { cached_tokens: u.prompt_cache_hit_tokens || u.prompt_tokens_details?.cached_tokens || 0 },
    output_tokens_details: { reasoning_tokens: u.reasoning_tokens || u.completion_tokens_details?.reasoning_tokens || 0 }
  } : { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}
function chatToResponses(json) {
  const respId = json.id || "resp_" + Date.now();
  const output = [];
  for (const choice of json.choices || []) {
    const msg = choice.message || {};
    if (msg.reasoning_content) {
      output.push({ id: "rs_" + respId + "_" + (choice.index || 0), type: "reasoning", status: "completed", summary: [], content: [{ type: "reasoning_text", text: msg.reasoning_content }] });
    }
    const item = { id: "msg_" + respId + "_" + (choice.index || 0), type: "message", role: msg.role || "assistant", status: "completed", content: [] };
    if (msg.content) item.content.push({ type: "output_text", text: msg.content, annotations: [] });
    if (msg.tool_calls) for (const tc of msg.tool_calls) output.push({ type: "function_call", id: tc.id, call_id: tc.id, name: tc.function?.name || "", arguments: tc.function?.arguments || "" });
    if (item.content.length) output.push(item);
  }
  return { id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: json.model, output, usage: usageFromChat(json.usage) };
}
function streamBuilder(res, opts = {}) {
  let buffer = "";
  let respId = "resp_" + Date.now();
  let model = opts.model || "";
  let created = false;
  let textItemStarted = false;
  let reasoningItemStarted = false;
  let text = "";
  let reasoning = "";
  const toolCalls = [];
  const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  function write(event, data) { res.write(sse(event, data)); }
  function ensureCreated() {
    if (created) return;
    created = true;
    write("response.created", { type: "response.created", response: { id: respId, object: "response", status: "in_progress", model, output: [] } });
  }
  function ensureReasoning() {
    ensureCreated();
    if (reasoningItemStarted) return;
    reasoningItemStarted = true;
    write("response.output_item.added", { type: "response.output_item.added", item: { id: "rs_" + respId, type: "reasoning", status: "in_progress", summary: [] }, output_index: 0 });
    write("response.reasoning_text.delta", { type: "response.reasoning_text.delta", item_id: "rs_" + respId, output_index: 0, content_index: 0, delta: "" });
  }
  function ensureText() {
    ensureCreated();
    if (textItemStarted) return;
    textItemStarted = true;
    const idx = reasoningItemStarted ? 1 : 0;
    write("response.output_item.added", { type: "response.output_item.added", item: { id: "msg_" + respId, type: "message", role: "assistant", status: "in_progress", content: [] }, output_index: idx });
    write("response.content_part.added", { type: "response.content_part.added", item_id: "msg_" + respId, output_index: idx, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  }
  function processChunk(data) {
    if (data.id && !respId.startsWith("chatcmpl")) respId = data.id;
    if (data.model) model = data.model;
    const u = data.usage || {};
    if (u.prompt_tokens || u.completion_tokens || u.total_tokens) {
      usage.input_tokens = u.prompt_tokens || usage.input_tokens;
      usage.output_tokens = u.completion_tokens || usage.output_tokens;
      usage.total_tokens = u.total_tokens || usage.total_tokens;
    }
    const delta = data.choices && data.choices[0] && data.choices[0].delta;
    if (!delta) return;
    if (delta.reasoning_content) {
      ensureReasoning();
      reasoning += delta.reasoning_content;
      write("response.reasoning_text.delta", { type: "response.reasoning_text.delta", item_id: "rs_" + respId, output_index: 0, content_index: 0, delta: delta.reasoning_content });
    }
    if (delta.content) {
      ensureText();
      text += delta.content;
      const idx = reasoningItemStarted ? 1 : 0;
      write("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_" + respId, output_index: idx, content_index: 0, delta: delta.content });
    }
    if (delta.tool_calls) {
      ensureCreated();
      for (const tc of delta.tool_calls) {
        const i = tc.index || 0;
        if (!toolCalls[i]) toolCalls[i] = { id: tc.id || ("call_" + Date.now() + "_" + i), name: "", args: "" };
        if (tc.function?.name) toolCalls[i].name += tc.function.name;
        if (tc.function?.arguments) toolCalls[i].args += tc.function.arguments;
      }
    }
  }
  function finish() {
    ensureCreated();
    const output = [];
    let idx = 0;
    if (reasoningItemStarted) {
      const item = { id: "rs_" + respId, type: "reasoning", status: "completed", summary: [], content: [{ type: "reasoning_text", text: reasoning }] };
      write("response.output_item.done", { type: "response.output_item.done", item, output_index: idx++ });
      output.push(item);
    }
    if (textItemStarted) {
      const item = { id: "msg_" + respId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      const textIdx = reasoningItemStarted ? 1 : 0;
      write("response.content_part.done", { type: "response.content_part.done", item_id: item.id, output_index: textIdx, content_index: 0, part: item.content[0] });
      write("response.output_item.done", { type: "response.output_item.done", item, output_index: textIdx });
      output.push(item);
      idx = Math.max(idx, textIdx + 1);
    }
    for (const tc of toolCalls.filter(Boolean)) output.push({ type: "function_call", id: tc.id, call_id: tc.id, name: tc.name, arguments: tc.args });
    write("response.completed", { type: "response.completed", response: { id: respId, object: "response", status: "completed", model, output, usage } });
    res.write("data: [DONE]\n\n");
  }
  return { processChunk, finish };
}
function modelListFromConfig(cfg) {
  const models = [];
  for (const [providerName, p] of Object.entries(cfg.providers || {})) {
    for (const id of p.models || []) {
      models.push({ id, object: "model", owned_by: providerName, slug: id, display_name: id, visibility: "list", capabilities: { supports_reasoning: false, supports_vision: false, supports_reasoning_summaries: false }, supported_reasoning_levels: [], supported_in_api: true, shell_type: "unified_exec", type: "chat", priority: 1, base_instructions: "", supports_reasoning_summaries: false, support_verbosity: false, supports_verbosity: false, supports_search: false, supports_image_generation: false, supports_computer_use: false, truncation_policy: { type: "auto", mode: "auto", threshold: 50000 } });
    }
  }
  return { object: "list", models };
}
module.exports = { responsesToChat, chatToResponses, streamBuilder, modelListFromConfig };
