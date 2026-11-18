# fenvix GitHub App (backend)

Webhooks with signature verification, installations stored per organization, the onboarding pull request
(`runs-on: fenvix` on the test job only), the run result on GitHub (check run + one pull request comment updated in
place), the dashboard's run rows (running while the job runs, with the runner's live progress, per-test results,
receipts, defects and audit reruns), the 30-day shadow trial's mode and the organization's region for each machine,
and one usage event per run. TypeScript on Node 22 (run directly, no build), Fastify, `pg`, strict TypeScript,
config from the environment. Two ways to run it: a node server (`npm start`, the tests) or AWS Lambda behind API
Gateway with an SQS queue (`src/lambda/`, `../docs/DEPLOY-AWS.md`).

**Read `../docs/GITHUB-APP.md`**: what it does, the exact clicks to create the App, every environment variable,
the billing rule, and how to run the tests.

| Path | What |
|---|---|
| `src/app.ts` | routes: `/webhooks/github`, `/v1/runner/summaries`, `/v1/runner/progress`, `/v1/runner/results`, `/v1/runner/explorations`, `/github/setup` (the dashboard API's routes: `src/api/`) |
| `src/service.ts` | webhook handling, onboarding, the run row (started, progress, finished), publishing, results and explorations, usage events, linking |
| `src/onboarding/workflow.ts` | finds the test job, changes only its `runs-on` (source-range edit, comments kept), unified diff |
| `src/onboarding/onboard.ts` | the onboarding pull request through the REST API |
| `src/results/` | the runner's `summary.json` (parse, trim), language and test runner detection (`detect.ts`), the runner's records checked against `../openapi/fenvix-api.yaml` (`runner-records.ts`) and written to the dashboard's tables (`apply.ts`), the check run / comment text |
| `src/runners/` | per-machine credentials, the per-job launcher (region placement `RUNNER_PLACEMENT`, `FENVIX_MODE`), demo machines |
| `src/github/` | App JWT, installation tokens, REST client, webhook signature |
| `src/work.ts` | the hand-off after a checked request (webhook, summary, results, exploration, onboard by repository id): in this process (node server) or a queue (Lambda) |
| `src/lambda/`, `src/queue/sqs.ts` | AWS Lambda entry points (http, worker, sweep), the API Gateway adapter, secrets from SSM, the SQS hand-off with S3 overflow; deployed by `../infra/github-app` (`../docs/DEPLOY-AWS.md`) |
| `../supabase/migrations/0013_github_app.sql`, `0014_dashboard_api.sql` | tables, the role `fenvix_github_app`, row level security (0014: trial, region, run progress, audit reruns, results staging); tested by `../supabase/tests/gh-rls.sql` |
| `tests/` | unit and integration tests; fake GitHub checked against GitHub's OpenAPI and webhook schemas |
| `tests/fixtures/runner/` | real `summary.json` files written by `runner/fenvix-run` |
| `recordings/` | the recorded end to end (`npm run e2e:record`) |

No GitHub Actions workflow is added for this folder: the repository is private and Actions minutes cost money. Tests
run locally.
