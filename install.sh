#!/bin/sh
# Termdeck agent installer — macOS + Linux. Downloads the thin agent, installs its
# two deps, saves the token, and registers it to stay online across reboots.
# Served by the master with the real origin baked in; run it as:
#   curl -fsSL __MASTER_URL__/install.sh | TERMDECK_AGENT_TOKEN=agt_... sh
set -e
MASTER="__MASTER_URL__"

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); CYAN=$(printf '\033[36m'); YELLOW=$(printf '\033[33m')
  GREEN=$(printf '\033[32m'); RED=$(printf '\033[31m'); RESET=$(printf '\033[0m')
else
  BOLD=""; CYAN=""; YELLOW=""; GREEN=""; RED=""; RESET=""
fi

echo ""
echo "${BOLD}${CYAN}Termdeck Agent Installer${RESET}"
echo "${CYAN}------------------------${RESET}"
echo ""

if [ -z "$TERMDECK_AGENT_TOKEN" ]; then
  echo "${RED}Set TERMDECK_AGENT_TOKEN first (copy it from the Termdeck dashboard):${RESET}" >&2
  echo "  curl -fsSL $MASTER/install.sh | TERMDECK_AGENT_TOKEN=agt_... sh" >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "${RED}Node.js 18+ is required — install from https://nodejs.org/en/download and re-run.${RESET}" >&2; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "${RED}npm is required (ships with Node.js) — https://nodejs.org${RESET}" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "${RED}curl is required.${RESET}" >&2; exit 1; }

# Ask the master which files the agent needs, rather than hardcoding — a stale list here
# fetches a new capabilities.js without its new deps (e.g. project-files.js) and the agent
# crash-loops on require. Fallback list is the full current set for masters with no manifest;
# it names a DELETED file at your peril — `set -e` plus curl's -f abort the whole install on
# the 404, partway through, which is how the removed worktrees.js/context-doc.js would have
# broken every fallback install. tests/agent-manifest.mjs pins this list to AGENT_FILES.
FILES=$(curl -fsSL "$MASTER/download/agent/manifest.json" 2>/dev/null | tr -d '[]"[:space:]' | tr ',' ' ')
[ -n "$FILES" ] || FILES="agent.js capabilities.js agent-protocol.js proc-tree.js log.js persistence.js win-launcher.js limits.js usage.js which.js diff.js mcp-config.js accounts.js codex-accounts.js session-title.js tail-read.js checkpoints.js index-head.js session-index.js session-settings.js session-head.js transcript.js claude-data.js pool.js project-files.js machine-config.js command-catalog.js usage-behaviour.js codex-attachment.js project-doc.js upload-types.js engine-events.js claude-events.js codex-events.js grok-events.js engine-runs.js package.json"

# heal.sh drives this unattended (TERMDECK_NO_PROMPT=1) — a repair that stops to ask
# a question is a repair nobody finishes.
# Ask only where there is somebody to ask. `read < /dev/tty` on a box with no
# controlling terminal (cron, CI, a piped ssh) fails in the SHELL's redirection
# rather than in `read`, so the 2>/dev/null on the read never caught it and the
# very first line of a scripted install was
#   sh: 45: cannot open /dev/tty: No such device or address
# which reads as a broken install and is not one.
#
# A SUBSHELL, not a `{ ...; }` group: a redirection error in a group is fatal to
# the shell running it, so the obvious spelling exited 2 right after the banner
# and installed nothing. The subshell takes the failure with it and hands back an
# exit status, which is all the `if` wants. `-c /dev/tty` is not a substitute:
# the device node exists on exactly the boxes where it cannot be opened.
if [ -n "$TERMDECK_NO_PROMPT" ] || ! (exec 3</dev/tty) 2>/dev/null; then
  READ_CODE="n"
else
  printf "Read the agent source before installing? [y/N] "
  read -r READ_CODE < /dev/tty 2>/dev/null || READ_CODE="n"
