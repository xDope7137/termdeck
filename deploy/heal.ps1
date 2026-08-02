# Termdeck agent repair — Windows (PowerShell). Removes the installed agent and puts a
# fresh one back, reusing the token already on this machine so there is nothing to look
# up. This is the escalation for what the agent cannot fix itself: a wedged scheduled
# task, a node_modules npm left half-written, a rollback that ran out of road.
# Served by the master with the real origin baked in; run it as:
#   iwr __MASTER_URL__/heal.ps1 | iex
$ErrorActionPreference = "Stop"
$Master = "__MASTER_URL__"
$Attempts = 3
# Env seam so a test can exercise the retry loop without three real pauses.
$RetrySecs = if ($env:TERMDECK_HEAL_RETRY_SECS) { [int]$env:TERMDECK_HEAL_RETRY_SECS } else { 5 }

Write-Host ""
Write-Host "  Termdeck Agent Repair" -ForegroundColor Cyan
Write-Host "  ---------------------" -ForegroundColor Cyan
Write-Host ""

# Recover the token from what the installer left behind, so repairing is one command
# with no dashboard trip. install.ps1 writes it as `set NAME=value` for the run.cmd wrapper.
$EnvCmd = Join-Path $env:USERPROFILE ".termdeck\agent.env.cmd"
$Token = $env:TERMDECK_AGENT_TOKEN
if (-not $Token -and (Test-Path $EnvCmd)) {
  $Token = (Select-String -Path $EnvCmd -Pattern '^set TERMDECK_AGENT_TOKEN=(.+)$' |
            Select-Object -First 1).Matches.Groups[1].Value
}
if (-not $Token) {
  Write-Host "Could not find this machine's token on disk." -ForegroundColor Red
  Write-Host "Copy it from the Termdeck dashboard (Machines -> your machine) and re-run:"
  Write-Host "  `$env:TERMDECK_AGENT_TOKEN=`"agt_...`"; iwr $Master/heal.ps1 | iex"
  return
}
Write-Host "==> Found this machine's token — reusing it, the machine keeps its identity." -ForegroundColor Cyan

Write-Host "==> Removing the old agent ..." -ForegroundColor Cyan
# Never fatal: the reason you are running this may be that the old install is already
# broken. Whatever survives, the reinstall below overwrites.
try { iwr -UseBasicParsing "$Master/uninstall.ps1" | iex } catch {}

$env:TERMDECK_AGENT_TOKEN = $Token
$env:TERMDECK_NO_PROMPT = "1"
$ok = $false
for ($n = 1; $n -le $Attempts; $n++) {
  Write-Host "==> Installing a fresh agent (attempt $n of $Attempts) ..." -ForegroundColor Cyan
  try {
    iwr -UseBasicParsing "$Master/install.ps1" | iex
    $ok = $true
    break
  } catch {
    Write-Host "Attempt $n failed: $($_.Exception.Message)" -ForegroundColor Yellow
    if ($n -lt $Attempts) { Start-Sleep -Seconds $RetrySecs }
  }
}
$env:TERMDECK_NO_PROMPT = $null

Write-Host ""
if ($ok) {
  Write-Host "  ------------------------------------------------------------" -ForegroundColor Green
  Write-Host "  Repaired. This machine should go online in the dashboard within a few seconds." -ForegroundColor Green
  Write-Host "  ------------------------------------------------------------" -ForegroundColor Green
  Write-Host ""
  return
}

Write-Host "  ------------------------------------------------------------" -ForegroundColor Red
Write-Host "  Repair failed after $Attempts attempts." -ForegroundColor Red
Write-Host "  ------------------------------------------------------------" -ForegroundColor Red
Write-Host "  Most likely causes, in order:" -ForegroundColor Yellow
Write-Host "    1. Node.js 18+ is missing or not on PATH   ->  node --version"
Write-Host "    2. This machine cannot reach $Master       ->  iwr $Master/VERSION"
Write-Host "    3. npm could not install ws + chokidar     ->  scroll up for its error"
Write-Host ""
Write-Host "  Send that output to support and we will take it from there."
