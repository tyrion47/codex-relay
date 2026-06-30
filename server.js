#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const path = require("path");
const cfgmod = require("./lib/config");
const log = require("./lib/log");
const router = require("./lib/router");
const { responsesToChat, chatToResponses, streamBuilder, modelListFromConfig } = require("./lib/translate");
const { normalizeRequest } = require("./lib/normalize");
const { callProvider, callOpenAI, UpstreamError } = require("./lib/upstream");
const providerDescriptors = require("./lib/providers");
const metrics = require("./lib/metrics");
const quota = require("./lib/quota");
const adaptiveSelector = require("./lib/adaptive-selector");

const LOCK_PATH = path.join(cfgmod.ROOT, "relay.lock");
const state = { cfg: null, hash: null, secrets: {}, boundPort: null, startedAt: new Date().toISOString(), routeStats: {}, cooldowns: {} };
function statFor(key) {
  if (!state.routeStats[key]) state.routeStats[key] = { requests: 0, errors: 0, fallbacks: 0, lastResult: "unknown", lastResultAt: null, lastModel: null, lastError: null, lastErrorAt: null };
  return state.routeStats[key];
}
function resolveKey(providerName, providerCfg) {
  if (state.secrets[providerName]) return state.secrets[providerName];
  if (providerCfg && providerCfg.keyAlias && state.secrets[providerCfg.keyAlias]) return state.secrets[providerCfg.keyAlias];
  if (providerCfg && /openrouter\.ai/i.test(providerCfg.baseUrl || "")) return state.secrets["openrouter-paid"] || state.secrets.openrouter;
  if (providerCfg && state.secrets[providerCfg.profile]) return state.secrets[providerCfg.profile];
  return state.secrets[providerName];
}
const QUOTA_LADDERS = {
  default: [{ p: 0.0, model: "glm-5.2" }, { p: 0.6, model: "glm-5.1" }, { p: 0.8, model: "glm-5-turbo" }, { p: 0.95, divert: "openrouter-paid,deepseek/deepseek-v4-flash" }],
  background: [{ p: 0.0, model: "glm-4.7" }, { p: 0.5, model: "glm-4.5-air" }, { p: 0.8, divert: "openrouter-paid,deepseek/deepseek-v4-flash" }],
  think: [{ p: 0.0, model: "glm-5.1" }, { p: 0.65, model: "glm-5-turbo" }, { p: 0.85, divert: "openrouter-paid,deepseek/deepseek-v4-flash" }, { p: 0.95, divert: "openrouter-paid,deepseek/deepseek-v4-pro" }],
  longContext: [{ p: 0.0, model: null }, { p: 0.95, divert: "openrouter-paid,deepseek/deepseek-v4-flash" }],
  webSearch: [{ p: 0.0, model: "glm-4.7" }, { p: 0.7, model: "glm-4.5-air" }, { p: 0.9, divert: "openrouter-paid,deepseek/deepseek-v4-flash" }],
  image: [{ p: 0.0, model: "glm-5.2" }, { p: 0.9, divert: null }]
};

