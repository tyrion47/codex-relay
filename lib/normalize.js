const providers = require("./providers");
function normalizeRequest(chatBody, profile, opts = {}) {
  const d = providers[profile] || {};
  if (opts.dropTools) {
    delete chatBody.tools; delete chatBody.tool_choice;
  }
  if (d.fixedTemperature != null) chatBody.temperature = d.fixedTemperature;
  const hasTools = Array.isArray(chatBody.tools) && chatBody.tools.length > 0;
  if (hasTools && d.toolMaxTokensFloor && (!chatBody.max_tokens || chatBody.max_tokens < d.toolMaxTokensFloor)) {
    chatBody.max_tokens = d.toolMaxTokensFloor;
  }
  if (chatBody.max_tokens && d.maxTokens && chatBody.max_tokens > d.maxTokens) chatBody.max_tokens = d.maxTokens;
  const wantThinking = !!opts.wantThinking;
  const reasoningEffort = opts.reasoningEffort || "high";
  delete chatBody._thinkingEnabled; delete chatBody._thinkingEffort;
  let thinkingExpected = false;
  switch (d.reasoning) {
    case "deepseekThinking":
      if (wantThinking) {
        thinkingExpected = true;
        chatBody.thinking = { type: "enabled" };
        chatBody.reasoning_effort = reasoningEffort;
      } else {
        chatBody.thinking = { type: "disabled" };
        delete chatBody.reasoning_effort;
      }
      delete chatBody.reasoning;
      break;
    case "native":
      thinkingExpected = wantThinking;
      delete chatBody.reasoning; delete chatBody.reasoning_effort; delete chatBody.thinking;
      break;
    case "effort":
      if (wantThinking) { thinkingExpected = true; const allowed = d.effort || ["high"]; chatBody.reasoning = { effort: allowed.includes(reasoningEffort) ? reasoningEffort : allowed[0] }; }
      else delete chatBody.reasoning;
      delete chatBody.reasoning_effort; delete chatBody.thinking;
      break;
    case "maxtok":
      if (wantThinking) { thinkingExpected = true; chatBody.reasoning = { max_tokens: d.reasoningBudget || 1024 }; }
      else delete chatBody.reasoning;
      delete chatBody.reasoning_effort; delete chatBody.thinking;
      break;
    case "chatTemplate":
      { const key = d.thinkingKey || "enable_thinking"; const pt = hasTools && opts.disableThinkingForTools ? false : wantThinking; thinkingExpected = pt;
        chatBody.chat_template_kwargs = Object.assign({}, chatBody.chat_template_kwargs, { [key]: pt });
        if (pt) { if (d.reasoningEffort) chatBody.chat_template_kwargs.reasoning_effort = d.reasoningEffort; if (d.reasoningBudget) chatBody.reasoning_budget = d.reasoningBudget; }
        else { delete chatBody.chat_template_kwargs; delete chatBody.reasoning_budget; } }
      delete chatBody.reasoning; delete chatBody.reasoning_effort; delete chatBody.thinking;
      break;
    case "thinkingEffort":
      thinkingExpected = wantThinking;
      chatBody.thinking = { type: wantThinking ? "enabled" : "disabled" };
      if (wantThinking) { const allowed = d.effort || ["high", "max"]; chatBody.reasoning_effort = allowed.includes(reasoningEffort) ? reasoningEffort : allowed[allowed.length - 1]; }
      else delete chatBody.reasoning_effort;
      delete chatBody.reasoning;
      break;
    case "responses": thinkingExpected = wantThinking; break;
    default:
      delete chatBody.reasoning; delete chatBody.reasoning_effort; delete chatBody.thinking;
  }
  if (d.extraBody && typeof d.extraBody === "object") Object.assign(chatBody, d.extraBody);
  if (chatBody.stream) chatBody.stream_options = { include_usage: true };
  if (typeof chatBody.model === "string" && chatBody.model.indexOf(",") !== -1) chatBody.model = chatBody.model.split(",")[1];
  return { thinkingExpected };
}
module.exports = { normalizeRequest };
