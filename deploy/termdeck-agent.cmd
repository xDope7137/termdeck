@echo off
rem Termdeck CLOUD agent for Windows — dials OUT to the cloud master (no inbound
rem firewall rule needed; that's the point of the reverse-WS agent). Serves narrow,
rem root-confined capabilities so the master browses/drives this box's sessions.
rem
rem Prereqs on this box: Node.js installed, and this termdeck repo checked out with
rem `npm install` run (the agent needs the `ws` and `chokidar` deps).
rem
rem Create %USERPROFILE%\.termdeck\agent.env.cmd containing:
rem     set TERMDECK_AGENT_TOKEN=agt_...        (this machine's token from /cloud)
rem     set TERMDECK_MASTER_URL=https://termdeck.io
rem
rem Register at logon (run as the logged-on user — the agent reads that user's
rem ~/.claude and ~/.codex, and spawns their claude/codex CLI):
rem     schtasks /create /tn TermdeckAgent /sc onlogon /tr "\"C:\path\to\termdeck\deploy\termdeck-agent.cmd\""
call "%USERPROFILE%\.termdeck\agent.env.cmd"
cd /d "%~dp0.."
:loop
node agent\agent.js
timeout /t 3 /nobreak >nul
goto loop
