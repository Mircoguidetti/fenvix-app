## fenvix · acme/shop @ job1: tests with proof

Commit `843feccc0421` · cache cold (first job on this machine) · machine `vm`

| | |
|---|---|
| Tests | **56** |
| Run | 56 |
| Skipped with proof (result reused, receipt kept) | **0** |
| Test time saved | **0.0 s** (0.0% of test time) |
| Test time spent | 0.0 s |
| Failures | 0 |
| Flaky (fail in the suite, pass alone) | 1 |
| Job wall time (pytest) | 6.0 s |

Outcomes: failed 1, passed 55.

Receipts: one line per test (what was checked before a result was reused, or why a test ran): `/home/fenvix/work/job1/receipts.jsonl`.

### Flaky tests (reproducible: the run is deterministic)

- `tests/test_cart.py::test_default_currency_is_eur`
  - replay: `python -m pytest --det --det-urandom -p no:cacheprovider -q -rN --tb=short  # whole suite, same order: fails again`
  - minimise: `detpy repro tests/test_cart.py::test_default_currency_is_eur --seed fixed`

<details><summary>Why the other tests ran</summary>

Not reused (an input changed or no entry yet): new 56.

Not cacheable (the test touched something the engine cannot prove): reads /proc, /sys or /dev 54, outcome 1.

</details>
## fenvix · acme/shop @ job1: tests with proof

Commit `c663f502f475` · cache cold (first job on this machine) · machine `vm`

| | |
|---|---|
| Tests | **56** |
| Run | 56 |
| Skipped with proof (result reused, receipt kept) | **0** |
| Test time saved | **0.0 s** (0.0% of test time) |
| Test time spent | 0.3 s |
| Failures | 0 |
| Flaky (fail in the suite, pass alone) | 1 |
| Job wall time (pytest) | 1.7 s |

Outcomes: failed 1, passed 55.

Receipts: one line per test (what was checked before a result was reused, or why a test ran): `/home/fenvix/work/job1/receipts.jsonl`.

### Flaky tests (reproducible: the run is deterministic)

- `tests/test_cart.py::test_default_currency_is_eur`
  - replay: `python -m pytest --det --det-urandom -p no:cacheprovider -q -rN --tb=short  # whole suite, same order: fails again`
  - minimise: `detpy repro tests/test_cart.py::test_default_currency_is_eur --seed fixed`

<details><summary>Why the other tests ran</summary>

Not reused (an input changed or no entry yet): new 56.

Not cacheable (the test touched something the engine cannot prove): outcome 1.

</details>
