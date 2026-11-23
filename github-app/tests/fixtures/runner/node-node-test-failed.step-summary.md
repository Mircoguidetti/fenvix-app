## fenvix · node:test: tests with proof

Commit `` · cache warm · machine `vm`

| | |
|---|---|
| Tests | **4** |
| Run | 1 |
| Skipped with proof (result reused, receipt kept) | **3** |
| Test time saved | **0.0 s** (57.8% of test time) |
| Test time spent | 0.0 s |
| Failures | 1 |
| Flaky (fail in the suite, pass alone) | 0 |
| Job wall time (detjs node:test) | 0.4 s |

Outcomes: failed 1, passed 3.

Receipts: one line per test (what was checked before a result was reused, or why a test ran): `/home/fenvix/work/out/nt-fail/receipts.jsonl`.

### Failures

- `fail.test.js::fails on demand`

<details><summary>Why the other tests ran</summary>

Not reused (an input changed or no entry yet): env 1.

Not cacheable (the test touched something the engine cannot prove): outcome-failed 2.

</details>
