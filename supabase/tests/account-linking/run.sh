#!/usr/bin/env bash
# The account linking rules, checked against the REAL Supabase Auth server (GoTrue, in Docker) with
# made-up GitHub / Google people. Needs Docker, Node 22 and psql. FOR A LOCAL SCRATCH DATABASE ONLY.
#
#   LAB_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/authlab bash supabase/tests/account-linking/run.sh
#
# The database must be empty and disposable: GoTrue creates the auth schema in it, then the
# migrations 0001, 0002 and 0006 are applied on top (0003, 0004 and 0005 live on other branches and
# are not needed here). Nothing here talks to a Supabase project or uses a real secret: the JWT
# secret is random for each run and the OAuth "client secrets" are the word "lab".
#
#   BASELINE=1 also runs baseline.mjs first, which prints what Supabase Auth does WITHOUT 0006.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"

url="${LAB_DATABASE_URL:-}"
image="${GOTRUE_IMAGE:-supabase/gotrue:v2.180.0}"
if [[ -z "$url" ]]; then echo "Set LAB_DATABASE_URL to an empty scratch database." >&2; exit 2; fi
if [[ "$url" == *supabase.co* || "$url" == *supabase.com* || "$url" == *pooler* ]]; then
  echo "Refusing to run against what looks like a hosted Supabase project." >&2; exit 2
fi
if [[ -n "$(psql "$url" -tAc "select 1 from pg_namespace where nspname = 'auth'")" ]]; then
  echo "The database already has an auth schema. Use an empty scratch database." >&2; exit 2
fi
hostport="$(node -e 'const u=new URL(process.argv[1]);console.log(`${u.hostname}:${u.port||5432}/${u.pathname.slice(1)}`)' "$url")"
psql_run() { psql "$url" -v ON_ERROR_STOP=1 -q "$@"; }

cleanup() {
  docker rm -f fenvix-lab-gotrue >/dev/null 2>&1 || true
  [[ -n "${fake_pid:-}" ]] && kill "$fake_pid" 2>/dev/null || true
}
trap cleanup EXIT

echo "1/6 roles Supabase has and a plain Postgres does not"
psql_run <<'SQL'
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
do $$ begin create role supabase_auth_admin login superuser; exception when duplicate_object then null; end $$;
create schema if not exists auth authorization supabase_auth_admin;
create schema if not exists extensions;
grant usage on schema auth to anon, authenticated, service_role;
SQL

echo "2/6 stand-in providers and mail"
node "$here/fake-providers.mjs" >/dev/null 2>&1 &
fake_pid=$!

echo "3/6 Supabase Auth ($image)"
docker rm -f fenvix-lab-gotrue >/dev/null 2>&1 || true
docker run -d --name fenvix-lab-gotrue --network host \
  -e GOTRUE_API_HOST=127.0.0.1 -e PORT=9998 -e API_EXTERNAL_URL=http://127.0.0.1:9998 \
  -e GOTRUE_DB_DRIVER=postgres -e "GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin@${hostport}?sslmode=disable&search_path=auth" \
  -e GOTRUE_DB_NAMESPACE=auth -e GOTRUE_SITE_URL=http://localhost:3000 -e 'GOTRUE_URI_ALLOW_LIST=http://localhost:3000/**,http://127.0.0.1:4176/**' \
  -e "GOTRUE_JWT_SECRET=$(openssl rand -hex 32)" -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_AUD=authenticated -e GOTRUE_JWT_ADMIN_ROLES=service_role \
  -e GOTRUE_DISABLE_SIGNUP=false -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true \
  -e GOTRUE_MAILER_AUTOCONFIRM=false -e GOTRUE_SECURITY_MANUAL_LINKING_ENABLED=true \
  -e GOTRUE_SMTP_HOST=127.0.0.1 -e GOTRUE_SMTP_PORT=2525 -e GOTRUE_SMTP_ADMIN_EMAIL=noreply@fenvix.test \
  -e GOTRUE_SMTP_MAX_FREQUENCY=1s -e GOTRUE_RATE_LIMIT_EMAIL_SENT=10000 -e GOTRUE_MAILER_OTP_EXP=3600 \
  -e GOTRUE_EXTERNAL_GITHUB_ENABLED=true -e GOTRUE_EXTERNAL_GITHUB_CLIENT_ID=lab -e GOTRUE_EXTERNAL_GITHUB_SECRET=lab \
  -e GOTRUE_EXTERNAL_GITHUB_URL=http://127.0.0.1:9999/gh -e GOTRUE_EXTERNAL_GITHUB_REDIRECT_URI=http://127.0.0.1:9998/callback \
  -e GOTRUE_EXTERNAL_KEYCLOAK_ENABLED=true -e GOTRUE_EXTERNAL_KEYCLOAK_CLIENT_ID=lab -e GOTRUE_EXTERNAL_KEYCLOAK_SECRET=lab \
  -e GOTRUE_EXTERNAL_KEYCLOAK_URL=http://127.0.0.1:9999/kc -e GOTRUE_EXTERNAL_KEYCLOAK_REDIRECT_URI=http://127.0.0.1:9998/callback \
  "$image" gotrue >/dev/null
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:9998/health >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:9998/health >/dev/null || { docker logs fenvix-lab-gotrue | tail -20; echo "GoTrue did not start" >&2; exit 1; }

echo "4/6 migrations 0001, 0002$( [[ -n "${BASELINE:-}" ]] && echo ' (baseline first)'), 0006"
psql_run -f "$root/supabase/migrations/0001_init.sql" >/dev/null 2>&1
psql_run -f "$root/supabase/migrations/0002_control_plane.sql" >/dev/null 2>&1
export LAB_DATABASE_URL="$url"
if [[ -n "${BASELINE:-}" ]]; then node "$here/baseline.mjs"; fi
psql_run -f "$root/supabase/migrations/0006_account_linking.sql" >/dev/null 2>&1
psql_run -f "$root/supabase/migrations/0006_account_linking.sql" >/dev/null 2>&1

echo "5/6 scenarios"
node "$here/scenarios.mjs"

echo "6/6 the dashboard in a browser, against this Supabase Auth"
node "$here/dashboard-e2e.mjs"
