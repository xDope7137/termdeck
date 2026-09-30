# Termdeck agent uninstaller — Windows (PowerShell). Reverses install.ps1: removes the
# logon task, kills the running agent, then deletes the agent files + token.
# Served by the master; run it as:
#   iwr __MASTER_URL__/uninstall.ps1 | iex
$ErrorActionPreference = "Stop"
$Dir = Join-Path $env:USERPROFILE ".termdeck\agent"
$Task = "TermdeckAgent"

# THE TASK COMES OFF FIRST, AND ITS REMOVAL IS VERIFIED. Both halves of that
# sentence are here because of what happened without them.
#
# install.ps1 needs Administrator to REGISTER the task, so removing it needs
# Administrator too — and this script never asked for it. Run from an ordinary
# PowerShell window it did the half it could: `Unregister-ScheduledTask` failed
# with access denied and was swallowed by -ErrorAction SilentlyContinue, then
# `Remove-Item -Recurse $Dir` succeeded, because the agent folder is in the user's
# own profile.
#
# The result is the worst state this machine can be in. The task survives, with
# its watchdog trigger firing EVERY TWO MINUTES for ten years, and its action is
# `wscript.exe "…\.termdeck\agent\run.vbs"` — a file that has just been deleted.
# wscript answers a path it cannot find with a modal dialog. So an uninstall that
# printed "OK — agent stopped and removed" left the customer with
# "Can not find script file" on their desktop 720 times a day, forever, with
# nothing on it that says Termdeck and no obvious way to make it stop.
#
# heal.ps1 calls this script, so the same hole turned a repair into that state
# too — and then reported success.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "==> Re-launching elevated (needed to remove the scheduled task) — approve the UAC prompt..." -ForegroundColor Yellow
  $master = "__MASTER_URL__"
  $relaunch = "iwr $master/uninstall.ps1 -UseBasicParsing | iex"
  # -Wait, so a caller (heal.ps1) learns what actually happened instead of being
  # told "done" while the elevated child is still deciding.
  $p = Start-Process powershell -Verb RunAs -PassThru -Wait -ArgumentList "-NoProfile", "-Command", $relaunch
  # `throw`, never `exit`: these scripts are loaded with `iwr … | iex`, so they run
  # INSIDE the caller's PowerShell — `exit` would close an interactive user's window
  # before they could read the message, and take heal.ps1 down mid-repair. A throw
  # lands in heal.ps1's catch, and still gives the elevated child a non-zero exit
  # code for the -Wait above.
  if ($p.ExitCode -ne 0) { throw "The elevated uninstall did not finish (exit $($p.ExitCode)) — nothing was removed." }
  return
}

try { Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue } catch {}
try { Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue }
catch { try { schtasks /Delete /TN $Task /F *>$null } catch {} }

# Did it actually go? Elevation makes this very likely, but "very likely" is what
# the old script assumed and it is not good enough for the failure it produces.
# Get-ScheduledTask throws when the task is absent, which is the answer we want.
$taskGone = $true
try { Get-ScheduledTask -TaskName $Task -ErrorAction Stop | Out-Null; $taskGone = $false } catch { $taskGone = $true }

if (-not $taskGone) {
  # The files STAY. A registered task pointing at a run.vbs that exists is a
  # working agent; a registered task pointing at nothing is a dialog every two
  # minutes. Leaving the machine working is strictly the better failure.
  Write-Host ""
  Write-Host "  Could not remove the scheduled task '$Task'." -ForegroundColor Red
  Write-Host "  The agent files have been LEFT IN PLACE on purpose: deleting them while that" -ForegroundColor Red
  Write-Host "  task still exists would pop a 'Can not find script file' box every 2 minutes." -ForegroundColor Red
  Write-Host ""
  Write-Host "  Remove the task first, in an Administrator PowerShell:" -ForegroundColor Yellow
  Write-Host "    Unregister-ScheduledTask -TaskName $Task -Confirm:`$false"
  Write-Host "  then run this uninstaller again."
  throw "Scheduled task '$Task' could not be removed — agent files left in place."
}

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
Remove-Item -Force (Join-Path $env:USERPROFILE ".termdeck\persistence.json") -ErrorAction SilentlyContinue

Write-Host "OK — agent stopped and removed from this machine." -ForegroundColor Green
Write-Host ""
Write-Host "One step is left, and it is NOT on this machine:"
Write-Host "  Remove the machine from https://termdeck.io/settings/machines"
Write-Host "  (signed in as its owner). Deleting the files here does not do that."
Write-Host "  Left listed, it shows as a machine that is always offline and holds a"
Write-Host "  slot on the owner's plan until Termdeck removes it after 30 quiet days."
Write-Host ""
Write-Host "Full uninstall reference: https://termdeck.io/docs/install#uninstall"
