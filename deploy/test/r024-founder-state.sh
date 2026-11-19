#!/usr/bin/env bash
# Review R-024 reproduction: a fresh real Supabase Postgres (+ GoTrue for auth.users) in a given hand-migrated state,
# then `node deploy/cli.mjs migrate` twice. Needs Docker and the network fenvix-local (scripts/local-supabase/up.sh).
# usage: founder.sh <scenario>   (founder | upto0013 | upto0010)
set -euo pipefail
cd /home/user/fenvix-app
P=54340; A=54341; SC="$1"
docker rm -f r24-db r24-auth >/dev/null 2>&1 || true
docker run -d --name r24-db --network fenvix-local -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:$P:5432 supabase/postgres:15.8.1.085 >/dev/null
export PGPASSWORD=postgres
for _ in $(seq 1 90); do psql -h 127.0.0.1 -p $P -U supabase_admin -d postgres -Atc "select 1" >/dev/null 2>&1 && break; sleep 1; done
psql -h 127.0.0.1 -p $P -U supabase_admin -d postgres -qc "alter role supabase_auth_admin password 'x'"
docker run -d --name r24-auth --network fenvix-local -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 -e API_EXTERNAL_URL=http://x \
  -e GOTRUE_DB_DRIVER=postgres -e "GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:x@r24-db:5432/postgres" -e GOTRUE_SITE_URL=http://x \
  -e GOTRUE_JWT_SECRET=0123456789abcdef0123456789abcdef -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_AUD=authenticated -p 127.0.0.1:$A:9999 supabase/gotrue:v2.186.0 >/dev/null
for _ in $(seq 1 60); do psql -h 127.0.0.1 -p $P -U postgres -d postgres -Atc "select to_regclass('auth.users')" 2>/dev/null | grep -q users && break; sleep 1; done
docker rm -f r24-auth >/dev/null
q() { psql -h 127.0.0.1 -p $P -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
last=0017; [ "$SC" = upto0013 ] && last=0013; [ "$SC" = upto0010 ] && last=0010
for f in supabase/migrations/00{01..10}_*.sql; do [ -f "$f" ] && q -f "$f" >/dev/null 2>&1; done
if [ "$last" != 0010 ]; then
  # 0011..$last pasted as ONE text and run once (the SQL editor sends it as one query: one implicit transaction)
  all="$(for f in supabase/migrations/00{11..17}_*.sql; do v=$(basename "$f" | cut -c1-4); [[ "$v" > "$last" ]] && continue; cat "$f"; echo; done)"
  q -c "$all" >/dev/null 2>&1
fi
cd deploy
export FENVIX_DEPLOY_LOCAL_DB=1 SUPABASE_DB_URL="postgresql://postgres:postgres@127.0.0.1:$P/postgres"
before="$(psql -h 127.0.0.1 -p $P -U postgres -d postgres -Atc "select md5(string_agg(n.nspname||'.'||c.relname||':'||c.relkind::text||':'||c.relrowsecurity::text, ',' order by 1)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'")"
echo "--- run 1"; node cli.mjs migrate || echo "exit $?"
echo "--- run 2"; node cli.mjs migrate || echo "exit $?"
after="$(psql -h 127.0.0.1 -p $P -U postgres -d postgres -Atc "select md5(string_agg(n.nspname||'.'||c.relname||':'||c.relkind::text||':'||c.relrowsecurity::text, ',' order by 1)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'")"
echo "public schema unchanged by the runner: $([ "$before" = "$after" ] && echo yes || echo no)"
psql -h 127.0.0.1 -p $P -U postgres -d postgres -Atc "select string_agg(version||':'||how, ' ' order by version) from fenvix_deploy.schema_migrations" 2>&1 || true
docker rm -f r24-db >/dev/null
