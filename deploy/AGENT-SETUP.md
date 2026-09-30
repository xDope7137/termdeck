# Connecting a machine (Termdeck agent)

A machine joins your dashboard by running the **thin agent**: it dials out to the
master, stays connected, and serves narrow, typed capabilities so the master can
browse and drive that box's Claude Code, Codex and Grok sessions. It never opens an
inbound port. Requires **Node.js 18+** on the machine.

## One-liner (recommended)

Add a machine in the dashboard (Settings, then Machines and accounts, then Add
machine), copy its token, then run the command for that machine's OS. The installer downloads the
agent, installs its two deps, saves the token, and registers a per-OS service so
it stays online across reboots.

**macOS / Linux** (Terminal):

    curl -fsSL https://termdeck.io/install.sh | TERMDECK_AGENT_TOKEN=agt_... sh

**Windows** (PowerShell):

    $env:TERMDECK_AGENT_TOKEN="agt_..."; iwr https://termdeck.io/install.ps1 | iex

What it sets up:
- **Linux**: systemd user service `termdeck-agent` (run `sudo loginctl enable-linger $USER` to keep it running after logout), or a `@reboot` cron entry where systemd user services are unavailable.
- **macOS**: launchd agent `io.termdeck.agent` (`~/Library/LaunchAgents/`).
- **Windows**: Task Scheduler job `TermdeckAgent`, a self-healing watchdog: starts at logon and re-checks every ~2 min, relaunching the agent within a couple of minutes if it's killed (single instance, so it's a no-op while already up).

## Manual setup

If you'd rather not pipe a script: install Node.js 18+, then

    mkdir -p ~/.termdeck/agent && cd ~/.termdeck/agent
    for f in $(curl -fsSL https://termdeck.io/download/agent/manifest.json | tr -d '[]"[:space:]' | tr ',' ' '); do
      curl -fsSLO "https://termdeck.io/download/agent/$f"
    done
    npm install --omit=dev

The agent is about 35 files, and the list comes from `manifest.json` so a manual
install never misses one.
    TERMDECK_AGENT_TOKEN=agt_... TERMDECK_MASTER_URL=https://termdeck.io node agent.js

To keep it running, use the matching template in this folder:
`termdeck-agent.service` (Linux systemd user unit), `termdeck-agent.plist`
(macOS launchd), or `termdeck-agent.cmd` (Windows, register with
`schtasks /sc onlogon`).

## Notes

- The agent reads and watches the engines' transcript roots (`~/.claude`,
  `$CODEX_HOME` (default `~/.codex`), Grok's directory) and the open chat's project
  folder (read only), and spawns the installed `claude` / `codex` / `grok` CLI. It
  is a narrow typed capability list, not a general "run anything" channel.
- Regenerating a machine's token in the dashboard invalidates the old one
  immediately; re-run the installer with the new token.
- Claude Code, Codex and Grok sessions are all fully drivable. Turns run on the
  machine itself, so a dropped link does not stop them.
