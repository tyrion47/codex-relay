# codex-shims.ps1 -- flip Codex CLI between relay-router and direct OpenAI.
param([Parameter(Mandatory=$true)][string]$Command, [string]$Arg1)
$ErrorActionPreference = 'Stop'
$RelayRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$CodexHome = Join-Path $env:USERPROFILE '.codex'
$ConfigPath = Join-Path $CodexHome 'config.toml'
$DummyKey = 'sk-relay-local'

function Get-RelayPort { try { $c = Get-Content (Join-Path $RelayRoot 'config.json') -Raw | ConvertFrom-Json; if ($c.port) { return [int]$c.port } } catch {}; return 9001 }
$Port = Get-RelayPort
$BaseUrl = "http://127.0.0.1:$Port/v1"

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) { throw "refusing empty content" }
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Backup-Config { $ts = Get-Date -Format yyyyMMddHHmmss; Copy-Item $ConfigPath "$ConfigPath.bak.$ts" -Force }

function Mode-Router {
  Backup-Config
  $cfg = (Get-Content $ConfigPath -Raw).Trim()
  $bak = Join-Path $CodexHome "config-relay.toml.bak.$((Get-Date).ToString('yyyyMMddHHmmss'))"
  Copy-Item $ConfigPath $bak -Force

  $newCfg = @"
model = "deepseek-v4-pro"
model_provider = "codex-relay"
model_reasoning_effort = "high"

[model_providers.codex-relay]
name = "Codex Relay (multi-provider router)"
base_url = "$BaseUrl"
supports_websockets = false
"@

  $existing = Get-Content $ConfigPath -Raw
  $rest = ($existing -split "`n" | Where-Object { $_ -notmatch '^model\s*=' -and $_ -notmatch '^model_provider\s*=' -and $_ -notmatch '^model_reasoning_effort\s*=' -and $_ -notmatch '^model_supports_reasoning' -and $_ -notmatch '^model_catalog_json' -and $_ -notmatch '^\[model_providers' }) -join "`n"
  $final = $newCfg + "`n" + ($rest.Trim())
  Write-Utf8NoBom $ConfigPath $final
  Write-Host "Codex CLI -> relay-router $BaseUrl (model_provider: codex-relay)"
  Write-Host "Backup saved: $bak`nRestart any running codex session for the change to take effect."
}

function Mode-OpenAI {
  Backup-Config
  $bak = Join-Path $CodexHome "config-openai.toml.bak.$((Get-Date).ToString('yyyyMMddHHmmss'))"
  Copy-Item $ConfigPath $bak -Force

  $newCfg = @"
model = "gpt-5.5"
model_reasoning_effort = "medium"
"@

  $existing = Get-Content $ConfigPath -Raw
  $rest = ($existing -split "`n" | Where-Object { $_ -notmatch '^model\s*=' -and $_ -notmatch '^model_provider\s*=' -and $_ -notmatch '^model_reasoning_effort\s*=' -and $_ -notmatch '^model_supports_reasoning' -and $_ -notmatch '^model_catalog_json' -and $_ -notmatch '^\[model_providers' }) -join "`n"
  $final = $newCfg + "`n" + ($rest.Trim())
  Write-Utf8NoBom $ConfigPath $final
  Write-Host "Codex CLI -> OpenAI direct (model: gpt-5.5)"
  Write-Host "Backup saved: $bak`nRestart any running codex session for the change to take effect."
}

function Mode-Status {
  $cliModel = "unknown"; try { $m = Select-String -Path $ConfigPath -Pattern '^model\s*=\s*"(.*)"' | Select-Object -First 1; if ($m) { $cliModel = $m.Matches.Groups[1].Value } } catch {}
  $cliProvider = "unknown"; try { $p = Select-String -Path $ConfigPath -Pattern '^model_provider\s*=\s*"(.*)"' | Select-Object -First 1; if ($p) { $cliProvider = $p.Matches.Groups[1].Value } } catch {}
  $cliBase = "unknown"; try { $b = Select-String -Path $ConfigPath -Pattern 'base_url\s*=\s*"(.*)"' | Select-Object -First 1; if ($b) { $cliBase = $b.Matches.Groups[1].Value } } catch {}
  $label = if ($cliBase -eq $BaseUrl) { "router" } else { "openai-direct" }
  Write-Host ("mode                 : $label")
  Write-Host ("model                : $cliModel")
  Write-Host ("provider             : $cliProvider")
  Write-Host ("base_url             : $cliBase")
  try { $h = Invoke-RestMethod "${BaseUrl}/__relay/health" -TimeoutSec 2; Write-Host ("relay daemon         : UP pid $($h.pid) config $($h.configHash) fallback=$($h.fallbackEnabled)") } catch { Write-Host "relay daemon         : DOWN (run: relay-codex up)" }
}

switch ($Command) {
  'mode' {
    switch ($Arg1) {
      'router' { Mode-Router }
      'openai' { Mode-OpenAI }
      default  { Mode-Status }
    }
  }
  default { Write-Host "usage: codex-shims.ps1 mode <router|openai|status>" }
}
