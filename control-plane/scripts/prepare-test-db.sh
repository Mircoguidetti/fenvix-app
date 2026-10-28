#!/usr/bin/env bash
# Applies the Supabase stand-ins and the five migrations (twice: they must be safe to repeat) to an
# EMPTY SCRATCH Postgres 15+ database. Refuses anything that looks like a hosted Supabase project.
#
#   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/cp_scratch bash scripts/prepare-test-db.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

url="${TEST_DATABASE_URL:-}"
if [[ -z "$url" ]]; then echo "Set TEST_DATABASE_URL to an empty scratch database." >&2; exit 2; fi
if [[ "$url" == *supabase.co* || "$url" == *supabase.com* || "$url" == *pooler* ]]; then
  echo "Refusing to run against what looks like a hosted Supabase project." >&2; exit 2
fi
psql_run() { psql "$url" -v ON_ERROR_STOP=1 -q "$@"; }

psql_run -f supabase/tests/local-stub.sql >/dev/null
for i in 1 2; do
  psql_run -f supabase/migrations/0001_init.sql >/dev/null 2>&1
  psql_run -f supabase/migrations/0002_control_plane.sql >/dev/null 2>&1
  psql_run -f supabase/migrations/0003_close_dashboard_write_path.sql >/dev/null 2>&1
  psql_run -f supabase/migrations/0004_data_explorer.sql >/dev/null 2>&1
  psql_run -f supabase/migrations/0005_engine_users.sql >/dev/null 2>&1
done
echo "scratch database ready: 0001 to 0005 applied twice"
