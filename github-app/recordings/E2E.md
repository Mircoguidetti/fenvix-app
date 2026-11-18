# Recorded end to end

Written by `npm run e2e:record` (tests/integration/e2e.test.ts). Machine-readable: `e2e.json` (every webhook and every API call with its
check against GitHub's schemas). This page shows what a customer sees on GitHub.

## Sequence

| # | from | what | answer | schema |
|---|---|---|---|---|
| 1 | GitHub → App | webhook `installation.created` | 202 | ✔ webhook schema |
| 2 | App → GitHub | `POST /app/installations/4242/access_tokens` (apps/create-installation-access-token) | 201 | ✔ REST description |
| 3 | App → GitHub | `GET /repos/acme/shop` (repos/get) | 200 | ✔ REST description |
| 4 | App → GitHub | `GET /repos/acme/shop/contents/.github/workflows` (repos/get-content) | 200 | ✔ REST description |
| 5 | App → GitHub | `GET /repos/acme/shop/contents/.github/workflows/ci.yml` (repos/get-content) | 200 | ✔ REST description |
| 6 | App → GitHub | `GET /repos/acme/shop/pulls` (pulls/list) | 200 | ✔ REST description |
| 7 | App → GitHub | `GET /repos/acme/shop/git/ref/heads/main` (git/get-ref) | 200 | ✔ REST description |
| 8 | App → GitHub | `POST /repos/acme/shop/git/refs` (git/create-ref) | 201 | ✔ REST description |
| 9 | App → GitHub | `PUT /repos/acme/shop/contents/.github/workflows/ci.yml` (repos/create-or-update-file-contents) | 200 | ✔ REST description |
| 10 | App → GitHub | `POST /repos/acme/shop/pulls` (pulls/create) | 201 | ✔ REST description |
| 11 | App → GitHub | `POST /login/oauth/access_token` | 200 | — (OAuth on github.com, not the REST API) |
| 12 | App → GitHub | `GET /user/installations` (apps/list-installations-for-authenticated-user) | 200 | ✔ REST description |
| 13 | GitHub → App | webhook `pull_request.opened` | 202 | ✔ webhook schema |
| 14 | GitHub → App | webhook `pull_request.closed` | 202 | ✔ webhook schema |
| 15 | GitHub → App | webhook `push` | 202 | ✔ webhook schema |
| 16 | GitHub → App | webhook `workflow_job.queued` | 202 | ✔ webhook schema |
| 17 | GitHub → App | webhook `workflow_job.in_progress` | 202 | ✔ webhook schema |
| 18 | App → GitHub | `POST /repos/acme/shop/check-runs` (checks/create) | 201 | ✔ REST description |
| 19 | runner → App | `POST /v1/runner/summaries` run 31000 (`job1-cold-flaky.summary.json`) | 202 | — |
| 20 | GitHub → App | webhook `workflow_job.completed` | 202 | ✔ webhook schema |
| 21 | App → GitHub | `GET /repos/acme/shop/actions/runs/31000` (actions/get-workflow-run) | 200 | ✔ REST description |
| 22 | App → GitHub | `PATCH /repos/acme/shop/check-runs/1001` (checks/update) | 200 | ✔ REST description |
| 23 | GitHub → App | webhook `push` | 202 | ✔ webhook schema |
| 24 | GitHub → App | webhook `pull_request.opened` | 202 | ✔ webhook schema |
| 25 | GitHub → App | webhook `workflow_job.queued` | 202 | ✔ webhook schema |
| 26 | GitHub → App | webhook `workflow_job.in_progress` | 202 | ✔ webhook schema |
| 27 | App → GitHub | `POST /repos/acme/shop/check-runs` (checks/create) | 201 | ✔ REST description |
| 28 | runner → App | `POST /v1/runner/summaries` run 31001 (`job2-warm-real-failure.summary.json`) | 202 | — |
| 29 | GitHub → App | webhook `workflow_job.completed` | 202 | ✔ webhook schema |
| 30 | App → GitHub | `GET /repos/acme/shop/actions/runs/31001` (actions/get-workflow-run) | 200 | ✔ REST description |
| 31 | App → GitHub | `PATCH /repos/acme/shop/check-runs/1002` (checks/update) | 200 | ✔ REST description |
| 32 | App → GitHub | `GET /repos/acme/shop/issues/2/comments` (issues/list-comments) | 200 | ✔ REST description |
| 33 | App → GitHub | `POST /repos/acme/shop/issues/2/comments` (issues/create-comment) | 201 | ✔ REST description |
| 34 | GitHub → App | webhook `push` | 202 | ✔ webhook schema |
| 35 | GitHub → App | webhook `pull_request.synchronize` | 202 | ✔ webhook schema |
| 36 | GitHub → App | webhook `workflow_job.in_progress` | 202 | ✔ webhook schema |
| 37 | App → GitHub | `POST /repos/acme/shop/check-runs` (checks/create) | 201 | ✔ REST description |
| 38 | runner → App | `POST /v1/runner/summaries` run 31002 (`job3-warm-pass.summary.json`) | 202 | — |
| 39 | GitHub → App | webhook `workflow_job.completed` | 202 | ✔ webhook schema |
| 40 | App → GitHub | `GET /repos/acme/shop/actions/runs/31002` (actions/get-workflow-run) | 200 | ✔ REST description |
| 41 | App → GitHub | `PATCH /repos/acme/shop/check-runs/1004` (checks/update) | 200 | ✔ REST description |
| 42 | App → GitHub | `PATCH /repos/acme/shop/issues/comments/1003` (issues/update-comment) | 200 | ✔ REST description |

## 1. The onboarding pull request

`POST /repos/acme/shop/pulls`, request body:

```json
{
  "title": "Run the tests on fenvix (runs-on: fenvix)",
  "head": "fenvix/runs-on",
  "base": "main",
  "body": "This pull request moves the test job `test` in `.github/workflows/ci.yml` to fenvix machines: one line, `runs-on: fenvix`.\n\nNothing else in the workflow changes: same steps, same triggers, same secrets. The tests run on a fenvix machine, inside the fenvix engine:\n\n- a test whose inputs did not change since a passing run is **skipped with proof**, and its receipt says what was checked;\n- a flaky test becomes a **reproducible defect** with its replay command;\n- every run reports on the commit as a check run (and on the pull request as one comment, updated in place).\n\n### The change\n\n```diff\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -14,7 +14,7 @@\n       - run: ruff check .\n \n   test:\n-    runs-on: ubuntu-latest  # GitHub-hosted, 2 cores\n+    runs-on: fenvix  # GitHub-hosted, 2 cores\n     steps:\n       - uses: actions/checkout@v4\n       - uses: actions/setup-python@v5\n```\n\nWhy this job: runs pytest, named like a test job (was `runs-on: ubuntu-latest`).\n\n### Next\n\nMerge it when you are ready. The first run on fenvix starts cold; from the second run on, unchanged tests are skipped with proof.\nRuns, receipts and defects: https://app.fenvix.test/projects\n\nTo go back, change `runs-on: fenvix` back to the previous value.\n\n<!-- fenvix:onboarding -->"
}
```

Rendered body:

> This pull request moves the test job `test` in `.github/workflows/ci.yml` to fenvix machines: one line, `runs-on: fenvix`.
> 
> Nothing else in the workflow changes: same steps, same triggers, same secrets. The tests run on a fenvix machine, inside the fenvix engine:
> 
> - a test whose inputs did not change since a passing run is **skipped with proof**, and its receipt says what was checked;
> - a flaky test becomes a **reproducible defect** with its replay command;
> - every run reports on the commit as a check run (and on the pull request as one comment, updated in place).
> 
> ### The change
> 
> ```diff
> --- a/.github/workflows/ci.yml
> +++ b/.github/workflows/ci.yml
> @@ -14,7 +14,7 @@
>        - run: ruff check .
>  
>    test:
> -    runs-on: ubuntu-latest  # GitHub-hosted, 2 cores
> +    runs-on: fenvix  # GitHub-hosted, 2 cores
>      steps:
>        - uses: actions/checkout@v4
>        - uses: actions/setup-python@v5
> ```
> 
> Why this job: runs pytest, named like a test job (was `runs-on: ubuntu-latest`).
> 
> ### Next
> 
> Merge it when you are ready. The first run on fenvix starts cold; from the second run on, unchanged tests are skipped with proof.
> Runs, receipts and defects: https://app.fenvix.test/projects
> 
> To go back, change `runs-on: fenvix` back to the previous value.
> 
> <!-- fenvix:onboarding -->

The file on the branch (`PUT /repos/acme/shop/contents/.github/workflows/ci.yml`, branch `fenvix/runs-on`, message `ci: run the test job on fenvix (runs-on: fenvix)`):

```yaml
# CI for acme/shop
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ruff check .

  test:
    runs-on: fenvix  # GitHub-hosted, 2 cores
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.13"
      - run: pip install -e . pytest
      - run: python -m pytest -q
