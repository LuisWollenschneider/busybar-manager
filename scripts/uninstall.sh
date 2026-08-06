#!/bin/bash
set -euo pipefail

# Resolve project directory from script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$(dirname "$SCRIPT_DIR")" && pwd)"

PLIST_DEST="$HOME/Library/LaunchAgents/nl.backspaced.busybar-manager.plist"

# Unload the service (suppress error if not loaded)
launchctl bootout "gui/$(id -u)/nl.backspaced.busybar-manager" 2>/dev/null || true

# Remove the plist
if [ -f "$PLIST_DEST" ]; then
	rm -f "$PLIST_DEST"
	echo "✓ busybar-manager verwijderd."
	echo ""
	echo "De projectbestanden in $PROJECT_DIR blijven intact."
else
	echo "⚠ LaunchAgent niet gevonden op $PLIST_DEST"
fi
