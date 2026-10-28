#!/usr/bin/env bash
# Runs the migration, both SQL tests and the seed against a SCRATCH Postgres (15 or newer).
#
#   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/fenvix_scratch npm run test:rls
#
# The database must be empty and disposable. The script refuses anything that looks like a
# hosted Supabase project, because it creates roles and a fake auth schema.
set -euo pipefail
cd "$(dirname "$0")/../.."

url="${TEST_DATABASE_URL:-}"
if [[ -z "$url" ]]; then
  echo "Set TEST_DATABASE_URL to an empty scratch database, for example:" >&2
  echo "  TEST_DATABASE_URL=postgresql://postgres@localhost:5432/fenvix_scratch npm run test:rls" >&2
  exit 2
fi
if [[ "$url" == *supabase.co* || "$url" == *supabase.com* || "$url" == *pooler* ]]; then
  echo "Refusing to run against what looks like a hosted Supabase project." >&2
  exit 2
fi

psql_run() { psql "$url" -v ON_ERROR_STOP=1 -q "$@"; }

echo "1/5 local stand-ins for Supabase";  psql_run -f supabase/tests/local-stub.sql >/dev/null
echo "2/5 migrations 0001 and 0006 (twice: they must be safe to repeat)"
for _ in 1 2; do psql_run -f supabase/migrations/0001_init.sql >/dev/null 2>&1; psql_run -f supabase/migrations/0006_account_linking.sql >/dev/null 2>&1; done
echo "3/5 row level security";            psql_run -f supabase/tests/rls.sql 2>&1 | grep -E "RLS OK" >/dev/null && echo "     RLS OK"
echo "4/5 functions";                     psql_run -f supabase/tests/functions.sql 2>&1 | grep -E "FUNCTIONS OK" >/dev/null && echo "     FUNCTIONS OK"
echo "    account linking";               { psql_run -f supabase/tests/account-linking.sql 2>&1 | grep -E "ACCOUNT LINKING OK" >/dev/null && echo "     ACCOUNT LINKING OK"; } || { echo "account linking test failed" >&2; exit 1; }
echo "5/5 seed (twice: the second run must change nothing)"
psql_run -c "insert into auth.users (email, raw_user_meta_data) values ('mircoguidetti1994@gmail.com', '{\"full_name\":\"Mirco Guidetti\"}') on conflict do nothing" >/dev/null
psql_run -f supabase/seed.sql 2>&1 | grep -E "Seeded" || { echo "seed did not run" >&2; exit 1; }
psql_run -f supabase/seed.sql 2>&1 | grep -E "Nothing was changed" >/dev/null && echo "     second run changed nothing"
count=$(psql "$url" -tAc "select count(*) from public.databases")
[[ "$count" == "3000" ]] || { echo "expected 3000 databases, found $count" >&2; exit 1; }
echo "done: migration, RLS, functions and seed all pass"
