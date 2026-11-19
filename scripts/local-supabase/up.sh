#!/usr/bin/env bash
# A local Supabase for development and the integration tests: the real Supabase Postgres image and the real Supabase
# Auth (GoTrue) server, in Docker, signing tokens with a fresh ES256 key (published at /auth/v1/.well-known/jwks.json,
# as a hosted project does), plus a small proxy that serves Auth under /auth/v1. Applies the migrations (0001 to 0013
# once, then 0014 and later twice each: they must be safe to repeat) and gives the API's and the App's roles local passwords.
#
#   bash scripts/local-supabase/up.sh        # start (or restart from empty)
#   bash scripts/local-supabase/down.sh      # stop and remove everything
#
# Prints the environment to use; scripts/local-supabase/env.sh holds it for the other scripts. LOCAL ONLY: the
# passwords here are for this throwaway database.
set -euo pipefail
cd "$(dirname "$0")/../.."
DB_PORT="${LOCAL_DB_PORT:-54322}"; AUTH_PORT="${LOCAL_AUTH_PORT:-54321}"; PROXY_PORT="${LOCAL_SUPABASE_PORT:-54320}"
PG_IMAGE="supabase/postgres:15.8.1.085"; AUTH_IMAGE="supabase/gotrue:v2.186.0"
STATE="${LOCAL_SUPABASE_STATE:-${TMPDIR:-/tmp}/fenvix-local-supabase}"
mkdir -p "$STATE"

docker info >/dev/null 2>&1 || { echo "Docker is not running." >&2; exit 2; }
docker rm -f fenvix-auth fenvix-db >/dev/null 2>&1 || true
docker network create fenvix-local >/dev/null 2>&1 || true

docker run -d --name fenvix-db --network fenvix-local -e POSTGRES_PASSWORD=postgres -p "127.0.0.1:$DB_PORT:5432" "$PG_IMAGE" >/dev/null
export PGPASSWORD=postgres
for _ in $(seq 1 90); do psql -h 127.0.0.1 -p "$DB_PORT" -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1 && break; sleep 1; done
psql -h 127.0.0.1 -p "$DB_PORT" -U supabase_admin -d postgres -qc "alter role supabase_auth_admin password 'local-auth-admin'"

# A fresh signing key for this run (never committed).
node -e '
const { generateKeyPairSync, randomUUID } = require("node:crypto");
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = privateKey.export({ format: "jwk" });
Object.assign(jwk, { kid: randomUUID(), alg: "ES256", use: "sig", key_ops: ["sign", "verify"] });
process.stdout.write(JSON.stringify([jwk]));' > "$STATE/jwks.json"

SUPABASE_URL="http://127.0.0.1:$PROXY_PORT"
docker run -d --name fenvix-auth --network fenvix-local -p "127.0.0.1:$AUTH_PORT:9999" \
  -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL="$SUPABASE_URL/auth/v1" \
  -e GOTRUE_DB_DRIVER=postgres -e "GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:local-auth-admin@fenvix-db:5432/postgres" \
  -e GOTRUE_SITE_URL="${LOCAL_SITE_URL:-http://localhost:4173}" -e GOTRUE_URI_ALLOW_LIST="http://localhost:4173/,http://localhost:5173/" \
  -e GOTRUE_JWT_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')" \
  -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_AUD=authenticated -e GOTRUE_JWT_ISSUER="$SUPABASE_URL/auth/v1" \
  -e "GOTRUE_JWT_KEYS=$(cat "$STATE/jwks.json")" \
  -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_MAILER_AUTOCONFIRM=true -e GOTRUE_DISABLE_SIGNUP=false \
  "$AUTH_IMAGE" >/dev/null
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$AUTH_PORT/health" >/dev/null && break; sleep 1; done
# GoTrue has created auth.users once it answers.
for _ in $(seq 1 30); do psql -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres -Atc "select to_regclass('auth.users')" | grep -q users && break; sleep 1; done

for f in supabase/migrations/00{01..13}_*.sql; do
  [[ -f "$f" ]] || continue
  psql -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>"$STATE/migrate.err" || { cat "$STATE/migrate.err" >&2; exit 1; }
done
for _ in 1 2; do
  for f in supabase/migrations/00{14..99}_*.sql; do
    [[ -f "$f" ]] || continue
    psql -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>"$STATE/migrate.err" || { cat "$STATE/migrate.err" >&2; exit 1; }
  done
done
psql -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres -qc "alter role fenvix_api password 'local-api'; alter role fenvix_github_app password 'local-github-app'"

# The /auth/v1 proxy.
if [[ -f "$STATE/proxy.pid" ]]; then kill "$(cat "$STATE/proxy.pid")" 2>/dev/null || true; fi
GOTRUE_URL="http://127.0.0.1:$AUTH_PORT" PORT="$PROXY_PORT" nohup node scripts/local-supabase/auth-proxy.mjs >"$STATE/proxy.log" 2>&1 &
echo $! > "$STATE/proxy.pid"
for _ in $(seq 1 30); do curl -sf "$SUPABASE_URL/auth/v1/health" >/dev/null && break; sleep 0.3; done

cat > "$STATE/env.sh" <<ENV
export LOCAL_SUPABASE_URL=$SUPABASE_URL
export LOCAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:$DB_PORT/postgres
export LOCAL_API_DATABASE_URL=postgresql://fenvix_api:local-api@127.0.0.1:$DB_PORT/postgres
export LOCAL_GITHUB_APP_DATABASE_URL=postgresql://fenvix_github_app:local-github-app@127.0.0.1:$DB_PORT/postgres
export LOCAL_AUTH_URL=http://127.0.0.1:$AUTH_PORT
ENV
echo "local Supabase ready ($STATE/env.sh):"
cat "$STATE/env.sh"
