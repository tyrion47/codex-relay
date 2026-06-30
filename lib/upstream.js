const providers = require("./providers");
class UpstreamError extends Error {
  constructor(msg, { status, provider, model, bodyText } = {}) { super(msg); this.status = status || 0; this.provider = provider; this.model = model; this.bodyText = bodyText; }
}
function withTimeout(ms) { const ac = new AbortController(); const t = setTimeout(() => ac.abort(new Error("timeout after " + ms + "ms")), ms); return { signal: ac.signal, clear: () => clearTimeout(t) }; }
async function callProvider({ providerName, providerCfg, chatBody, apiKey, timeoutMs, extraHeaders }) {
  const profile = providers[providerCfg.profile] || {};
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + (apiKey || "") };
  if (profile.extraHeaders) Object.assign(headers, profile.extraHeaders);
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const t = withTimeout(timeoutMs || 600000);
  let resp;
  try { resp = await fetch(providerCfg.baseUrl, { method: "POST", headers, body: JSON.stringify(chatBody), signal: t.signal }); }
  catch (e) { t.clear(); throw new UpstreamError(e.message, { provider: providerName }); }
  t.clear();
  if (!resp.ok) { let bt = ""; try { bt = await resp.text(); } catch {} throw new UpstreamError(`HTTP ${resp.status}`, { status: resp.status, provider: providerName, bodyText: bt }); }
  return resp;
}
async function callOpenAI({ baseUrl, apiKey, url, method, body, headers: extraH, timeoutMs }) {
  if (!apiKey) throw new Error("no openai key");
  const fullUrl = (baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "") + (url || "/responses");
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + apiKey };
  if (extraH) Object.assign(headers, extraH);
  const t = withTimeout(timeoutMs || 600000);
  let resp;
  try { resp = await fetch(fullUrl, { method: method || "POST", headers, body: body ? JSON.stringify(body) : undefined, signal: t.signal }); }
  catch (e) { t.clear(); throw new UpstreamError(e.message, { provider: "openai" }); }
  t.clear();
  if (!resp.ok) { let bt = ""; try { bt = await resp.text(); } catch {} throw new UpstreamError(`HTTP ${resp.status}`, { status: resp.status, provider: "openai", bodyText: bt }); }
  return resp;
}
module.exports = { callProvider, callOpenAI, UpstreamError };