fi
case "$READ_CODE" in
  [Yy]*)
    for f in install.sh $FILES; do
      if [ "$f" = "install.sh" ]; then url="$MASTER/install.sh"; else url="$MASTER/download/agent/$f"; fi
      echo ""
      echo "${CYAN}--- $f ($url) ---${RESET}"
      curl -fsSL "$url"
    done
    printf "\nContinue with install? [Y/n] "
    read -r CONT < /dev/tty 2>/dev/null || CONT="y"
    case "$CONT" in [Nn]*) exit 0 ;; esac
    ;;
esac

HOME_DIR="${TERMDECK_HOME:-$HOME/.termdeck}"
DIR="$HOME_DIR/agent"
ENVFILE="$HOME_DIR/agent.env"
mkdir -p "$DIR"

echo "${CYAN}==> Downloading the agent from $MASTER ...${RESET}"
for f in $FILES; do
  curl -fsSL "$MASTER/download/agent/$f" -o "$DIR/$f"
done

echo "${CYAN}==> Installing dependencies (ws, chokidar) ...${RESET}"
( cd "$DIR" && npm install --omit=dev --no-audit --no-fund --silent )

printf 'TERMDECK_AGENT_TOKEN=%s\nTERMDECK_MASTER_URL=%s\n' "$TERMDECK_AGENT_TOKEN" "$MASTER" > "$ENVFILE"
chmod 600 "$ENVFILE"

echo "${CYAN}==> Registering the background service ...${RESET}"
OS="$(uname -s)"
SERVICE_MSG=""
SERVICE_HINT=""
SERVICE_WARN=""
MODE="unknown"

# What the agent reports to the dashboard, so a weak install says so on the machine
# card instead of being discovered at the next logout (agent/persistence.js). Written
# from the branch that actually ran — a marker that guesses is worse than no marker,
# because the card would then vouch for it.
write_marker() {
  printf '{"mode":"%s","at":"%s"}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HOME_DIR/persistence.json"
  chmod 600 "$HOME_DIR/persistence.json" 2>/dev/null || true
}

if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT="$HOME/.config/systemd/user/termdeck-agent.service"
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=Termdeck thin agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENVFILE
ExecStart=/usr/bin/env node $DIR/agent.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now termdeck-agent
  MODE="systemd-user"
  SERVICE_MSG="running as the systemd user service 'termdeck-agent'."

  # Lingering, or the agent dies at logout. This used to be a HINT printed after a
  # green success line — a coin toss nobody knew they were making: close the SSH
  # session and the machine goes Offline for good, with the install still saying it
  # worked. Ask properly now. Already on is silent, a cached/passwordless sudo just
  # works, and the one case left (sudo wants a password we cannot prompt for under
  # `curl | sh`) is REPORTED here and again on the machine card.
  if [ -e "/var/lib/systemd/linger/$USER" ]; then
    :
  elif command -v loginctl >/dev/null 2>&1 && sudo -n loginctl enable-linger "$USER" >/dev/null 2>&1; then
    echo "${CYAN}    Enabled lingering — the agent now survives you logging out.${RESET}"
  else
    SERVICE_WARN="This agent will STOP when you log out of this machine. To fix that, run:
    sudo loginctl enable-linger $USER"
  fi
