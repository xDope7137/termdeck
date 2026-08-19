# Termdeck agent installer — Windows (PowerShell). Downloads the thin agent, installs
# its two deps, saves the token, and registers a logon task so it stays online.
# Served by the master with the real origin baked in; run it as:
#   $env:TERMDECK_AGENT_TOKEN="agt_..."; iwr __MASTER_URL__/install.ps1 | iex
$ErrorActionPreference = "Stop"
$Master = "__MASTER_URL__"

Write-Host ""
Write-Host "  Termdeck Agent Installer" -ForegroundColor Cyan
Write-Host "  ------------------------" -ForegroundColor Cyan
Write-Host ""

if (-not $env:TERMDECK_AGENT_TOKEN) {
  Write-Host "Set `$env:TERMDECK_AGENT_TOKEN first (copy it from the Termdeck dashboard):" -ForegroundColor Red
  Write-Host "  `$env:TERMDECK_AGENT_TOKEN=`"agt_...`"; iwr $Master/install.ps1 | iex"
  return
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 18+ is required — install from https://nodejs.org/en/download and re-run." -ForegroundColor Red
  return
}

# Ask the master which files the agent needs, rather than hardcoding — a stale list here
# fetches a new capabilities.js without its new deps (e.g. project-files.js) and the agent
# crash-loops on require. Fallback is the full current set for masters with no manifest; it
# names a DELETED file at your peril — Invoke-WebRequest THROWS on the 404 and aborts the
# install partway, which is how the removed worktrees.js/context-doc.js would have broken
# every fallback install. tests/agent-manifest.mjs pins this list to AGENT_FILES.
try { $Files = (Invoke-WebRequest -UseBasicParsing "$Master/download/agent/manifest.json").Content | ConvertFrom-Json } catch { $Files = $null }
if (-not $Files) { $Files = @("agent.js","capabilities.js","park.js","proc-tree.js","log.js","persistence.js","win-launcher.js","limits.js","usage.js","which.js","diff.js","mcp-config.js","accounts.js","codex-accounts.js","session-title.js","tail-read.js","checkpoints.js","index-head.js","session-settings.js","session-head.js","transcript.js","claude-data.js","pool.js","project-files.js","machine-config.js","command-catalog.js","usage-behaviour.js","project-doc.js","package.json") }

# heal.ps1 drives this unattended — a repair that stops to ask is one nobody finishes.
$readCode = if ($env:TERMDECK_NO_PROMPT) { "n" } else { Read-Host "Read the agent source before installing? [y/N]" }
if ($readCode -match '^[Yy]') {
  foreach ($f in @("install.ps1") + $Files) {
    $url = if ($f -eq "install.ps1") { "$Master/install.ps1" } else { "$Master/download/agent/$f" }
    Write-Host "`n--- $f ($url) ---" -ForegroundColor Cyan
    (Invoke-WebRequest -UseBasicParsing $url).Content | Write-Host
  }
  $cont = Read-Host "`nContinue with install? [Y/n]"
  if ($cont -match '^[Nn]') { return }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "==> Re-launching elevated (needed to register the logon task) — approve the UAC prompt..." -ForegroundColor Yellow
  # Carry the unattended flag across the UAC boundary too, or the elevated child stops to ask.
  $relaunch = "`$env:TERMDECK_AGENT_TOKEN='$($env:TERMDECK_AGENT_TOKEN)'; `$env:TERMDECK_NO_PROMPT='$($env:TERMDECK_NO_PROMPT)'; iwr $Master/install.ps1 -UseBasicParsing | iex"
  # -Wait and a checked exit code, because the install this launches is the whole
  # install. Without them the parent returned instantly and successfully whatever
  # the child did — a denied UAC prompt, a failed npm, a 404 on one file — and
  # heal.ps1, which only looks for a thrown exception, printed "Repaired." over a
  # machine that had just had its agent folder deleted and nothing put back.
  $p = Start-Process powershell -Verb RunAs -PassThru -Wait -ArgumentList "-NoProfile", "-Command", $relaunch
  # `throw`, not `exit`: this script is loaded with `iwr … | iex`, so it runs inside
  # the caller's PowerShell — `exit` would close an interactive user's window and
  # take heal.ps1 with it. A throw lands in heal.ps1's catch, which is what its
  # retry loop is built to read.
  if ($p.ExitCode -ne 0) { throw "The elevated install did not finish (exit $($p.ExitCode)). Approve the UAC prompt and re-run." }
  return
}

$Dir = Join-Path $env:USERPROFILE ".termdeck\agent"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

Write-Host "==> Downloading the agent from $Master ..." -ForegroundColor Cyan
foreach ($f in $Files) {
  Invoke-WebRequest -UseBasicParsing "$Master/download/agent/$f" -OutFile (Join-Path $Dir $f)
}

Write-Host "==> Installing dependencies (ws, chokidar) ..." -ForegroundColor Cyan
Push-Location $Dir
try { & npm install --omit=dev --no-audit --no-fund --silent } finally { Pop-Location }

# A wrapper that sources the token env then runs the agent in a restart loop.
$EnvCmd = Join-Path $env:USERPROFILE ".termdeck\agent.env.cmd"
"set TERMDECK_AGENT_TOKEN=$($env:TERMDECK_AGENT_TOKEN)`r`nset TERMDECK_MASTER_URL=$Master" |
  Set-Content -Encoding ASCII $EnvCmd
