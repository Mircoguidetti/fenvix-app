# Deleted: the earlier serverless database product

fenvix is now fenvix CI (deterministic CI: tests skipped with proof, audit reruns, flaky tests turned into reproducible
defects), served by the GitHub App service (`github-app/`, `infra/github-app/`) and the dashboard (`src/`). The earlier
product, serverless databases (databases, tags, IP allowlists, hourly and daily usage, wake events, invoices, the data
explorer and its audit log, engine users, database users, operations, the control plane and its AWS stack), was
removed. Every path below was tracked by git at commit `facd891` (`git ls-files`) and can be read again with
`git show facd891:<path>`.

285 files in all: code 128, infra 41, workflows 2, docs 103, scripts 2, fixtures and results 9.

## Code (128 files)

- `control-plane/` (128 files: the control-plane API service, its engine adapter, tests, docs and Dockerfile)

## Infra (41 files)

The top-level CDK app for the engine server and the control plane. `infra/github-app/` and `infra/customer-mode/`
stay: neither imports or reads anything below.

- `infra/bin/` (1 file)
- `infra/lib/` (12 files)
- `infra/scripts/` (1 file)
- `infra/test/` (15 files)
- `infra/.gitignore`
- `infra/README.md`
- `infra/cdk.json`
- `infra/deploy-policy.json`
- `infra/github-deploy-guardrails.json`
- `infra/github-deploy-trust.json`
- `infra/jest.config.js`
- `infra/package-lock.json`
- `infra/package.json`
- `infra/report-infra-align.md`
- `infra/results-infra.md`
- `infra/tsconfig.json`

## Workflows (2 files)

- `.github/workflows/deploy-control-plane.yml`
- `.github/workflows/release-control-plane.yml`

## Docs (103 files)

- `docs/console-ui/` (55 files: the README and 54 screenshots of the database console)
- `docs/control-plane-api.md`
- `docs/deploy-checklist.md`
- `docs/product-plan-template-fleet-agents.md`
- `docs/scale-out-design.md`

Screenshots of database screens in `docs/ui/` (44 files; the folder stays, `scripts/ui-shots.mjs` writes there):

- `docs/ui/confirm-dialog-1440.png`
- `docs/ui/confirm-dialog-390.png`
- `docs/ui/create-database-1440.png`
- `docs/ui/create-database-390.png`
- `docs/ui/create-database-mockup-1440.png`
- `docs/ui/create-database-side-by-side-1440.png`
- `docs/ui/data-add-field-1440.png`
- `docs/ui/data-add-field-390.png`
- `docs/ui/data-collections-1440.png`
- `docs/ui/data-collections-390.png`
- `docs/ui/data-collections-mockup-1440.png`
- `docs/ui/data-collections-side-by-side-1440.png`
- `docs/ui/data-document-1440.png`
- `docs/ui/data-document-390.png`
- `docs/ui/data-documents-1440.png`
- `docs/ui/data-documents-390.png`
- `docs/ui/data-query-builder-1440.png`
- `docs/ui/data-query-builder-390.png`
- `docs/ui/data-query-builder-mockup-1440.png`
- `docs/ui/data-query-builder-side-by-side-1440.png`
- `docs/ui/database-network-1440.png`
- `docs/ui/database-network-390.png`
- `docs/ui/database-network-mockup-1440.png`
- `docs/ui/database-network-side-by-side-1440.png`
- `docs/ui/database-overview-1440.png`
- `docs/ui/database-overview-390.png`
- `docs/ui/database-overview-mockup-1440.png`
- `docs/ui/database-overview-side-by-side-1440.png`
- `docs/ui/database-users-1440.png`
- `docs/ui/database-users-390.png`
- `docs/ui/database-users-mockup-1440.png`
- `docs/ui/database-users-side-by-side-1440.png`
- `docs/ui/databases-1440.png`
- `docs/ui/databases-390.png`
- `docs/ui/databases-filtered-1440.png`
- `docs/ui/databases-filtered-390.png`
- `docs/ui/databases-mockup-1440.png`
- `docs/ui/databases-side-by-side-1440.png`
- `docs/ui/insert-dialog-1440.png`
- `docs/ui/insert-dialog-390.png`
- `docs/ui/restore-dialog-1440.png`
- `docs/ui/restore-dialog-390.png`
- `docs/ui/restore-dialog-mockup-1440.png`
- `docs/ui/restore-dialog-side-by-side-1440.png`

## Scripts (2 files)

- `scripts/fake-supabase.mjs`
- `scripts/supabase-e2e.mjs`

## Fixtures and results (9 files)

- `results-control-plane.md`
- `results-cp-engine-round2.md`
- `results-data-browser.md`
- `results-db-users.md`
- `results-e2e-engine.md`
- `results-e2e-final.md`
- `results-engine-adapter.md`
- `results-release-candidate.md`
- `supabase/seed.sql`

`supabase/seed.sql` filled one workspace with about 3,000 databases, their usage, wake-ups, invoices and API keys.

## Database objects

Dropped by section 1 of `supabase/migrations/0014_dashboard_api.sql`. Migrations 0001 to 0013 stay as history:
0014 runs after them and removes what they made for the old product.

- Tables (with their policies, triggers, indexes and sequences): `public_api_keys`, `database_ip_allowlists`,
  `data_audit_log`, `database_tags`, `usage_hourly`, `usage_daily`, `wake_events`, `invoices`, `operations`,
  `idempotency_keys`, `audit_log`, `api_keys`, `databases`, `workspace_settings` (its `email_notices` setting moved
  to `workspaces.email_notices` first).
- Type: `database_state`.
- Functions: every `public.fenvix_*` function (the dashboard's database functions and the control plane's
  `fenvix_cp_*`), the `public_api_keys_*` functions and triggers (including the `workspace_members_revoke_public_keys`
  trigger), `set_workspace_from_database`, `current_workspace`.
- Role: `fenvix_control_plane`, with its policies on the tables that stay and all its grants in `public`.

## Kept and moved

- Organizations (`workspaces`), members (`workspace_members`), invitations (`workspace_invites`), the sign-up trigger
  (`ensure_workspace`, now without the old settings table) and the membership helpers (`my_workspace_ids`,
  `my_admin_workspace_ids`, `is_workspace_member`).
- They are now served by the new API in `github-app/src/api/`; its organizations logic is ported from
  `control-plane/src/services/orgs.ts`.
