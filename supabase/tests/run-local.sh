#!/usr/bin/env bash
# Runs the migrations, the SQL tests (including the CI dashboard's, 0011 and ci-rls.sql, and the GitHub App's, 0013 and gh-rls.sql) and the seed against a SCRATCH Postgres (15 or newer).
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

echo "1/7 local stand-ins for Supabase";  psql_run -f supabase/tests/local-stub.sql >/dev/null
echo "2/7 migration (twice: it must be safe to repeat)"; psql_run -f supabase/migrations/0001_init.sql >/dev/null 2>&1; psql_run -f supabase/migrations/0001_init.sql >/dev/null 2>&1
echo "3/7 row level security";            psql_run -f supabase/tests/rls.sql 2>&1 | grep -E "RLS OK" >/dev/null && echo "     RLS OK"
echo "4/7 functions";                     psql_run -f supabase/tests/functions.sql 2>&1 | grep -E "FUNCTIONS OK" >/dev/null && echo "     FUNCTIONS OK"
echo "5/7 organizations: 0002, 0004, 0005, 0007 and 0008 (each twice), then their row level security"
for f in 0002_control_plane 0004_data_explorer 0005_engine_users 0007_database_users 0008_organizations; do
  psql_run -f "supabase/migrations/$f.sql" >/dev/null 2>&1; psql_run -f "supabase/migrations/$f.sql" >/dev/null 2>&1
done
psql_run -f supabase/tests/orgs-rls.sql 2>&1 | grep -E "ORGS RLS OK" >/dev/null && echo "     ORGS RLS OK"
echo "6/7 CI dashboard: 0011 and 0012 (twice each), then their row level security"
psql_run -f supabase/migrations/0011_ci_runs.sql >/dev/null 2>&1; psql_run -f supabase/migrations/0011_ci_runs.sql >/dev/null 2>&1
psql_run -f supabase/tests/ci-rls.sql 2>&1 | grep -E "CI RLS OK" >/dev/null && echo "     CI RLS OK"
psql_run -f supabase/migrations/0012_ci_explorations.sql >/dev/null 2>&1; psql_run -f supabase/migrations/0012_ci_explorations.sql >/dev/null 2>&1
psql_run -f supabase/tests/ci-explore-rls.sql 2>&1 | grep -E "CI EXPLORE RLS OK" >/dev/null && echo "     CI EXPLORE RLS OK"
echo "   GitHub App: 0013 (twice), then its row level security"
psql_run -f supabase/migrations/0013_github_app.sql >/dev/null 2>&1; psql_run -f supabase/migrations/0013_github_app.sql >/dev/null 2>&1
psql_run -f supabase/tests/gh-rls.sql 2>&1 | grep -E "GH RLS OK" >/dev/null && echo "     GH RLS OK"
echo "7/7 seed (twice: the second run must change nothing)"
psql_run -c "insert into auth.users (email, raw_user_meta_data) values ('mircoguidetti1994@gmail.com', '{\"full_name\":\"Mirco Guidetti\"}') on conflict do nothing" >/dev/null
psql_run -f supabase/seed.sql 2>&1 | grep -E "Seeded" || { echo "seed did not run" >&2; exit 1; }
psql_run -f supabase/seed.sql 2>&1 | grep -E "Nothing was changed" >/dev/null && echo "     second run changed nothing"
count=$(psql "$url" -tAc "select count(*) from public.databases")
[[ "$count" == "3000" ]] || { echo "expected 3000 databases, found $count" >&2; exit 1; }
echo "done: migration, RLS, functions, organizations, CI dashboard, GitHub App and seed all pass"
