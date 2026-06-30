const providers = require("./providers");
const { parseTarget } = require("./config");
let getModelSignals = null;
function attachMetrics(fn) { getModelSignals = fn; }
function selectModel(body, cfg, routeKey) {
  if (!getModelSignals) return null;
  const as = cfg && cfg.adaptiveSelector;
  if (!as || !as.enabled) return null;
  const signals = getModelSignals(50);
  const candidates = [];
  for (const [pName, pCfg] of Object.entries(cfg.providers || {})) {
    const d = providers[pCfg.profile]; if (!d) continue;
    for (const model of pCfg.models || []) {
      if (routeKey === "image" && !d.vision) continue;
      if (routeKey === "think" && d.reasoning === "strip") continue;
      candidates.push({ provider: pName, model, profile: d, price: as.pricing && as.pricing[pName] && as.pricing[pName][model] });
    }
  }
  if (!candidates.length) return null;
  const successes = signals.filter((s) => s.result === "ok");
  const failures = new Set(signals.filter((s) => s.result === "fail").map((s) => s.provider + "/" + s.model));
  const recent = candidates.map((c) => {
    const key = c.provider + "/" + c.model;
    const fail = failures.has(key);
    const price = c.price !== undefined ? c.price : Infinity;
    const success = successes.filter((s) => s.provider + "/" + s.model === key);
    const avgLatency = success.length ? success.reduce((a, s) => a + (s.latencyMs || 0), 0) / success.length : 60000;
    const score = (fail ? 100000 : 0) + price * 1000 + avgLatency;
    return { ...c, score, fail };
  }).sort((a, b) => a.score - b.score);
  const best = recent[0];
  if (best && best.price !== Infinity && !best.fail) {
    const staticT = parseTarget(cfg.routes[routeKey] && cfg.routes[routeKey].target);
    if (staticT && staticT.provider === best.provider && staticT.model === best.model) return null;
    return { provider: best.provider, model: best.model, reason: "adaptive: " + (best.price ? `cheapest (${best.price})` : "latency optimized"), _routeKey: routeKey };
  }
  return null;
}
module.exports = { attachMetrics, selectModel };
