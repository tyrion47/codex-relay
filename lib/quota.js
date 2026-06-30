const fs = require("fs");
const path = require("path");
let enabled = false; let provider = ""; let windowHours = 5; let messageCap = 500; let tokenCap = 1000000; let logDir;
let usage = { messages: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
function configure(opts = {}) { if (opts.enabled !== undefined) enabled = opts.enabled; if (opts.provider) provider = opts.provider; if (opts.windowHours) windowHours = opts.windowHours; if (opts.messageCap) messageCap = opts.messageCap; if (opts.tokenCap) tokenCap = opts.tokenCap; if (opts.logDir) logDir = opts.logDir; }
function record(prov, m) { if (!enabled || prov !== provider) return; usage.messages++; usage.inputTokens += (m.inputTokens || 0); usage.outputTokens += (m.outputTokens || 0); usage.totalTokens = usage.inputTokens + usage.outputTokens; }
function recordObservedCap(msgs, tokens) { usage.messages = Math.max(usage.messages, msgs); usage.totalTokens = Math.max(usage.totalTokens, tokens); }
function pressure() { return Math.max(usage.messages / (messageCap || 1), usage.totalTokens / (tokenCap || 1)); }
function snapshot() { return { ...usage, pressure: Number(pressure().toFixed(3)), windowHours, messageCap, tokenCap }; }
function warmLoad() { if (logDir) try { const today = new Date().toISOString().slice(0, 10); const files = fs.readdirSync(logDir).filter((f) => f.startsWith("quota-" + today) && f.endsWith(".json")); for (const f of files) { try { const d = JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8")); usage = d; } catch {} } } catch {} }
function save() { if (logDir) try { fs.mkdirSync(logDir, { recursive: true }); const today = new Date().toISOString().slice(0, 10); fs.writeFileSync(path.join(logDir, `quota-${today}.json`), JSON.stringify(usage), "utf8"); } catch {} }
module.exports = { configure, record, recordObservedCap, pressure, snapshot, warmLoad, save };
