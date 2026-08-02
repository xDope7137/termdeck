# Termdeck agent uninstaller — Windows (PowerShell). Reverses install.ps1: removes the
# logon task, kills the running agent, then deletes the agent files + token.
# Served by the master; run it as:
#   iwr __MASTER_URL__/uninstall.ps1 | iex
$ErrorActionPreference = "Stop"
$Dir = Join-Path $env:USERPROFILE ".termdeck\agent"

try { Stop-ScheduledTask -TaskName "TermdeckAgent" -ErrorAction SilentlyContinue } catch {}
try { Unregister-ScheduledTask -TaskName "TermdeckAgent" -Confirm:$false -ErrorAction SilentlyContinue }
catch { try { schtasks /Delete /TN "TermdeckAgent" /F *>$null } catch {} }
# Kill the windowless shim and the run.cmd wrapper first — else the loop just respawns
# node — then the agent itself.
Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" |
  Where-Object { $_.CommandLine -like "*\.termdeck\agent\run.vbs*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
  Where-Object { $_.CommandLine -like "*\.termdeck\agent\run.cmd*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*agent.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Remove-Item -Recurse -Force $Dir -ErrorAction SilentlyContinue
Remove-Item -Force (Join-Path $env:USERPROFILE ".termdeck\agent.env.cmd") -ErrorAction SilentlyContinue

Write-Host "OK — agent stopped and removed from this machine." -ForegroundColor Green
Write-Host "Remove the machine from the Termdeck dashboard too, if you haven't already."
