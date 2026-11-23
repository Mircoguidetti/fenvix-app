# Run summaries written by the runner

Real `summary.json` files written by `runner/fenvix-run` (fenvix-engine-cli, branch `claude/runner-prototype-ee21he`,
commit 03a8613) with the engine built from the same branch
(`maturin build --release`, detpy 0.1.0), on 2026-11-18 in the session container. Paths were rewritten to
`/home/fenvix/work`; nothing else was changed. `*.step-summary.md` is what the same runs wrote to `$GITHUB_STEP_SUMMARY`.

The project is a small synthetic one made for this (`acme/shop`): 56 tests, one order-dependent pair
(`tests/test_cart.py::test_switch_to_usd` leaves the currency set to USD, `test_default_currency_is_eur` then fails),
three commits on one machine with the cache kept between jobs:

| file | commit | what it shows |
|---|---|---|
| `job1-cold-flaky` | N, cold cache | 56 ran, 0 reused; 1 flaky test (fails in the suite, passes alone) with its replay command |
| `job2-warm-real-failure` | N+1 (`shop/tax.py` changed and broken for one input) | 45 of 56 reused with proof, 11 ran, 1 real failure |
| `job3-warm-pass` | N+2 (the fix) | 46 of 56 reused with proof, 10 ran, all pass |

## Node (`fenvix-run node`)

Real `summary.json` files written by `runner/fenvix-run node` (fenvix-engine-cli, branch `claude/node-runner`, commit
2026-11-23) with detjs built and installed by `runner/bootstrap.sh install` (detjs 0.1.0, Node v22.23.5), from the
engine's fixtures `tests/fixtures/runner-node/<runner>/`, on 2026-11-23 in the session container. Paths were rewritten
to `/home/fenvix/work` (project and cache) and `/home/fenvix/fenvix` (detjs); nothing else was changed.
`*.step-summary.md` is what the same runs wrote to `$GITHUB_STEP_SUMMARY` (for mocha, the verify step's).

| file | runner | what it shows |
|---|---|---|
| `node-vitest-warm` | vitest | second job on the same machine: 5 of 5 reused with proof |
| `node-jest-cold-0-reused` | jest | first job, cold cache: 0 reused, 5 ran |
| `node-node-test-failed` | node:test | `FENVIX_FIXTURE_FAIL=1` on a warm cache: 3 of 4 reused, `fail.test.js::fails on demand` failed (exit 1; re-run alone, failed again) |
| `node-mocha-verify-failed` | mocha | `FENVIX_FIXTURE_ENTROPY=1` (a test reads OS entropy): the run exits 0; `fenvix-run verify` exits 1 and wrote `verify_status: diverged`, `verify_exit: 1` into the summary |
