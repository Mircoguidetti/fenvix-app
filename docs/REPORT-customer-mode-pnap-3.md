DONE

# Report 3: customer mode on phoenixNAP, the fix for review R-014b

Branch `claude/customer-mode-pnap`, on top of `854aa44`. The review is `docs/REVIEW-R-014b.md` on branch
`claude/review-r014b` (verdict FIX 1). This change closes the branch without a third review, so it is kept small:
one SQL query in the scaler, one comment in the host code (and the regenerated host bundle), and three doc sentences.

## N1 → fix → tests before/after

**N1 (Medium, cost, a regression of the R5 fix).** A queued job whose installation is now in a region with no hosts,
or which was placed by `PNAP_DEFAULT_REGION` after that default was removed, can be neither leased (hosts.ts refuses
it) nor moved (step 2b moves only to a served region). Step 4 of `runScaler` still counted it as demand of its old
region: the scaler ordered a job host there, and kept an idle one, until GitHub gave up on the job after 24 hours.

**Fix** (`github-app/src/pnap/scaler.ts`, step 4). Demand now counts only the jobs a host of that region may lease,
with the same check as the lease query in `hosts.ts`:

```sql
select j.region, count(*)::int as n
  from pnap_jobs j left join gh_installations i on i.installation_id = j.installation_id
 where j.state = 'leased'
    or (j.state = 'queued' and i.installation_id is not null and coalesce(i.pnap_region, $1::text) = j.region)
 group by j.region
```

`$1` is `s.defaultRegion` (null when unset). `i.installation_id is not null` mirrors the lease's inner join, so a queued
job without an installation row (which no host would lease) does not count either. Leased jobs always count: they hold
a slot on a real host.

**R5 is not weakened.** Only the scaler's demand count changed. The lease query in `hosts.ts`, the move in step 2b
(only to a served region) and placement are untouched: no job ever leaves its region, and a stranded job stays
`queued` in its own region until a host there may lease it (its customer returns to that region, or the region
becomes served and step 2b moves it) or GitHub cancels it. The review's second suggestion (cancel stranded jobs in
step 2b) was not done: it changes job states and is not needed to stop the cost leak.

**Tests.** The reviewer's three N1 tests (`github-app/tests/integration/review-r014b.test.ts`) were copied unchanged
(byte-identical to `origin/claude/review-r014b`).

| | before the fix (`854aa44` + the test file) | after the fix |
|---|---|---|
| 1. customer moved to SEA (no hosts), job queued in ASH | **fail**: `[{"kind":"order","region":"ASH",…,"result":"ordered a242ad…"}]` | pass |
| 2. `PNAP_DEFAULT_REGION` removed after placement | **fail**: `[{"kind":"order","region":"ASH",…,"result":"ordered 5f5c33…"}]` | pass |
| 3. idle ASH host, 55 min into its paid hour, only a stranded job | **fail**: no actions (the host is kept) | pass (drained) |
| file total | **0/3** | **3/3** |

## All suites (this container, 2026-11-18, after the fix)

| Suite | Result |
|---|---|
| `github-app` typecheck | ok |
| `github-app` unit | **82/82** |
| `github-app` integration (scratch Postgres 16, `scripts/prepare-test-db.sh`) | **91/91** (88 earlier + the 3 N1 tests) |
| `infra/github-app` `npm test` (cdk-nag in both modes, pnap included) | **61/61**, 0 skipped; the cdk-nag tests ran ("every cdk-nag rule ran", "nothing left unsuppressed") |
| `infra/customer-mode/pnap` as **root** (`python3 -I -m unittest discover -s tests`; conntrack, shellcheck, iproute2, nft installed; `fenvix-parse`, `fenvix-post`, `fenvix-cache` created as `install-host.sh` does) | **71/71**, none skipped |
| `bundle.py --check` | up to date (regenerated for the `config.py` comment) |

## The review's Low notes

Fixed (one-line, safe; no behaviour change):
- **Note 4 (R10 sentence).** `fenvix_host/config.py` no longer promises headroom: it now says the cap keeps one job to
  about 1/4 of the drive, and that 15 busy microVMs can still saturate it. Host bundle regenerated.
- **Note 5 (kept silent host counts as capacity).** The guide's scaler summary (`docs/CUSTOMER-MODE-PNAP.md`) now says
  that a kept silent busy host counts as capacity meanwhile, so a region at max orders no replacement. The same
  summary now says the demand is *leasable* queued+leased (N1).
- **Note 2 (claim too broad).** The guide's real-host check 11 now says the caches (`/var/lib/fenvix-cache` and the
  dedicated cache server's disk) are not on dm-crypt, and that phoenixNAP's disk wipe on deprovision must be confirmed
  before the first customer. The over-broad sentence in `REPORT-customer-mode-pnap-2.md` is left as written (it is a
  record of that round); this report corrects it.

Not fixed (more than a one-line change, or not testable here):
- **Note 1 (`ensure_host_table` never turns forwarding back on).** A full fix needs a flag: after a failed reload
  has written `ip_forward=0`, the next round that finds the table (reloaded, or back on its own) must re-apply
  `netplan.HOST_SYSCTLS` before leasing. The review's suggestion (re-apply after a successful reload only) misses
  the "table back on its own" path. Unlikely trigger (a failed reload followed by a good one); to do before scale-up.
- **Note 3 (R7 "busy" is the last `running` report).** Needs a change to the busy rule (count a job leased in the
  last minute as busy). Narrow window, one-host fleets only.
- **Note 6 (real-host checks).** `fenvix-data-disk` on a real NVMe drive; `nosmt`, tmpfiles and `update-grub` on
  phoenixNAP's image; Firecracker v1.18 accepting the `serial` section and dropping under a flood; the
  `cgroup.events` wait under `--new-pid-ns`; the user data size (about 54 KB raw, 72 KB base64) against phoenixNAP's
  unknown limit. All stay on the guide's real-host list (items 7 to 14) for the first real order.
- **Review suggestion: cancel stranded jobs in step 2b** (visibility). Not needed for the cost fix; left out to
  keep the change small.
