function anyImage(input) { return Array.isArray(input) && input.some((i) => i.content && Array.isArray(i.content) && i.content.some((c) => c.type === "input_image" || c.type === "image_url")); }
function estimateTokens(body) {
  let chars = 0; const add = (s) => { if (typeof s === "string") chars += s.length; };
  add(body.instructions);
  for (const item of body.input || []) {
    if (typeof item.content === "string") add(item.content);
    else if (Array.isArray(item.content)) for (const c of item.content) { if (c.text) add(c.text); else if (c.type && /image/.test(c.type)) chars += 1600; else add(JSON.stringify(c)); }
  }
  if (Array.isArray(body.tools)) add(JSON.stringify(body.tools));
  return Math.ceil(chars / 4);
}
function hasWebSearch(body) { return Array.isArray(body.tools) && body.tools.some((t) => /web.?search/i.test(t.name || "")); }
function hasThinking(body) { return body.reasoning && (body.reasoning.effort || body.reasoning.max_tokens || body.reasoning.summary); }
function isBackground(body) { return body.model && /haiku|flash|small|turbo|mini/i.test(body.model); }
function selectRoute(body, cfg) {
  const threshold = (cfg && cfg.longContextThreshold) || 60000;
  if (anyImage(body.input)) return "image";
  if (estimateTokens(body) > threshold) return "longContext";
  if (hasWebSearch(body)) return "webSearch";
  if (hasThinking(body)) return "think";
  if (isBackground(body)) return "background";
  return "default";
}
module.exports = { selectRoute, anyImage, estimateTokens, hasWebSearch, hasThinking };
