#!/usr/bin/env node
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const path = require("path");
const cfgmod = require("./lib/config");
const SERVER = path.join(cfgmod.ROOT, "server.js");
function getHealth(port, host) {
  return new Promise((resolve) => {
    const req = http.get({ host: host || "127.0.0.1", port, path: "/__relay/health", timeout: 1500 }, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
    req.on("error", () => resolve(null)); req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}
function getPortHolder(port) {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", `$c=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue|select -First 1; if($c){$p=Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue;[pscustomobject]@{pid=$c.OwningProcess;name=$p.ProcessName}|ConvertTo-Json -Compress}`], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  try { return JSON.parse(r.stdout.trim()); } catch { return null; }
}
function tryKill(pid) { const r = spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction Stop`], { encoding: "utf8" }); return { ok: r.status === 0, err: r.stderr && r.stderr.trim() }; }
function spawnDaemon() { const c = spawn(process.execPath, [SERVER], { detached: true, stdio: "ignore", windowsHide: true }); c.unref(); return c.pid; }
async function waitHealthy(port, host, ms) { const dl = Date.now() + ms; while (Date.now() < dl) { const h = await getHealth(port, host); if (h && h.status === "ok") return h; await new Promise((r) => setTimeout(r, 250)); } return null; }
async function cmdUp() {
  let cfg, hash; try { ({ cfg, hash } = cfgmod.load()); } catch (e) { console.error("config.json invalid:\n" + e.message); process.exit(2); }
  const { host, port } = cfg;
  const h = await getHealth(port, host);
  if (h && h.service === "codex-relay") { if (h.configHash === hash) { console.log(`relay already up (pid ${h.pid}), serving current config ${hash}.`); return; } console.log(`relay up (pid ${h.pid}) was serving ${h.configHash}; hot-reloading...`); const after = await waitHealthy(port, host, 2000); console.log(`now serving ${after ? after.configHash : "?"} (expected ${hash}).`); return; }
  if (h) { const holder = getPortHolder(port); console.error(`Port ${port} held by non-relay process${holder ? ` (pid ${holder.pid}, ${holder.name})` : ""}.\nSet a different port in config.json.`); process.exit(3); }
  const holder = getPortHolder(port);
  if (holder && holder.pid) { console.log(`Port ${port} held by pid ${holder.pid} (${holder.name}) -- stopping...`); const k = tryKill(holder.pid); if (!k.ok) { console.error(`Could not stop pid ${holder.pid}: ${k.err}.\nRun as Administrator:\n  Stop-Process -Id ${holder.pid} -Force`); process.exit(4); } console.log(`Stopped pid ${holder.pid}.`); await new Promise((r) => setTimeout(r, 500)); }
  const pid = spawnDaemon();
  const healthy = await waitHealthy(port, host, 8000);
  if (!healthy) { console.error(`Spawned daemon (pid ${pid}) but not healthy on ${host}:${port}. Check logs/relay-*.log`); process.exit(5); }
  console.log(`codex-relay up: pid ${healthy.pid}, ${host}:${port}, config ${healthy.configHash}, fallback ${healthy.fallbackEnabled ? "ON" : "OFF"}.`);
}
async function cmdDown() {
  let cfg; try { ({ cfg } = cfgmod.load()); } catch { cfg = { host: "127.0.0.1", port: 9001 }; }
  const { host, port } = cfg;
  const h = await getHealth(port, host);
  if (h && h.service === "codex-relay") { const k = tryKill(h.pid); console.log(k.ok ? `Stopped pid ${h.pid}.` : `Could not stop: ${k.err}`); return; }
  const holder = getPortHolder(port);
  if (holder && holder.pid) { const k = tryKill(holder.pid); console.log(k.ok ? `Stopped pid ${holder.pid}.` : `Could not stop: ${k.err}`); }
  else console.log("codex-relay is not running.");
}
async function cmdRestart() { await cmdDown(); await new Promise((r) => setTimeout(r, 600)); return cmdUp(); }
async function cmdStatus() {
  let cfg; try { ({ cfg } = cfgmod.load()); } catch { cfg = { host: "127.0.0.1", port: 9001 }; }
  const h = await getHealth(cfg.port, cfg.host);
  if (!h || h.service !== "codex-relay") { console.log("codex-relay DOWN."); return; }
  let onDisk = "?"; try { onDisk = cfgmod.load().hash; } catch {}
  console.log(`codex-relay UP  pid ${h.pid}  ${h.host}:${h.port}  uptime ${h.uptimeSec}s`);
  console.log(`config: serving ${h.configHash}  on-disk ${onDisk}  ${h.configHash === onDisk ? "(sync)" : "(STALE)"}`);
  console.log(`fallback-to-OpenAI: ${h.fallbackEnabled ? "ON" : "OFF (secrets.openai empty)"}`);
  console.log("routes:");
  for (const k of cfgmod.ROUTE_KEYS) { const r = h.routes[k]; console.log(`  ${k.padEnd(12)} -> ${String(r.target).padEnd(48)} [${r.lastResult}]  req ${r.requests||0} err ${r.errors||0} fb ${r.fallbacks||0}`); }
}
function cmdModel(route, target) {
  if (!cfgmod.ROUTE_KEYS.includes(route)) { console.error(`unknown route "${route}". one of: ${cfgmod.ROUTE_KEYS.join(", ")}`); process.exit(2); }
  const t = cfgmod.parseTarget(target);
  if (!t) { console.error(`target must be "provider,model" (got ${target})`); process.exit(2); }
  const { cfg } = cfgmod.load();
  const prov = cfg.providers[t.provider];
  if (!prov) { console.error(`provider "${t.provider}" not defined`); process.exit(2); }
  if (!prov.models.includes(t.model)) { prov.models.push(t.model); console.log(`(added ${t.model} to ${t.provider} catalog)`); }
  cfg.routes[route].target = `${t.provider},${t.model}`;
  const v = cfgmod.validate(cfg);
  if (!v.ok) { console.error("invalid:\n  - " + v.errors.join("\n  - ")); process.exit(2); }
  cfgmod.writeJsonAtomic(cfgmod.CONFIG_PATH, cfg);
  console.log(`route ${route} -> ${t.provider},${t.model}. Daemon hot-reloads (no restart).`);
}
async function main() {
  if (!cfgmod.IS_CANONICAL && !process.env.RELAY_FORCE_LOCAL) {
    const canonicalCli = path.join(cfgmod.CANONICAL_ROOT, "cli.js");
    if (require("fs").existsSync(canonicalCli)) { const r = spawnSync(process.execPath, [canonicalCli, ...process.argv.slice(2)], { stdio: "inherit" }); process.exit(r.status == null ? 1 : r.status); }
  }
  const [cmd, a, b] = process.argv.slice(2);
  switch (cmd) {
    case "up": return cmdUp();
    case "down": case "stop": return cmdDown();
    case "restart": return cmdRestart();
    case "status": return cmdStatus();
    case "model": return cmdModel(a, b);
    case "mode": {
      const shim = path.join(cfgmod.ROOT, "codex-shims.ps1");
      const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", shim, "mode", a || "status"], { stdio: "inherit" });
      process.exit(r.status || 0);
    }
    default: console.log("usage: relay-codex <up|down|restart|status|mode <router|openai|status>|model <route> <provider,model>>");
  }
}
main();