elif [ "$OS" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/io.termdeck.agent.plist"
  # The label is what the owner sees in System Settings > General > Login Items &
  # Extensions, where macOS lists every third-party background item — so it names
  # Termdeck. Earlier installs used a different one, and leaving that job loaded
  # means TWO agents on one machine, both writing the same log and both dialling in.
  # Retire them by CONTENT rather than by name: anything under LaunchAgents that
  # points at this agent is ours, including labels this script never shipped.
  for OLD in "$HOME/Library/LaunchAgents"/*.plist; do
    [ -f "$OLD" ] || continue
    [ "$OLD" = "$PLIST" ] && continue
    grep -q '\.termdeck/agent/agent\.js' "$OLD" 2>/dev/null || continue
    launchctl unload "$OLD" 2>/dev/null || true
    rm -f "$OLD"
  done
  NODE="$(command -v node)"
  mkdir -p "$(dirname "$PLIST")"
  # ThrottleInterval: bare KeepAlive relaunches instantly, so an agent that dies on
  # boot (bad update, missing node) burns a core respawning itself. 10s is launchd's
  # own default made explicit, and matches RestartSec above.
  # SuccessfulExit=false: a CLEAN exit means we meant to stop, and launchd must not
  # fight that. A crash — any non-zero exit, including the rollback path's
  # process.exit(1) — still restarts, which is the half that matters.
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.termdeck.agent</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/agent.js</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>TERMDECK_AGENT_TOKEN</key><string>$TERMDECK_AGENT_TOKEN</string>
    <key>TERMDECK_MASTER_URL</key><string>$MASTER</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
EOF
  chmod 600 "$PLIST"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  MODE="launchd"
  SERVICE_MSG="running as the launchd agent 'io.termdeck.agent'."
  SERVICE_HINT="macOS lists it under System Settings > General > Login Items & Extensions."
else
  # No systemd, no launchd. This used to be a bare `nohup ... &` — which dies at the
  # next reboot while the installer printed "installed" in green, the worst outcome
  # in this file because nothing anywhere said so. Register a @reboot cron line
  # instead; if even that is unavailable, say plainly that it will not come back
  # (and the machine card says it too, so it survives this scrollback).
  ( cd "$DIR" && TERMDECK_AGENT_TOKEN="$TERMDECK_AGENT_TOKEN" TERMDECK_MASTER_URL="$MASTER" nohup node agent.js >/dev/null 2>&1 & )
  CRON_LINE="@reboot cd $DIR && env \$(cat $ENVFILE | xargs) node $DIR/agent.js >/dev/null 2>&1"
  if command -v crontab >/dev/null 2>&1 &&
     { crontab -l 2>/dev/null | grep -v '\.termdeck/agent/agent\.js'; echo "$CRON_LINE"; } | crontab - 2>/dev/null; then
    MODE="crontab"
    SERVICE_MSG="started, and registered with cron to start again at boot."
    SERVICE_HINT="No systemd or launchd here, so recovery is boot-only: if the agent is killed it stays down until the next restart."
  else
    MODE="foreground"
    SERVICE_MSG="started in the background."
    SERVICE_WARN="This machine has no service manager Termdeck can use, so the agent will NOT
    come back after a restart. Start it again with:
    cd $DIR && node agent.js"
  fi
fi
write_marker "$MODE"

have_engine() { command -v "$1" >/dev/null 2>&1 || [ -x "$HOME/.local/bin/$1" ]; }

echo ""
echo "${GREEN}------------------------------------------------------------${RESET}"
echo "${GREEN}Termdeck agent installed — $SERVICE_MSG${RESET}"
echo "${GREEN}------------------------------------------------------------${RESET}"
[ -n "$SERVICE_HINT" ] && echo "${YELLOW}$SERVICE_HINT${RESET}"
# Loudest line in the script, and deliberately below the green box: it is the one
# thing here that makes "installed" less than true.
[ -n "$SERVICE_WARN" ] && { echo ""; echo "${RED}!!  $SERVICE_WARN${RESET}"; }
have_engine claude || echo "${YELLOW}Note: 'claude' (Claude Code CLI) not found — Claude sessions won't run until it's installed.${RESET}"
have_engine codex  || echo "${YELLOW}Note: 'codex' (Codex CLI) not found — Codex sessions won't run until it's installed.${RESET}"
echo ""
echo "${CYAN}Your machine should appear online in the Termdeck dashboard within a few seconds.${RESET}"
echo "${CYAN}Activity log (for support): $HOME_DIR/logs/agent.log${RESET}"
echo ""
