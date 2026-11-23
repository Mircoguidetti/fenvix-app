#!/usr/bin/env bash
# The database's own tests against a SCRATCH Postgres (15 or newer): the Supabase stand-ins, the migrations 0001 to 0013
# once, then 0014 to 0020 twice each (they must be safe to repeat; 0001 to 0013 are not any more once 0014 has removed the earlier
# product, which is expected), then the row level security tests:
#   api-rls.sql         the dashboard API's role fenvix_api: members read their organization only, owners and admins
#                       change settings, region, project settings, members and invitations; the browser's roles (anon,
#                       authenticated) have no right left on any table; the earlier product's tables are gone
#   ci-rls.sql          the CI tables (0011), read through fenvix_api, written by the GitHub App (fenvix_github_app)
#   ci-explore-rls.sql  nights of exploration (0012)
#   gh-rls.sql          the GitHub App's tables (0013), linking an installation (and its trial)
#   warm-rls.sql        warm-ups and the repositories' cache state (0017): the App writes them, members read their own
#   runners-check.sql   the runner lists accept node:test and mocha, one CHECK constraint per column (0018)
#   run-proof-check.sql the not_proven status and outcome, proof and its counts, one CHECK constraint each (0019)
#
#   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/fenvix_scratch npm run test:rls
#
# The database must be empty and disposable. The script refuses anything that looks like a hosted Supabase project,
# because it creates roles and a stand-in auth schema.
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

out="$(mktemp)"
trap 'rm -f "$out"' EXIT
psql_run() { psql "$url" -v ON_ERROR_STOP=1 -q "$@"; }
migrate() { psql_run -f "supabase/migrations/$1.sql" >"$out" 2>&1 || { echo "migration $1 failed:" >&2; grep -v NOTICE "$out" >&2; exit 1; }; }
check() {  # file, the line a clean run prints
  if psql_run -f "supabase/tests/$1" >"$out" 2>&1 && grep -q "$2" "$out"; then echo "     $2"; else
    echo "FAILED: supabase/tests/$1" >&2; grep -E "ERROR|FATAL" "$out" >&2 || cat "$out" >&2; exit 1
  fi
}

echo "1/3 local stand-ins for Supabase"; psql_run -f supabase/tests/local-stub.sql >/dev/null
echo "2/3 migrations: 0001 to 0013 once, then 0014 to 0020 twice each"
for f in 0001_init 0002_control_plane 0003_close_dashboard_write_path 0004_data_explorer 0005_engine_users 0007_database_users \
         0008_organizations 0009_ip_allowlist 0010_public_api_keys 0011_ci_runs 0012_ci_explorations 0013_github_app; do
  migrate "$f"
done
migrate 0014_dashboard_api
migrate 0014_dashboard_api
migrate 0015_review_r016
migrate 0015_review_r016
migrate 0016_review_r016b
migrate 0016_review_r016b
migrate 0017_warm_cache
migrate 0017_warm_cache
migrate 0018_node_test_mocha_runners
migrate 0018_node_test_mocha_runners
migrate 0019_run_proof
migrate 0019_run_proof
migrate 0020_summary_rejected
migrate 0020_summary_rejected
echo "3/3 row level security"
check api-rls.sql "API RLS OK"
check ci-rls.sql "CI RLS OK"
check ci-explore-rls.sql "CI EXPLORE RLS OK"
check gh-rls.sql "GH RLS OK"
check warm-rls.sql "WARM RLS OK"
check runners-check.sql "RUNNERS CHECK OK"
check run-proof-check.sql "RUN PROOF CHECK OK"
echo "done: migrations and the dashboard API's, the CI tables' and the GitHub App's row level security pass"