```

## 2. Check runs

### `POST /repos/acme/shop/check-runs` → 201

```json
{
  "name": "fenvix",
  "head_sha": "c663f502f475eb0892fa2d8972fd322ce3bba456",
  "status": "in_progress",
  "external_id": "81000",
  "started_at": "2026-11-18T09:40:05.000Z",
  "details_url": "https://github.com/acme/shop/actions/runs/31000/job/81000",
  "output": {
    "title": "Running on fenvix",
    "summary": "**CI / test** is running on a fenvix machine."
  }
}
```

Rendered summary:

> **CI / test** is running on a fenvix machine.

### `PATCH /repos/acme/shop/check-runs/1001` → 200

```json
{
  "name": "fenvix",
  "status": "completed",
  "conclusion": "failure",
  "completed_at": "2026-11-18T09:41:50.000Z",
  "external_id": "81000",
  "details_url": "https://app.fenvix.test/projects/d42b6bf6-603e-4ea9-9353-6ef7f06275e4/runs/e11de003-801b-4803-aa35-8d867b7b062d",
  "output": {
    "title": "0 of 56 tests skipped with proof · under 0.1 min (0.0 s) saved · 1 failed (1 flaky, reproducible)",
    "summary": "**CI / test** on fenvix · commit `c663f502f475` · cache cold (first run on this machine)\n\n| | |\n|---|---|\n| Tests | **56** |\n| Tests run | 56 |\n| Skipped with proof | **0** ([receipts](https://github.com/acme/shop/actions/runs/31000#artifacts)) |\n| Minutes saved | **under 0.1 min (0.0 s)** (0.0% of test time) |\n| Failures | 0 |\n| Flaky, reproducible | 1 |\n\n### Flaky tests, explained\n\nEach failed in the suite and passed when run alone: another test leaves state behind (order-dependent). The run is deterministic, so the replay fails the same way every time.\n\n- `tests/test_cart.py::test_default_currency_is_eur`\n  - replay: `python -m pytest --det --det-urandom -p no:cacheprovider -q -rN --tb=short  # whole suite, same order: fails again`\n  - find the test that breaks it: `detpy repro tests/test_cart.py::test_default_currency_is_eur --seed fixed`\n\n[Run on fenvix](https://app.fenvix.test/projects/d42b6bf6-603e-4ea9-9353-6ef7f06275e4/runs/e11de003-801b-4803-aa35-8d867b7b062d) · [Job log](https://github.com/acme/shop/actions/runs/31000/job/81000)",
    "text": "Why the other tests ran (an input changed, or no entry yet): new 56.\n\nNot cacheable (the test touched something the engine cannot prove): outcome 1.\n\nTest time: run under 0.1 min (0.3 s), skipped with proof under 0.1 min (0.0 s).\n\nEngine: detpy 0.1.0."
  }
}
```

Rendered summary:

> **CI / test** on fenvix · commit `c663f502f475` · cache cold (first run on this machine)
> 
> | | |
> |---|---|
> | Tests | **56** |
> | Tests run | 56 |
> | Skipped with proof | **0** ([receipts](https://github.com/acme/shop/actions/runs/31000#artifacts)) |
> | Minutes saved | **under 0.1 min (0.0 s)** (0.0% of test time) |
> | Failures | 0 |
> | Flaky, reproducible | 1 |
> 
> ### Flaky tests, explained
> 
> Each failed in the suite and passed when run alone: another test leaves state behind (order-dependent). The run is deterministic, so the replay fails the same way every time.
> 
> - `tests/test_cart.py::test_default_currency_is_eur`
>   - replay: `python -m pytest --det --det-urandom -p no:cacheprovider -q -rN --tb=short  # whole suite, same order: fails again`
>   - find the test that breaks it: `detpy repro tests/test_cart.py::test_default_currency_is_eur --seed fixed`
> 
> [Run on fenvix](https://app.fenvix.test/projects/d42b6bf6-603e-4ea9-9353-6ef7f06275e4/runs/e11de003-801b-4803-aa35-8d867b7b062d) · [Job log](https://github.com/acme/shop/actions/runs/31000/job/81000)

### `POST /repos/acme/shop/check-runs` → 201

```json
{
  "name": "fenvix",
  "head_sha": "4bec63ba31437dbe83826d4643ae63b6ad03fead",
  "status": "in_progress",
  "external_id": "81001",
  "started_at": "2026-11-18T10:00:05.000Z",
  "details_url": "https://github.com/acme/shop/actions/runs/31001/job/81001",
  "output": {
    "title": "Running on fenvix",
    "summary": "**CI / test** is running on a fenvix machine."
  }
}
```

Rendered summary:

> **CI / test** is running on a fenvix machine.

### `PATCH /repos/acme/shop/check-runs/1002` → 200

```json
{
  "name": "fenvix",
  "status": "completed",
  "conclusion": "failure",
  "completed_at": "2026-11-18T10:01:35.000Z",
  "external_id": "81001",
  "details_url": "https://app.fenvix.test/projects/d42b6bf6-603e-4ea9-9353-6ef7f06275e4/runs/cccc120b-a753-4ea2-ba71-1f7833d511a2",
  "output": {
    "title": "45 of 56 tests skipped with proof · under 0.1 min (0.2 s) saved · 1 failed",
    "summary": "**CI / test** on fenvix · commit `4bec63ba3143` · cache warm\n\n| | |\n|---|---|\n| Tests | **56** |\n| Tests run | 11 |\n| Skipped with proof | **45** ([receipts](https://github.com/acme/shop/actions/runs/31001#artifacts)) |\n| Minutes saved | **under 0.1 min (0.2 s)** (81.0% of test time) |\n| Failures | 1 |\n| Flaky, reproducible | 0 |\n\n### Failures\n\n- `tests/test_tax.py::test_vat[3]`\n\n[Run on fenvix](https://app.fenvix.test/projects/d42b6bf6-603e-4ea9-9353-6ef7f06275e4/runs/cccc120b-a753-4ea2-ba71-1f7833d511a2) · [Job log](https://github.com/acme/shop/actions/runs/31001/job/81001)",
    "text": "Why the other tests ran (an input changed, or no entry yet): code 10, new 1.\n\nNot cacheable (the test touched something the engine cannot prove): outcome 1.\n\nTest time: run under 0.1 min (0.1 s), skipped with proof under 0.1 min (0.2 s).\n\nEngine: detpy 0.1.0."
  }
}
```

Rendered summary:

> **CI / test** on fenvix · commit `4bec63ba3143` · cache warm
> 
> | | |
> |---|---|
> | Tests | **56** |
> | Tests run | 11 |
> | Skipped with proof | **45** ([receipts](https://github.com/acme/shop/actions/runs/31001#artifacts)) |
> | Minutes saved | **under 0.1 min (0.2 s)** (81.0% of test time) |
> | Failures | 1 |
> | Flaky, reproducible | 0 |
> 
> ### Failures
> 
> - `tests/test_tax.py::test_vat[3]`
> 
> [Run on fenvix](https://app.fenvix.test/projects/d42b6bf6-603e-4ea9-9353-6ef7f06275e4/runs/cccc120b-a753-4ea2-ba71-1f7833d511a2) · [Job log](https://github.com/acme/shop/actions/runs/31001/job/81001)

### `POST /repos/acme/shop/check-runs` → 201

```json
{
  "name": "fenvix",
  "head_sha": "e8206072cf839808186d220d829f342a5e080c88",
  "status": "in_progress",
  "external_id": "81002",
  "started_at": "2026-11-18T10:10:05.000Z",
  "details_url": "https://github.com/acme/shop/actions/runs/31002/job/81002",
  "output": {
    "title": "Running on fenvix",
    "summary": "**CI / test** is running on a fenvix machine."
  }
}
```

Rendered summary:

> **CI / test** is running on a fenvix machine.

### `PATCH /repos/acme/shop/check-runs/1004` → 200

```json
{
  "name": "fenvix",
  "status": "completed",
  "conclusion": "success",
  "completed_at": "2026-11-18T10:11:05.000Z",
  "external_id": "81002",
  "details_url": "https://app.fenvix.test/projects/d42b6bf6-603e-4ea9-9353-6ef7f06275e4/runs/af559f99-4129-416a-a07c-f3dbfb120a1a",
  "output": {
    "title": "46 of 56 tests skipped with proof · under 0.1 min (0.2 s) saved · no failures",
    "summary": "**CI / test** on fenvix · commit `e8206072cf83` · cache warm\n\n| | |\n|---|---|\n| Tests | **56** |\n| Tests run | 10 |\n| Skipped with proof | **46** ([receipts](https://github.com/acme/shop/actions/runs/31002#artifacts)) |\n| Minutes saved | **under 0.1 min (0.2 s)** (80.2% of test time) |\n| Failures | 0 |\n| Flaky, reproducible | 0 |\n\n[Run on fenvix](https://app.fenvix.test/projects/d42b6bf6-603e-4ea9-9353-6ef7f06275e4/runs/af559f99-4129-416a-a07c-f3dbfb120a1a) · [Job log](https://github.com/acme/shop/actions/runs/31002/job/81002)",
    "text": "Why the other tests ran (an input changed, or no entry yet): code 9, new 1.\n\nTest time: run under 0.1 min (0.1 s), skipped with proof under 0.1 min (0.2 s).\n\nEngine: detpy 0.1.0."
  }
}
```

Rendered summary:

> **CI / test** on fenvix · commit `e8206072cf83` · cache warm
> 
> | | |
> |---|---|
> | Tests | **56** |
> | Tests run | 10 |
> | Skipped with proof | **46** ([receipts](https://github.com/acme/shop/actions/runs/31002#artifacts)) |
> | Minutes saved | **under 0.1 min (0.2 s)** (80.2% of test time) |
> | Failures | 0 |
> | Flaky, reproducible | 0 |
> 
> [Run on fenvix](https://app.fenvix.test/projects/d42b6bf6-603e-4ea9-9353-6ef7f06275e4/runs/af559f99-4129-416a-a07c-f3dbfb120a1a) · [Job log](https://github.com/acme/shop/actions/runs/31002/job/81002)

## 3. The pull request comment (one comment, updated in place)

### `POST /repos/acme/shop/issues/2/comments` → 201

```json
{
  "body": "<!-- fenvix:run-summary -->\n### ❌ fenvix · 45 of 56 tests skipped with proof · under 0.1 min (0.2 s) saved · 1 failed\n\n| | |\n|---|---|\n| Tests | **56** |\n| Tests run | 11 |\n| Skipped with proof | **45** ([receipts](https://github.com/acme/shop/actions/runs/31001#artifacts)) |\n| Minutes saved | **under 0.1 min (0.2 s)** (81.0% of test time) |\n| Failures | 1 |\n| Flaky, reproducible | 0 |\n\n### Failures\n\n- `tests/test_tax.py::test_vat[3]`\n\n<sub>CI / test · commit `4bec63b` · [Check run](https://github.com/acme/shop/runs/1002) · [Run on fenvix](https://app.fenvix.test/projects/d42b6bf6-603e-4ea9-9353-6ef7f06275e4/runs/cccc120b-a753-4ea2-ba71-1f7833d511a2) · [Job log](https://github.com/acme/shop/actions/runs/31001/job/81001) · this comment is updated on every run</sub>"
}
```

Rendered:

> <!-- fenvix:run-summary -->
> ### ❌ fenvix · 45 of 56 tests skipped with proof · under 0.1 min (0.2 s) saved · 1 failed
> 
> | | |
> |---|---|
> | Tests | **56** |
> | Tests run | 11 |
> | Skipped with proof | **45** ([receipts](https://github.com/acme/shop/actions/runs/31001#artifacts)) |
> | Minutes saved | **under 0.1 min (0.2 s)** (81.0% of test time) |
> | Failures | 1 |
> | Flaky, reproducible | 0 |
> 
> ### Failures
> 
> - `tests/test_tax.py::test_vat[3]`
> 
> <sub>CI / test · commit `4bec63b` · [Check run](https://github.com/acme/shop/runs/1002) · [Run on fenvix](https://app.fenvix.test/projects/d42b6bf6-603e-4ea9-9353-6ef7f06275e4/runs/cccc120b-a753-4ea2-ba71-1f7833d511a2) · [Job log](https://github.com/acme/shop/actions/runs/31001/job/81001) · this comment is updated on every run</sub>

### `PATCH /repos/acme/shop/issues/comments/1003` → 200

```json
{
  "body": "<!-- fenvix:run-summary -->\n### ✅ fenvix · 46 of 56 tests skipped with proof · under 0.1 min (0.2 s) saved · no failures\n\n| | |\n|---|---|\n| Tests | **56** |\n| Tests run | 10 |\n| Skipped with proof | **46** ([receipts](https://github.com/acme/shop/actions/runs/31002#artifacts)) |\n| Minutes saved | **under 0.1 min (0.2 s)** (80.2% of test time) |\n| Failures | 0 |\n| Flaky, reproducible | 0 |\n\n<sub>CI / test · commit `e820607` · [Check run](https://github.com/acme/shop/runs/1004) · [Run on fenvix](https://app.fenvix.test/projects/d42b6bf6-603e-4ea9-9353-6ef7f06275e4/runs/af559f99-4129-416a-a07c-f3dbfb120a1a) · [Job log](https://github.com/acme/shop/actions/runs/31002/job/81002) · this comment is updated on every run</sub>"
}
```

Rendered:

> <!-- fenvix:run-summary -->
> ### ✅ fenvix · 46 of 56 tests skipped with proof · under 0.1 min (0.2 s) saved · no failures
> 
> | | |
> |---|---|
> | Tests | **56** |
> | Tests run | 10 |
> | Skipped with proof | **46** ([receipts](https://github.com/acme/shop/actions/runs/31002#artifacts)) |
> | Minutes saved | **under 0.1 min (0.2 s)** (80.2% of test time) |
> | Failures | 0 |
> | Flaky, reproducible | 0 |
> 
> <sub>CI / test · commit `e820607` · [Check run](https://github.com/acme/shop/runs/1004) · [Run on fenvix](https://app.fenvix.test/projects/d42b6bf6-603e-4ea9-9353-6ef7f06275e4/runs/af559f99-4129-416a-a07c-f3dbfb120a1a) · [Job log](https://github.com/acme/shop/actions/runs/31002/job/81002) · this comment is updated on every run</sub>

Dashboard links in these payloads point at https://app.fenvix.test (the test's dashboard URL).