$RunCmd = Join-Path $Dir "run.cmd"
# `ping`, not `timeout`: timeout reads the console and fails outright ("input
# redirection is not supported") once this runs windowless with no usable stdin.
# stdout goes nowhere because agent/log.js already writes every line to the log
# file; stderr is appended so a crash Node prints before our handler runs is still
# recoverable from the same folder the customer is told to look in.
@"
@echo off
call "%USERPROFILE%\.termdeck\agent.env.cmd"
cd /d "%USERPROFILE%\.termdeck\agent"
if not exist "%USERPROFILE%\.termdeck\logs" mkdir "%USERPROFILE%\.termdeck\logs"
:loop
node agent.js >nul 2>>"%USERPROFILE%\.termdeck\logs\agent-crash.log"
ping -n 4 127.0.0.1 >nul
goto loop
"@ | Set-Content -Encoding ASCII $RunCmd

# The window. A scheduled task with an Interactive principal running cmd.exe puts a
# console on the user's desktop and leaves it there for as long as the agent runs —
# which is forever. Neither -WindowStyle Hidden nor a /min task setting removes it
# (they hide a window that has already been created, and cmd re-shows on each loop).
# wscript with intWindowStyle 0 never creates one at all, and it is on every Windows
# by default, so this needs nothing installed. bWaitOnReturn=TRUE matters: the shim
# has to block for the life of the agent the way cmd.exe used to, or the task would
# complete instantly and MultipleInstances=IgnoreNew would stop suppressing anything
# — the 2-minute watchdog trigger would then start a SECOND agent every 2 minutes.
$RunVbs = Join-Path $Dir "run.vbs"
@"
Set sh = CreateObject("WScript.Shell")
sh.Run """" & "$($RunCmd -replace '"','""')" & """", 0, True
"@ | Set-Content -Encoding ASCII $RunVbs

Write-Host "==> Registering the self-healing agent task and starting it ..." -ForegroundColor Cyan
# ONLOGON alone doesn't self-heal: a process kill (e.g. the agent caught in a bulk
# "kill all node.exe" among leftover MCP servers) leaves it dead until the next fresh
# logon. So register a REPEATING watchdog — every 2 min the scheduler relaunches it if
# it's gone; MultipleInstances=IgnoreNew makes that a no-op while it's already up, so
# run.cmd's own 3s inner loop still owns fast node-crash recovery. AtLogOn covers reboots.
# ExecutionTimeLimit=0 stops Task Scheduler killing a long-running agent after 3 days.
$registered = $true
try {
  $me      = "$env:USERDOMAIN\$env:USERNAME"   # DOMAIN\User; USERDOMAIN = computer name off-domain, so this works either way
  $action  = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$RunVbs`""
  $atLogon = New-ScheduledTaskTrigger -AtLogOn -User $me
  $watch   = New-ScheduledTaskTrigger -Once -At (Get-Date) `
               -RepetitionInterval (New-TimeSpan -Minutes 2) `
               -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
               -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
               -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName "TermdeckAgent" -Action $action -Trigger @($atLogon, $watch) `
    -Settings $settings -Principal $principal -Force *>$null
  Start-ScheduledTask -TaskName "TermdeckAgent"
} catch {
  $registered = $false
  # Scheduler unavailable — at least run this session, still through the windowless
  # shim so the fallback isn't the one path that leaves a console on screen.
  Start-Process -WindowStyle Hidden wscript.exe -ArgumentList "`"$RunVbs`""
}

# What the agent reports to the dashboard (agent/persistence.js). Windows is the
# one platform with no cheap way to infer this at boot — a scheduled-task child
# looks exactly like a hand-started one — so the marker is the only source, and
# it records what actually happened rather than what was attempted. Without it a
# machine whose task registration failed looks identical to a healthy one right
# up until the next reboot.
$Marker = Join-Path $env:USERPROFILE ".termdeck\persistence.json"
$mode = if ($registered) { "schtask" } else { "foreground" }
"{`"mode`":`"$mode`",`"at`":`"$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))`"}" |
  Set-Content -Encoding ASCII $Marker

function Test-Engine($name) {
  if (Get-Command $name -ErrorAction SilentlyContinue) { return $true }
  Test-Path (Join-Path $env:USERPROFILE ".local\bin\$name.exe")
}

Write-Host ""
Write-Host "  ------------------------------------------------------------" -ForegroundColor Green
if ($registered) {
  Write-Host "  Termdeck agent installed — self-healing watchdog task (relaunches within ~2 min if killed)." -ForegroundColor Green
} else {
  Write-Host "  Termdeck agent installed and started for this session." -ForegroundColor Green
}
Write-Host "  ------------------------------------------------------------" -ForegroundColor Green
if (-not $registered) {
  Write-Host "  Watchdog task not registered (Task Scheduler access denied) — it won't restart" -ForegroundColor Yellow
  Write-Host "  automatically if killed or on reboot. Re-run from an elevated PowerShell to fix." -ForegroundColor Yellow
}
if (-not (Test-Engine "claude")) { Write-Host "  Note: 'claude' (Claude Code CLI) not found — Claude sessions won't run until it's installed." -ForegroundColor Yellow }
if (-not (Test-Engine "codex"))  { Write-Host "  Note: 'codex' (Codex CLI) not found — Codex sessions won't run until it's installed." -ForegroundColor Yellow }
Write-Host ""
Write-Host "  Your machine should appear online in the Termdeck dashboard within a few seconds." -ForegroundColor Cyan
Write-Host "  Activity log (for support): $env:USERPROFILE\.termdeck\logs\agent.log" -ForegroundColor Cyan
Write-Host ""
