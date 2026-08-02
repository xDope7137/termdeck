#!/bin/sh
# Termdeck agent uninstaller — macOS + Linux. Reverses install.sh: stops whichever
# service was registered, then deletes the agent files + token.
# Served by the master with the real origin baked in; run it as:
#   curl -fsSL __MASTER_URL__/uninstall.sh | sh
set -e
HOME_DIR="${TERMDECK_HOME:-$HOME/.termdeck}"
DIR="$HOME_DIR/agent"
ENVFILE="$HOME_DIR/agent.env"
OS="$(uname -s)"

if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now termdeck-agent >/dev/null 2>&1 || true
  rm -f "$HOME/.config/systemd/user/termdeck-agent.service"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
elif [ "$OS" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/in.bhavikp.termdeck-agent.plist"
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  rm -f "$PLIST"
fi
pkill -f "$DIR/agent.js" >/dev/null 2>&1 || true

rm -rf "$DIR" "$ENVFILE"
echo "OK — agent stopped and removed from this machine."
echo "Remove the machine from the Termdeck dashboard too, if you haven't already."
