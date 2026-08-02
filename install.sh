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
# fetches a new capabilities.js without its new deps (e.g. worktrees.js) and the agent
# crash-loops on require. Fallback list is the full current set for masters with no manifest.
FILES=$(curl -fsSL "$MASTER/download/agent/manifest.json" 2>/dev/null | tr -d '[]"[:space:]' | tr ',' ' ')
[ -n "$FILES" ] || FILES="agent.js capabilities.js log.js limits.js worktrees.js which.js diff.js context-doc.js mcp-config.js package.json"

# heal.sh drives this unattended (TERMDECK_NO_PROMPT=1) — a repair that stops to ask
# a question is a repair nobody finishes.
if [ -n "$TERMDECK_NO_PROMPT" ]; then
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
  SERVICE_MSG="running as the systemd user service 'termdeck-agent'."
  SERVICE_HINT="To keep it running after you log out: sudo loginctl enable-linger $USER"
elif [ "$OS" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/in.bhavikp.termdeck-agent.plist"
  NODE="$(command -v node)"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>in.bhavikp.termdeck-agent</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/agent.js</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>TERMDECK_AGENT_TOKEN</key><string>$TERMDECK_AGENT_TOKEN</string>
    <key>TERMDECK_MASTER_URL</key><string>$MASTER</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
  chmod 600 "$PLIST"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  SERVICE_MSG="running as the launchd agent 'in.bhavikp.termdeck-agent'."
else
  ( cd "$DIR" && TERMDECK_AGENT_TOKEN="$TERMDECK_AGENT_TOKEN" TERMDECK_MASTER_URL="$MASTER" nohup node agent.js >/dev/null 2>&1 & )
  SERVICE_MSG="started in the background."
  SERVICE_HINT="To make it permanent, add 'node $DIR/agent.js' to your login startup."
fi

have_engine() { command -v "$1" >/dev/null 2>&1 || [ -x "$HOME/.local/bin/$1" ]; }

echo ""
echo "${GREEN}------------------------------------------------------------${RESET}"
echo "${GREEN}Termdeck agent installed — $SERVICE_MSG${RESET}"
echo "${GREEN}------------------------------------------------------------${RESET}"
[ -n "$SERVICE_HINT" ] && echo "${YELLOW}$SERVICE_HINT${RESET}"
have_engine claude || echo "${YELLOW}Note: 'claude' (Claude Code CLI) not found — Claude sessions won't run until it's installed.${RESET}"
have_engine codex  || echo "${YELLOW}Note: 'codex' (Codex CLI) not found — Codex sessions won't run until it's installed.${RESET}"
echo ""
echo "${CYAN}Your machine should appear online in the Termdeck dashboard within a few seconds.${RESET}"
echo "${CYAN}Activity log (for support): $HOME_DIR/logs/agent.log${RESET}"
echo ""
