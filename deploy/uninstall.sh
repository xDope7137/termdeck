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
  # Every launchd job pointing at this agent, whatever it is labelled — installs
  # predate the io.termdeck.agent label. An uninstall that leaves one loaded is
  # worse than no uninstall: it deletes the files the agent runs from and leaves
  # launchd respawning it every ThrottleInterval against a missing agent.js.
  for PLIST in "$HOME/Library/LaunchAgents"/*.plist; do
    [ -f "$PLIST" ] || continue
    grep -q '\.termdeck/agent/agent\.js' "$PLIST" 2>/dev/null || continue
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    rm -f "$PLIST"
  done
fi
# The @reboot line the no-service-manager branch may have written.
if command -v crontab >/dev/null 2>&1; then
  crontab -l 2>/dev/null | grep -v '\.termdeck/agent/agent\.js' | crontab - >/dev/null 2>&1 || true
fi
pkill -f "$DIR/agent.js" >/dev/null 2>&1 || true

rm -rf "$DIR" "$ENVFILE" "$HOME_DIR/persistence.json"
echo "OK — agent stopped and removed from this machine."
echo ""
echo "One step is left, and it is NOT on this machine:"
echo "  Remove the machine from https://termdeck.io/settings/machines"
echo "  (signed in as its owner). Deleting the files here does not do that."
echo "  Left listed, it shows as a machine that is always offline and holds a"
echo "  slot on the owner's plan until Termdeck removes it after 30 quiet days."
echo ""
echo "Full uninstall reference: https://termdeck.io/docs/install#uninstall"
