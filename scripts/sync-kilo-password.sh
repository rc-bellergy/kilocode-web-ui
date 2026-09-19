#!/usr/bin/env bash
# Sync the live KILO_SERVER_PASSWORD of whatever kilo serve is listening on
# :${KILO_SERVE_PORT:-4096} (typically the VS Code Kilo extension's
# auto-spawned server, whose password rotates on every extension restart)
# into the repo-root .env, then recreate the Docker container so it attaches
# with fresh credentials.
#
# Usage: scripts/sync-kilo-password.sh [--force]
#   --force  recreate the container even when the password is unchanged
#
# The password is never printed and never persisted anywhere except .env.
set -euo pipefail
umask 077

force=0
if [[ "${1:-}" == "--force" ]]; then force=1; fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/scripts/lib/env.sh"
env_file="$root/.env"
port="${KILO_SERVE_PORT:-$(env_get KILO_SERVE_PORT "$env_file")}"
port="${port:-4096}"

trap 'rm -f "$env_file.tmp"' EXIT

# 1. Find the process listening on the port.
pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n1 || true)"
if [[ -z "$pid" ]]; then
  echo "error: nothing is listening on port $port" >&2
  echo "hint: start kilo first (the VS Code Kilo extension auto-spawns 'kilo serve'," >&2
  echo "      or run scripts/kilo-serve.sh for a dedicated instance)" >&2
  exit 1
fi

# 2. Read the live password from the process environment.
# Empty/missing means the target runs unsecured; that is valid (the web server
# then sends no auth header), so normalize to an empty value and continue.
if [[ "$(uname)" == "Darwin" ]]; then
  live_pw="$(ps eww -p "$pid" -o command= | tr ' ' '\n' | sed -n 's/^KILO_SERVER_PASSWORD=//p' | head -n1 || true)"
else
  live_pw="$(tr '\0' '\n' < "/proc/$pid/environ" | sed -n 's/^KILO_SERVER_PASSWORD=//p' | head -n1 || true)"
fi

# 3. Update .env: replace the existing key or append it; keep everything else.
# The comparison uses dotenv semantics (quotes/CR stripped); the written value
# is always raw so every consumer parses it identically.
touch "$env_file"
current="$(env_get KILO_SERVER_PASSWORD "$env_file")"
export LIVE_PW="$live_pw"
awk 'BEGIN { done = 0 }
  /^KILO_SERVER_PASSWORD=/ { if (!done) { print "KILO_SERVER_PASSWORD=" ENVIRON["LIVE_PW"]; done = 1 } next }
  { print }
  END { if (!done) print "KILO_SERVER_PASSWORD=" ENVIRON["LIVE_PW"] }' \
  "$env_file" > "$env_file.tmp" && mv "$env_file.tmp" "$env_file"
chmod 600 "$env_file"
unset LIVE_PW

changed=0
[[ "$current" != "$live_pw" ]] && changed=1
show() { if [[ -z "$1" ]]; then echo "(empty)"; else echo "***"; fi; }
echo "port $port pid $pid: live password $(show "$live_pw") (was $(show "$current"))"

# 4. Recreate the container when credentials changed (or --force).
if [[ $changed -eq 1 || $force -eq 1 ]]; then
  (cd "$root" && docker compose up -d)
else
  echo ".env already up to date; nothing to do (use --force to recreate anyway)"
  exit 0
fi

# 5. Verify the backend re-attached to kilo serve (attach cycle takes a few
# seconds after container start, so retry briefly).
for _ in $(seq 1 10); do
  if curl -fsS http://127.0.0.1:3100/api/health 2>/dev/null | grep -q '"ready":true'; then
    echo "ok: web backend reports kilo ready"
    exit 0
  fi
  sleep 1
done
echo "error: kilo not ready after sync — check 'docker compose logs -f'" >&2
exit 1
