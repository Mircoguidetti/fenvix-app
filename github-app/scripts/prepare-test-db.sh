#!/usr/bin/env bash
# Prepares an EMPTY SCRATCH Postgres 15+ database for the App's tests: the Supabase stand-ins, the migrations 0001 to
# 0013 once, then 0014 to 0019 twice each (each must be safe to repeat; 0001 to 0013 are not any more once 0014 has removed the
# earlier product, which is expected), then local passwords for the restricted roles fenvix_github_app and fenvix_api.
# Refuses anything that looks like a hosted Supabase project.
#
#   TEST_DATABASE_URL=postgresql://postgres@localhost:54329/gh_test bash scripts/prepare-test-db.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

url="${TEST_DATABASE_URL:-postgresql://postgres@localhost:54329/gh_test}"
if [[ "$url" == *supabase.co* || "$url" == *supabase.com* || "$url" == *pooler* ]]; then
  echo "Refusing to run against what looks like a hosted Supabase project." >&2; exit 2
fi
psql_run() { psql "$url" -v ON_ERROR_STOP=1 -q "$@"; }
err="$(mktemp)"
trap 'rm -f "$err"' EXIT
apply() { psql_run -f "supabase/migrations/$1.sql" >/dev/null 2>"$err" || { echo "migration $1 failed:" >&2; cat "$err" >&2; exit 1; }; }

psql_run -f supabase/tests/local-stub.sql >/dev/null
for f in 0001_init 0002_control_plane 0003_close_dashboard_write_path 0004_data_explorer 0005_engine_users \
         0007_database_users 0008_organizations 0009_ip_allowlist 0010_public_api_keys 0011_ci_runs \
         0012_ci_explorations 0013_github_app; do
  apply "$f"
done
apply 0014_dashboard_api
apply 0014_dashboard_api
apply 0015_review_r016
apply 0015_review_r016
apply 0016_review_r016b
apply 0016_review_r016b
apply 0017_warm_cache
apply 0017_warm_cache
apply 0018_node_test_mocha_runners
apply 0018_node_test_mocha_runners
apply 0019_run_proof
apply 0019_run_proof
# Local passwords for the restricted roles, for the tests only (the real ones are set outside the repository).
psql_run -c "alter role fenvix_github_app password 'local-test-only'; alter role fenvix_api password 'local-test-only'" >/dev/null
echo "scratch database ready: 0001 to 0013 applied once, 0014 to 0019 twice (0006 is on another branch)"
