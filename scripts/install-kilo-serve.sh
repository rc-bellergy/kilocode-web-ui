#!/usr/bin/env bash
# Install (or refresh) the launchd agent that runs kilo-serve.sh at login.
# Generates ~/Library/LaunchAgents/com.kilocode.kilo-serve.plist from the
# template with this repo's absolute path baked in, so the agent keeps
# working relative to wherever the repo lives at install time.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$HOME/Library/LaunchAgents/com.kilocode.kilo-serve.plist"

sed "s|__ROOT__|$root|g" "$root/scripts/com.kilocode.kilo-serve.plist.template" > "$dest"
launchctl unload "$dest" 2>/dev/null || true
launchctl load "$dest"

echo "installed $dest"
echo "kilo serve starts now and at login (logs: /tmp/kilo-serve.log, /tmp/kilo-serve.err.log)"
