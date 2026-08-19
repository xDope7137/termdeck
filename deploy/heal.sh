#!/bin/sh
# Termdeck agent repair — macOS + Linux. Removes the installed agent and puts a fresh
# one back, reusing the token already on this machine so there is nothing to look up.
# This is the escalation for the cases the agent cannot fix itself: a wedged supervisor,
# a node_modules that npm left half-written, a rollback that ran out of road.
# Served by the master with the real origin baked in; run it as:
#   curl -fsSL __MASTER_URL__/heal.sh | sh
set -e
MASTER="__MASTER_URL__"
ATTEMPTS=3
# Env seam so a test can exercise the retry loop without waiting out three real pauses
# (same trick as TERMDECK_WHICH_MISS_TTL_MS in lib/which.js).
RETRY_SECS="${TERMDECK_HEAL_RETRY_SECS:-5}"

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); CYAN=$(printf '\033[36m'); YELLOW=$(printf '\033[33m')
  GREEN=$(printf '\033[32m'); RED=$(printf '\033[31m'); RESET=$(printf '\033[0m')
else
  BOLD=""; CYAN=""; YELLOW=""; GREEN=""; RED=""; RESET=""
fi

HOME_DIR="${TERMDECK_HOME:-$HOME/.termdeck}"
ENVFILE="$HOME_DIR/agent.env"
# macOS keeps the token inline in the plist, so this is where repair recovers it.
# Fall back to searching LaunchAgents by CONTENT: a machine installed under an
# earlier label still has to be repairable, and looking only for the current name
# would turn "repair it for me" back into "go find your token in the dashboard"
# for exactly the machines that have been running longest. /dev/null when there is
# nothing to find — an empty path would make the grep below read stdin and hang.
PLIST="$HOME/Library/LaunchAgents/io.termdeck.agent.plist"
[ -f "$PLIST" ] || PLIST=$(grep -ls 'TERMDECK_AGENT_TOKEN' "$HOME/Library/LaunchAgents"/*.plist 2>/dev/null | head -1)
[ -n "$PLIST" ] || PLIST=/dev/null

echo ""
echo "${BOLD}${CYAN}Termdeck Agent Repair${RESET}"
echo "${CYAN}---------------------${RESET}"
echo ""

# Recover the token from whatever the installer left behind, so repairing is one
# command with no dashboard trip. Order: explicit override, the env file install.sh
# writes, then the launchd plist (macOS keeps it inline instead of in a file).
TOKEN="$TERMDECK_AGENT_TOKEN"
[ -n "$TOKEN" ] || TOKEN=$(sed -n 's/^TERMDECK_AGENT_TOKEN=//p' "$ENVFILE" 2>/dev/null | head -1)
[ -n "$TOKEN" ] || TOKEN=$(grep -A1 'TERMDECK_AGENT_TOKEN' "$PLIST" 2>/dev/null | sed -n 's/.*<string>\(agt_[^<]*\)<\/string>.*/\1/p' | head -1)
if [ -z "$TOKEN" ]; then
  echo "${RED}Could not find this machine's token on disk.${RESET}" >&2
  echo "Copy it from the Termdeck dashboard (Machines -> your machine) and re-run:" >&2
  echo "  curl -fsSL $MASTER/heal.sh | TERMDECK_AGENT_TOKEN=agt_... sh" >&2
  exit 1
fi
echo "${CYAN}==> Found this machine's token — reusing it, the machine keeps its identity.${RESET}"

echo "${CYAN}==> Removing the old agent ...${RESET}"
# Never fatal: the whole reason you are running this may be that the old install is
# already broken. Whatever is left, the reinstall below overwrites.
curl -fsSL "$MASTER/uninstall.sh" | sh >/dev/null 2>&1 || true

n=1
OK=""
while [ "$n" -le "$ATTEMPTS" ]; do
  echo "${CYAN}==> Installing a fresh agent (attempt $n of $ATTEMPTS) ...${RESET}"
  if curl -fsSL "$MASTER/install.sh" | TERMDECK_AGENT_TOKEN="$TOKEN" TERMDECK_NO_PROMPT=1 sh; then
    OK=1
    break
  fi
  echo "${YELLOW}Attempt $n failed.${RESET}"
  n=$((n + 1))
  # An `if`, not `x && sleep`: under `set -e` a trailing AND-list that ends false
  # is implementation-defined, and losing the diagnostics below is the one thing this
  # script cannot afford to get wrong.
  if [ "$n" -le "$ATTEMPTS" ]; then sleep "$RETRY_SECS"; fi
done

echo ""
if [ -n "$OK" ]; then
  echo "${GREEN}------------------------------------------------------------${RESET}"
  echo "${GREEN}Repaired. This machine should go online in the dashboard within a few seconds.${RESET}"
  echo "${GREEN}------------------------------------------------------------${RESET}"
  echo ""
  exit 0
fi

echo "${RED}------------------------------------------------------------${RESET}"
echo "${RED}Repair failed after $ATTEMPTS attempts.${RESET}"
echo "${RED}------------------------------------------------------------${RESET}"
echo "${YELLOW}Most likely causes, in order:${RESET}"
echo "  1. Node.js 18+ is missing or not on PATH   ->  node --version"
echo "  2. This machine cannot reach $MASTER       ->  curl -fsSL $MASTER/VERSION"
echo "  3. npm could not install ws + chokidar     ->  scroll up for its error"
echo ""
echo "Send that output to support and we will take it from there."
exit 1
