#!/usr/bin/env bash
# Stops the local Supabase of up.sh and removes its containers and state.
set -uo pipefail
STATE="${LOCAL_SUPABASE_STATE:-${TMPDIR:-/tmp}/fenvix-local-supabase}"
[[ -f "$STATE/proxy.pid" ]] && kill "$(cat "$STATE/proxy.pid")" 2>/dev/null
docker rm -f fenvix-auth fenvix-db >/dev/null 2>&1
rm -rf "$STATE"
echo "local Supabase removed"
