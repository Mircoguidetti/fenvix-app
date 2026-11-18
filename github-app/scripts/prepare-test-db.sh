#!/usr/bin/env bash
# Applies the Supabase stand-ins and every migration up to 0014 (each twice: they must be safe to repeat) to an EMPTY
# SCRATCH Postgres 15+ database, then gives the role fenvix_github_app a password for the tests. Refuses anything that
# looks like a hosted Supabase project.
#
#   TEST_DATABASE_URL=postgresql://postgres@localhost:54329/gh_test bash scripts/prepare-test-db.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

url="${TEST_DATABASE_URL:-postgresql://postgres@localhost:54329/gh_test}"
if [[ "$url" == *supabase.co* || "$url" == *supabase.com* || "$url" == *pooler* ]]; then
  echo "Refusing to run against what looks like a hosted Supabase project." >&2; exit 2
fi
psql_run() { psql "$url" -v ON_ERROR_STOP=1 -q "$@"; }

psql_run -f supabase/tests/local-stub.sql >/dev/null
for i in 1 2; do
  for f in 0001_init 0002_control_plane 0003_close_dashboard_write_path 0004_data_explorer 0005_engine_users \
           0007_database_users 0008_organizations 0009_ip_allowlist 0010_public_api_keys 0011_ci_runs \
           0012_ci_explorations 0013_github_app 0014_pnap_customer_mode; do
    psql_run -f "supabase/migrations/$f.sql" >/dev/null 2>"/tmp/gh-prepare-$f.err" || { cat "/tmp/gh-prepare-$f.err" >&2; exit 1; }
  done
done
# A local password for the restricted role, for the tests only (the real one is set outside the repository).
psql_run -c "alter role fenvix_github_app password 'local-test-only'" >/dev/null
echo "scratch database ready: 0001 to 0014 applied twice (0006 is on another branch)"
