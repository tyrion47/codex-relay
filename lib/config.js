const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const providers = require("./providers");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const SECRETS_PATH = path.join(ROOT, "secrets.json");
const CANONICAL_ROOT = path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex-relay");
const IS_CANONICAL = path.resolve(ROOT).toLowerCase() === path.resolve(CANONICAL_ROOT).toLowerCase();
const ROUTE_KEYS = ["default", "background", "think", "longContext", "webSearch", "image"];

function readRaw(p) {
  let raw = fs.readFileSync(p, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return raw;
}
function hashOf(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
function parseTarget(target) {
  if (typeof target !== "string" || target.indexOf(",") === -1) return null;
  const i = target.indexOf(",");
  return { provider: target.slice(0, i), model: target.slice(i + 1) };
}
function validate(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== "object") return { ok: false, errors: ["config is not an object"] };
  if (!cfg.providers || typeof cfg.providers !== "object") errors.push("missing providers{}");
  if (!cfg.routes || typeof cfg.routes !== "object") errors.push("missing routes{}");
  for (const name of Object.keys(cfg.providers || {})) {
    const p = cfg.providers[name];
    if (!p.baseUrl) errors.push(`provider ${name}: missing baseUrl`);
    if (!p.profile) errors.push(`provider ${name}: missing profile`);
    else if (!providers[p.profile]) errors.push(`provider ${name}: unknown profile ${p.profile}`);
    if (!Array.isArray(p.models) || !p.models.length) errors.push(`provider ${name}: empty models[]`);
  }
  for (const key of ROUTE_KEYS) {
    const r = cfg.routes && cfg.routes[key];
    if (!r) { errors.push(`route ${key}: missing`); continue; }
    const t = parseTarget(r.target);
    if (!t) { errors.push(`route ${key}: target must be provider,model`); continue; }
    const p = cfg.providers && cfg.providers[t.provider];
    if (!p) { errors.push(`route ${key}: provider ${t.provider} not defined`); continue; }
    if (Array.isArray(p.models) && !p.models.includes(t.model)) errors.push(`route ${key}: model ${t.model} not in ${t.provider}.models[]`);
    if (r.fallback && !["off", "chain", "openai"].includes(r.fallback)) errors.push(`route ${key}: fallback must be off|chain|openai`);
    if (r.fallback === "chain") {
      const ft = parseTarget(r.fallbackTarget);
      if (!ft) errors.push(`route ${key}: fallbackTarget must be provider,model`);
      else if (!cfg.providers[ft.provider]) errors.push(`route ${key}: fallbackTarget provider ${ft.provider} not defined`);
      else if (!cfg.providers[ft.provider].models.includes(ft.model)) errors.push(`route ${key}: fallbackTarget model ${ft.model} not in provider`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
function load() {
  const raw = readRaw(CONFIG_PATH);
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { throw new Error(`config.json is not valid JSON: ${e.message}`); }
  const v = validate(cfg);
  if (!v.ok) throw new Error("config.json failed validation:\n  - " + v.errors.join("\n  - "));
  return { cfg, hash: hashOf(raw) };
}
function loadSecrets() {
  try { return JSON.parse(readRaw(SECRETS_PATH)); } catch { return {}; }
}
function writeJsonAtomic(p, obj) {
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);
}
module.exports = { ROOT, CONFIG_PATH, SECRETS_PATH, CANONICAL_ROOT, IS_CANONICAL, ROUTE_KEYS, readRaw, hashOf, parseTarget, validate, load, loadSecrets, writeJsonAtomic };