function loadAll() {
  const { cfg, hash } = cfgmod.load();
  state.cfg = cfg; state.hash = hash; state.secrets = cfgmod.loadSecrets();
  log.configure({ level: cfg.logLevel, maxChars: cfg.logBodyMaxChars });
  metrics.configure({ ringSize: (cfg.metrics && cfg.metrics.ringSize) || 10000, pricing: cfg.pricing || {}, logDir: path.join(cfgmod.ROOT, "logs") });
  const qg = cfg.quotaGuard || {};
  quota.configure({ enabled: !!qg.enabled, provider: qg.provider, windowHours: qg.windowHours, messageCap: qg.messageCap, tokenCap: qg.tokenCap, logDir: path.join(cfgmod.ROOT, "logs") });
}
function watchConfig() {
  let timer; try {
    fs.watch(cfgmod.ROOT, { persistent: true }, (evt, file) => { if (file && file !== "config.json" && file !== "secrets.json") return; clearTimeout(timer); timer = setTimeout(() => { try { const before = state.hash; loadAll(); if (state.hash !== before) log.info("config hot-reloaded", { hash: state.hash }); } catch (e) { log.error("config reload rejected", { error: e.message }); } }, 200); });
  } catch (e) { log.warn("config watch unavailable", { error: e.message }); }
}
function sendJson(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0;
    req.on("data", (c) => { total += c.length; if (maxBytes && total > maxBytes) { const e = new Error("body too large"); req.destroy(e); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function pumpStream(upstream, builder, res, signal) {
  const reader = upstream.body.getReader(); const decoder = new TextDecoder(); let buf = "";
  try {
    while (true) { if (signal && signal.aborted) break; const { done, value } = await reader.read(); if (done) break; buf += decoder.decode(value, { stream: true }); const lines = buf.split("\n"); buf = lines.pop() || ""; for (let line of lines) { line = line.trim(); if (!line.startsWith("data: ")) continue; const d = line.slice(6).trim(); if (d === "[DONE]") continue; try { builder.processChunk(JSON.parse(d)); } catch {} } }
    builder.finish(); res.end();
  } catch (e) { try { await reader.cancel(); } catch {} throw e; }
}

async function handleResponses(req, res, rawBuf) {
  let body; try { body = JSON.parse(rawBuf.toString("utf8")); } catch { return sendJson(res, 400, { error: "not JSON" }); }
  const routeKey = router.selectRoute(body, state.cfg); const st = statFor(routeKey); st.requests++;
  const route = state.cfg.routes[routeKey]; const staticTarget = cfgmod.parseTarget(route.target);
  let target = { ...staticTarget }; let providerCfg = state.cfg.providers[target.provider];
  if (!providerCfg) { st.errors++; st.lastResult = "fail"; return sendJson(res, 502, { error: `provider ${target.provider} not defined` }); }
  const isStream = body.stream === true;
  const inputTokens = router.estimateTokens(body);
  const reqStart = Date.now(); let firstByteAt = 0;
  const _origWrite = res.write.bind(res);
  res.write = (chunk, ...rest) => { if (!firstByteAt && chunk && chunk.length) firstByteAt = Date.now(); return _origWrite(chunk, ...rest); };
  const elapsed = () => Date.now() - reqStart;
  const routeOpts = { maxOutputTokens: route.maxOutputTokens, reasoningBudget: route.reasoningBudget };
  let dropTools = !!route.dropTools;

  // Quota ladder
  let quotaDiverted = false;
  if (state.cfg.quotaGuard && state.cfg.quotaGuard.enabled && target.provider === state.cfg.quotaGuard.provider) {
    const p = quota.pressure(); const ladder = QUOTA_LADDERS[routeKey]; if (ladder) { let rung = ladder[0]; for (const r of ladder) { if (p >= r.p) rung = r; } if (rung.model && rung.model !== target.model) { st.lastModel = rung.model; log.info("quota model downgrade", { from: target.model, to: rung.model }); } if (rung.divert) { const dt = cfgmod.parseTarget(rung.divert); if (dt && state.cfg.providers[dt.provider]) { quotaDiverted = true; target.provider = dt.provider; target.model = dt.model; providerCfg = state.cfg.providers[dt.provider]; } } }
  }

  const providerDesc = providerDescriptors[providerCfg.profile] || {};
  const wantThinking = router.hasThinking(body);
  const reasoningEffort = body.reasoning_effort || body.reasoning?.effort || "high";
  let chatBody = responsesToChat(body);
  chatBody.model = target.model;
  let thinkingExpected = false;
  ({ thinkingExpected } = normalizeRequest(chatBody, providerCfg.profile, { dropTools, disableThinkingForTools: true, wantThinking, reasoningEffort }));

  log.info("route", { route: routeKey, provider: target.provider, model: target.model, stream: isStream, thinking: thinkingExpected, inputTokens });
  st.lastModel = target.model;

  async function serve(prov, mdl, cb) {
    const pCfg = state.cfg.providers[prov]; if (!pCfg) throw new Error(`provider ${prov} not defined`);
    const upstream = await callProvider({ providerName: prov, providerCfg: pCfg, chatBody: cb, apiKey: resolveKey(prov, pCfg), timeoutMs: state.cfg.requestTimeoutMs });
    if (isStream) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const builder = streamBuilder(res, { model: mdl });
      await pumpStream(upstream, builder, res);
      return { inputTokens: inputTokens, outputTokens: builder._outputTokens || 0 };
    }
    const json = await upstream.json();
    const resp = chatToResponses(json);
    return sendJson(res, 200, resp), { inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens };
  }

  try {
    const m = await serve(target.provider, target.model, chatBody);
    st.lastResult = "ok"; st.lastResultAt = new Date().toISOString();
    metrics.record({ route: routeKey, provider: target.provider, model: target.model, result: "ok", inputTokens: m.inputTokens, outputTokens: m.outputTokens, latencyMs: elapsed() });
    quota.record(target.provider, { inputTokens, outputTokens: m.outputTokens, result: "ok" });
  } catch (e) {
    st.errors++; st.lastResult = "fail"; st.lastResultAt = new Date().toISOString(); st.lastError = e.message; st.lastErrorAt = st.lastResultAt;
    log.warn("provider failed", { route: routeKey, provider: target.provider, model: target.model, status: e.status, error: e.message });
    const policy = route.fallback || "off";
    // Chain fallback
    if (policy === "chain" && !res.headersSent) {
      const ft = cfgmod.parseTarget(route.fallbackTarget);
      if (ft && state.cfg.providers[ft.provider]) {
        try { st.fallbacks++; log.warn("FALLBACK -> chain", { route: routeKey, target: route.fallbackTarget }); const fbCfg = state.cfg.providers[ft.provider]; const fbDesc = providerDescriptors[fbCfg.profile] || {}; let fbBody = responsesToChat(body); fbBody.model = ft.model; normalizeRequest(fbBody, fbCfg.profile, { dropTools, disableThinkingForTools: true, wantThinking, reasoningEffort }); const cm = await serve(ft.provider, ft.model, fbBody); st.lastResult = "fallback-chain"; st.lastResultAt = new Date().toISOString(); metrics.record({ route: routeKey, provider: ft.provider, model: ft.model, result: "fallback-chain", inputTokens: cm.inputTokens, outputTokens: cm.outputTokens, latencyMs: elapsed() }); return; }
        catch (ce) { log.error("chain fallback also failed", { target: route.fallbackTarget, error: ce.message }); }
      }
    }
    // OpenAI fallback
    if (policy === "openai" && state.secrets.openai && !res.headersSent) {
      try { st.fallbacks++; log.warn("FALLBACK -> OpenAI"); const apiResp = await callOpenAI({ baseUrl: state.cfg.openaiBaseUrl || "https://api.openai.com/v1", apiKey: state.secrets.openai, url: "/responses", method: "POST", body, timeoutMs: state.cfg.requestTimeoutMs }); const ct = apiResp.headers.get("content-type") || "application/json"; res.writeHead(apiResp.status, { "Content-Type": ct, "Cache-Control": "no-cache" }); const reader = apiResp.body.getReader(); while (true) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); } res.end(); st.lastResult = "fallback-openai"; return; }
      catch (fe) { log.error("OpenAI fallback also failed", { error: fe.message }); }
    }
    if (!res.headersSent) sendJson(res, 502, { error: { message: e.message } });
    else if (!res.writableEnded) res.end();
  }
}

function health() {
  const routes = {}; for (const key of cfgmod.ROUTE_KEYS) { const r = state.cfg.routes[key] || {}; const s = state.routeStats[key] || {}; routes[key] = { target: r.target, fallback: r.fallback || "off", lastResult: s.lastResult || "unknown", lastResultAt: s.lastResultAt, lastError: s.lastError, requests: s.requests, errors: s.errors, fallbacks: s.fallbacks }; }
  return { status: "ok", service: "codex-relay", pid: process.pid, host: state.cfg.host, port: state.cfg.port, startedAt: state.startedAt, uptimeSec: Math.round(process.uptime()), configHash: state.hash, fallbackEnabled: !!state.secrets.openai, routes, cooldowns: state.cooldowns, quota: quota.snapshot(), metricsSummary: metrics.summary() };
}

async function makeServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = (req.url || "").split("?")[0];
      const isAdmin = url.startsWith("/__relay/") && url !== "/__relay/health" && url !== "/__relay/metrics";
      const loopback = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket?.remoteAddress || "");
      if (isAdmin && !loopback) return sendJson(res, 403, { error: "admin endpoints are loopback-only" });

      if (req.method === "GET" && url === "/__relay/health") return sendJson(res, 200, health());
      if (req.method === "GET" && url === "/health") return sendJson(res, 200, { status: "ok" });
      if (req.method === "GET" && url === "/__relay/metrics") return sendJson(res, 200, metrics.snapshot());
      const maxBytes = (state.cfg && state.cfg.maxBodyBytes) || 33554432;

      // UI
      if (req.method === "GET" && url === "/__relay/ui") {
        const html = fs.readFileSync(path.join(cfgmod.ROOT, "ui.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        return res.end(html);
      }
      // Config read/write
      if (req.method === "GET" && url === "/__relay/config") return sendJson(res, 200, { config: state.cfg, hash: state.hash, routes: cfgmod.ROUTE_KEYS });
      if (req.method === "PUT" && url === "/__relay/config") {
        const raw = await readBody(req, maxBytes);
        let body; try { body = JSON.parse(raw.toString("utf8")); } catch (e) { return sendJson(res, 400, { ok: false, errors: ["bad JSON"] }); }
        const v = cfgmod.validate(body);
        if (!v.ok) return sendJson(res, 200, { ok: false, errors: v.errors });
        cfgmod.writeJsonAtomic(cfgmod.CONFIG_PATH, body);
        loadAll();
        return sendJson(res, 200, { ok: true, hash: state.hash });
      }
      // Secrets
      if (req.method === "GET" && url === "/__relay/secrets") {
        const s = cfgmod.loadSecrets(); const out = {};
        for (const k of Object.keys(s)) { if (k.startsWith("_")) continue; out[k] = !!s[k]; }
        return sendJson(res, 200, { secrets: out });
      }
      if (req.method === "PUT" && url === "/__relay/secrets") {
        const raw = await readBody(req, maxBytes);
        let body; try { body = JSON.parse(raw.toString("utf8")); } catch (e) { return sendJson(res, 400, { ok: false, errors: ["bad JSON"] }); }
        const s = cfgmod.loadSecrets();
        for (const k of Object.keys(body)) { if (body[k] === "") delete s[k]; else s[k] = body[k]; }
        cfgmod.writeJsonAtomic(cfgmod.SECRETS_PATH, s);
        state.secrets = s;
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.startsWith("/v1/models")) return sendJson(res, 200, modelListFromConfig(state.cfg));
      if (req.method === "GET") return sendJson(res, 200, { status: "ok", proxy: "codex-relay" });
      if (req.method === "POST" && url === "/v1/responses") { const raw = await readBody(req, maxBytes); return handleResponses(req, res, raw); }
      sendJson(res, 404, { error: "not found" });
    } catch (e) { if (!res.headersSent) sendJson(res, 500, { error: e.message }); else if (!res.writableEnded) res.end(); }
  });
}
function writeLock() { try { cfgmod.writeJsonAtomic(LOCK_PATH, { pid: process.pid, configHash: state.hash, startedAt: state.startedAt, host: state.cfg.host, port: state.cfg.port }); } catch {} }
function clearLock() { try { fs.unlinkSync(LOCK_PATH); } catch {} }
function main() {
  if (!cfgmod.IS_CANONICAL && !process.env.RELAY_FORCE_LOCAL) { console.error(`refusing to start: ${cfgmod.ROOT} is not ${cfgmod.CANONICAL_ROOT}. set RELAY_FORCE_LOCAL=1 to override.`); process.exit(6); }
  loadAll();
  fs.mkdirSync(path.join(cfgmod.ROOT, "logs"), { recursive: true });
  const logStream = fs.createWriteStream(path.join(cfgmod.ROOT, "logs", "relay-" + new Date().toISOString().slice(0, 10) + ".log"), { flags: "a" });
  log.configure({ level: state.cfg.logLevel, maxChars: state.cfg.logBodyMaxChars, stream: logStream });
  metrics.warmLoad(); quota.warmLoad(); adaptiveSelector.attachMetrics(() => metrics.modelSignals(50));
  makeServer().then(server => {
    server.on("error", (e) => { if (e.code === "EADDRINUSE") { log.error("port in use"); process.exit(3); } process.exit(1); });
    server.listen(state.cfg.port, state.cfg.host, () => { state.boundPort = state.cfg.port; writeLock(); watchConfig(); log.info("codex-relay up", { host: state.cfg.host, port: state.cfg.port, hash: state.hash }); });
    const shutdown = (sig) => () => { log.info("shutting down", { sig }); try { metrics.rollup(); quota.save(); } catch {} clearLock(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
    process.on("SIGINT", shutdown("SIGINT")); process.on("SIGTERM", shutdown("SIGTERM")); process.on("exit", clearLock);
  });
}
if (require.main === module) main();
module.exports = { makeServer, loadAll, state, health };
