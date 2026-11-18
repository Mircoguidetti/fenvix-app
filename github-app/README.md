# fenvix GitHub App (backend)

Webhooks with signature verification, installations stored per organization, the onboarding pull request
(`runs-on: fenvix` on the test job only), the run result on GitHub (check run + one pull request comment updated in
place) and one usage event per run. TypeScript on Node 22 (run directly, no build), Fastify, `pg`, strict TypeScript,
config from the environment. Two ways to run it: a node server (`npm start`, the tests) or AWS Lambda behind API
Gateway with an SQS queue (`src/lambda/`, `../docs/DEPLOY-AWS.md`).

**Read `../docs/GITHUB-APP.md`**: what it does, the exact clicks to create the App, every environment variable,
the billing rule, and how to run the tests.

| Path | What |
|---|---|
| `src/app.ts` | routes: `/webhooks/github`, `/v1/runner/summaries`, `/v1/github/install-link`, `/github/setup`, `/v1/repositories/:id/onboarding` |
| `src/service.ts` | webhook handling, onboarding, publishing a finished run, usage events, linking |
| `src/onboarding/workflow.ts` | finds the test job, changes only its `runs-on` (source-range edit, comments kept), unified diff |
| `src/onboarding/onboard.ts` | the onboarding pull request through the REST API |
| `src/results/` | the runner's `summary.json` (parse, trim) and the check run / comment text |
| `src/github/` | App JWT, installation tokens, REST client, webhook signature |
| `src/work.ts` | the hand-off after a checked request: in this process (node server) or a queue (Lambda) |
| `src/lambda/`, `src/queue/sqs.ts` | AWS Lambda entry points (http, worker, sweep), the API Gateway adapter, secrets from SSM, the SQS hand-off with S3 overflow; deployed by `../infra/github-app` (`../docs/DEPLOY-AWS.md`) |
| `../supabase/migrations/0013_github_app.sql` | tables, the role `fenvix_github_app`, row level security; tested by `../supabase/tests/gh-rls.sql` |
| `tests/` | unit and integration tests; fake GitHub checked against GitHub's OpenAPI and webhook schemas |
| `tests/fixtures/runner/` | real `summary.json` files written by `runner/fenvix-run` |
| `recordings/` | the recorded end to end (`npm run e2e:record`) |

No GitHub Actions workflow is added for this folder: the repository is private and Actions minutes cost money. Tests
run locally.
