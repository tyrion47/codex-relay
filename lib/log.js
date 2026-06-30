const fs = require("fs");
const path = require("path");
const { ROOT } = require("./config");
let level = "info";
let maxChars = 800;
let logStream = null;
function ts() { return new Date().toISOString(); }
function format(entry) { return JSON.stringify({ ...entry, time: ts() }) + "\n"; }
function maybeTruncate(s) { if (typeof s === "string" && s.length > maxChars) return s.slice(0, maxChars) + "..."; return s; }
function write(entry) { const line = format(entry); if (logStream) logStream.write(line); if (level === "debug") process.stderr.write(line); }
module.exports = {
  configure(cfg) { if (cfg) { level = cfg.level || level; maxChars = cfg.maxChars || maxChars; if (cfg.stream) logStream = cfg.stream; } },
  debug(msg, m) { if (level === "debug") write({ level: "debug", msg, ...(m || {}) }); },
  info(msg, m) { if (level === "debug" || level === "info") write({ level: "info", msg, ...(m || {}) }); },
  warn(msg, m) { write({ level: "warn", msg, detail: maybeTruncate((m && m.error) || "") }); },
  error(msg, m) { write({ level: "error", msg, error: (m && m.error) || msg }); }
};
