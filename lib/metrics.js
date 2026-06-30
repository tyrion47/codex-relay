const fs = require("fs");
const path = require("path");
let ringSize = 10000; let pricing = {}; let logDir; let points = [];
function configure(opts = {}) { if (opts.ringSize) ringSize = opts.ringSize; if (opts.pricing) pricing = opts.pricing; if (opts.logDir) logDir = opts.logDir; }
function record(p) { p.time = new Date().toISOString(); points.push(p); while (points.length > ringSize) points.shift(); }
function snapshot() { return { count: points.length, recent: points.slice(-12).reverse() }; }
function summary() {
  const byRoute = {}; const byProvider = {};
  for (const p of points) { const rk = p.route || "?"; const pk = p.provider || "?"; byRoute[rk] = (byRoute[rk] || 0) + 1; byProvider[pk] = (byProvider[pk] || 0) + 1; }
  return { totalRequests: points.length, byRoute, byProvider };
}
function modelSignals(n) { return points.slice(-n).map((p) => ({ provider: p.provider, model: p.model, result: p.result, latencyMs: p.latencyMs, errorText: p.errorText })); }
function warmLoad() { if (logDir) try { const today = new Date().toISOString().slice(0, 10); const files = fs.readdirSync(logDir).filter((f) => f.startsWith("metrics-" + today) && f.endsWith(".jsonl")); for (const f of files) { const raw = fs.readFileSync(path.join(logDir, f), "utf8"); for (const line of raw.trim().split("\n")) { try { points.push(JSON.parse(line)); } catch {} } } } catch {} }
function rollup() { if (logDir) try { fs.mkdirSync(logDir, { recursive: true }); const today = new Date().toISOString().slice(0, 10); const dest = path.join(logDir, `metrics-${today}.jsonl`); fs.appendFileSync(dest, points.map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8"); } catch {} }
module.exports = { configure, record, snapshot, summary, modelSignals, warmLoad, rollup };
