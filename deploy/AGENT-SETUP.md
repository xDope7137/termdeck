# Connecting a machine (Termdeck agent)

A machine joins your dashboard by running the **thin agent**: it dials out to the
master, stays connected, and serves narrow, root-confined capabilities so the
master can browse and drive that box's Claude/Codex sessions. It never opens an
inbound port. Requires **Node.js 18+** on the machine.

## One-liner (recommended)

Add a machine in the dashboard at `https://termdeck.io/cloud`, copy its
token, then run the command for that machine's OS. The installer downloads the
agent, installs its two deps, saves the token, and registers a per-OS service so
it stays online across reboots.

**macOS / Linux** (Terminal):

    curl -fsSL https://termdeck.io/install.sh | TERMDECK_AGENT_TOKEN=agt_... sh

**Windows** (PowerShell):

    $env:TERMDECK_AGENT_TOKEN="agt_..."; iwr https://termdeck.io/install.ps1 | iex

What it sets up:
- **Linux** → systemd user service `termdeck-agent` (run `sudo loginctl enable-linger $USER` to keep it running after logout).
- **macOS** → launchd agent `in.bhavikp.termdeck-agent` (`~/Library/LaunchAgents/`).
- **Windows** → Task Scheduler job `TermdeckAgent` — a self-healing watchdog: starts at logon and re-checks every ~2 min, relaunching the agent within a couple of minutes if it's killed (single instance, so it's a no-op while already up).

## Manual setup

If you'd rather not pipe a script: install Node.js 18+, then

    mkdir -p ~/.termdeck/agent && cd ~/.termdeck/agent
    curl -fsSLO https://termdeck.io/download/agent/agent.js
    curl -fsSLO https://termdeck.io/download/agent/capabilities.js
    curl -fsSLO https://termdeck.io/download/agent/package.json
    npm install --omit=dev
    TERMDECK_AGENT_TOKEN=agt_... TERMDECK_MASTER_URL=https://termdeck.io node agent.js

To keep it running, use the matching template in this folder:
`termdeck-agent.service` (Linux systemd user unit), `termdeck-agent.plist`
(macOS launchd), or `termdeck-agent.cmd` (Windows, register with
`schtasks /sc onlogon`).

## Notes

- The agent only ever reads/watches `~/.claude` and `$CODEX_HOME` (default
  `~/.codex`) and spawns the installed `claude`/`codex` CLI — it's a narrow typed
  capability, not a general "run anything" channel.
- Regenerating a machine's token in the dashboard invalidates the old one
  immediately; re-run the installer with the new token.
- Codex sessions are read-only over the tunnel for now; Claude sessions are fully
  drivable.
