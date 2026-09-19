# Shared .env parsing helpers with dotenv semantics, sourced by kilo-serve.sh
# and sync-kilo-password.sh. A trailing CR and one pair of matching
# surrounding quotes (single or double) are stripped, so shell-extracted
# values always equal what the backend's dotenv (server/src/env.ts) reads.

# env_get KEY FILE — print the first KEY=VALUE from FILE (empty if absent).
env_get() {
  awk -v key="$1" '
    index($0, key "=") == 1 {
      v = substr($0, length(key) + 2)
      sub(/\r$/, "", v)
      if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) v = substr(v, 2, length(v) - 2)
      print v
      exit
    }' "$2" 2>/dev/null || true
}
