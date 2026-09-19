#!/usr/bin/env bash
# Start kilo serve on 127.0.0.1 (default :4096) with Basic auth from the
# repo-root .env (KILO_SERVER_PASSWORD). The Docker container attaches to it
# via host.docker.internal (OrbStack proxies that to host loopback).
#
# Password precedence: already-exported KILO_SERVER_PASSWORD wins over .env.
# Port override: set KILO_SERVE_PORT in the environment or .env — sync-
# kilo-password.sh and docker-compose (KILO_SERVER_URL) follow the same
# variable, so the port is defined in exactly one place.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/scripts/lib/env.sh"
env_file="$root/.env"
port="${KILO_SERVE_PORT:-$(env_get KILO_SERVE_PORT "$env_file")}"
port="${port:-4096}"

password="${KILO_SERVER_PASSWORD:-$(env_get KILO_SERVER_PASSWORD "$env_file")}"
if [[ -z "$password" ]]; then
  echo "warning: KILO_SERVER_PASSWORD is not set; kilo serve will accept unauthenticated local connections" >&2
fi

# Fail with a clear message instead of kilo's cryptic ServeError when the
# port is already held (e.g. by the VS Code extension's auto-spawned server).
if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
  echo "error: port $port is already in use — the VS Code extension's kilo serve may hold it" >&2
  echo "hint: set KILO_SERVE_PORT in .env to another port (compose follows it)" >&2
  exit 1
fi

export KILO_SERVER_PASSWORD="$password"
exec kilo serve --port="$port" --hostname=127.0.0.1
