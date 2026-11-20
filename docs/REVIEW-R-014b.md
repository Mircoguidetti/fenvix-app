FIX 1

# Review R-014b: customer mode on phoenixNAP, the fixes for R-014 (last round)

Reviewed: branch `claude/customer-mode-pnap` at `854aa44` ("fix review R-014 (R1-R11)"), against
`docs/REPORT-customer-mode-pnap-2.md` and the round-1 review `docs/REVIEW-R-014.md` (branch `claude/review-r014`).
This review is on branch `claude/review-r014b`.

Threat model, as before: every job runs hostile customer code, two customers share one host, and the control plane
can fail. Nothing was ordered at phoenixNAP, and this container has no `/dev/kvm` and no device-mapper.

**Verdict: FIX 1.**
- All 11 round-1 fixes are real. None of them only satisfies my round-1 test (details below).
- One new **Medium** defect came in with the R5 fix (N1, a cost leak in the scaler). It has three failing tests on
  this branch.
- Everything else I found is Low, or cannot be tested here. Those items are listed as notes and are not counted.

## What I ran (this container, 2026-11-18)

| Suite | Result |
|---|---|
| `github-app`: typecheck, unit, integration (scratch Postgres 16, `scripts/prepare-test-db.sh`) | typecheck ok; **unit 82/82**; integration **88/88** at `854aa44`, and **88/91** with this branch's new file (the 3 N1 tests fail, by design) |
| `infra/github-app`: `npm test` (templates, cdk-nag in both modes, pnap included) | **61/61**. The cdk-nag tests ran ("every cdk-nag rule ran", "nothing left unsuppressed") |
| `infra/customer-mode/pnap` as **root** (conntrack, shellcheck, iproute2, nft; the three production accounts created as `install-host.sh` step 3 does) | **71/71**, none skipped. That includes `ProductionUsers` (`runuser -u fenvix-parse/-post`, the cache as `fenvix-cache`) |
| the same suite as **`fenvix-parse`**, **`fenvix-post`** and **`fenvix-cache`** (real system accounts, `runuser`, each in its own copy of the tree with the node modules it needs) | **49 pass, 22 skipped, 0 fail** for each account. All 22 skips need root (namespaces, jail-uid files, uid switches), and each of them ran in the root run |
| `bundle.py --check` | up to date |
| `shellcheck` on `install-host.sh`, `fenvix-data-disk`, `first-test.sh` and `install-cache.sh` | clean |
| `cryptsetup 2.7.0`: the exact `open --type plain …` line of `fenvix-data-disk` | it parses. It only warns that `--keyfile-size` is redundant: 64 bytes are read anyway, and with a key file plain mode applies no hash. It could not be opened here, because the container has no `dm_mod` |
| Firecracker v1.18.0 API description (`tests/fixtures/firecracker-v1.18.0.yaml`) | `SerialDevice.rate_limiter` exists: *"writes … that exceed the configured rate are silently dropped"*. `Drive.rate_limiter` exists too. The R1 and R10 configurations are therefore real Firecracker features, not just a validator change |

## The 11 fixes: real or test-shaped?

| # | Verdict | What I checked beyond the round-1 test |
|---|---|---|
| R1 serial console | **Real** | Three layers. (1) Firecracker drops console output beyond 4 KiB/s after a 64 KiB burst (a v1.18 feature, see above). (2) The jailer runs with stdin `/dev/null` and its stdout and stderr in one pipe, drained by a thread into a 64 KiB tail, so the Firecracker log is bounded too. (3) `run_job` now waits for the pipe's end of file **and** for `cgroup.events` to read `populated 0`, not for the jailer, which exits at once under `--new-pid-ns`. On the time limit it writes `cgroup.kill`. The agent leaf has `memory.max` set to 2 GiB. A unit-level `MemoryMax=` would also cap the microVMs, so the leaf is the right place. Measured as root: 256 MiB of console output grows the agent by 0.5 MiB |
| R2 SMT | **Real** | SMT is turned off at every boot in two independent ways, plus at runtime during the install. The tmpfiles `w- …/smt/control off` line runs in `sysinit`, before the agent. `nosmt` goes into `/etc/default/grub.d/90-…` (it sorts after the cloud image's `50-…`). The install fails unless `smt/active = 0`, KSM is 0 and there is no swap. `check_host_hygiene()` is the first call of `run_forever()`, the only production entry (`fenvix-host agent`), so it runs on every agent start, including after a reboot of an enrolled host. A host that fails the check never enrols, is never seen by the App, and is released after 90 minutes. `slotsFor` counts cores, and `PNAP_SLOTS_PER_HOST` can no longer raise the count |
| R3 permissions | **Real** | The suite ran as each production account (above). The new `ProductionUsers` test does not use the round-1 shortcut `post_uid=65534`: it extracts the bundle with the user data's own lines read from `userdata.ts`, runs `run_job` with the default `Users()`, and starts the cache as `fenvix-cache`. The author also found and fixed a fourth instance: `post_uid` defaulted to `None`. `fenvix-cache.service` gets `/var/lib/fenvix-cache` from `StateDirectory=`. Nothing secret became readable: `/etc/fenvix` is 0711, but `enrol` is 0400 and `control-url`, `host.json` and `data-disk` are 0600. `/run/fenvix` is 0711, but every `staging-*` is 0700 root and every `post-*` is 0700 `fenvix-post` |
| R4 stale jails and dm-crypt | **Real** (dm-crypt not runnable here) | There are two sweeps. `sweep_stale()` runs in `prepare_host()` before the first lease and covers jail-uid processes, every jail, staging and post directory, every `vms/*` cgroup, and every `fxvm*` namespace with its conntrack entries. `run_job` also sweeps its own slot before it starts. Its `fxs<N>-j` prefix keeps the hyphen, so slot 1 never touches slot 10. On dm-crypt: the key is 64 bytes read from `/dev/urandom` straight into the kernel, never stored, plain mode with no header, and XFS is made again at every boot. The drive is recorded by its `/dev/disk/by-id` name, so a reboot that swaps `nvme0n1` and `nvme1n1` still opens the right drive. Even if it opened the wrong one, the kernel refuses an exclusive dm claim on a disk whose partitions are mounted, so the unit fails and the agent (`Requires=`) does not start. Root-filesystem fallback: the jails are deleted at boot. See note 2 for what dm-crypt does **not** cover |
| R5 residency | **Real, with a regression (N1)** | The lease joins `gh_installations` and takes only jobs whose `coalesce(pnap_region, default)` is the host's region (`for update of j skip locked`). A job requeued after a host loss is checked again. The scaler's move (step 2b) cannot race the lease: a row the lease locked and changed to `leased` no longer matches `state = 'queued'`. No job can leave its region: placement, lease, mint, the dedicated cache IP and the colocated cache are all bound to the host's region. **But** a job that can be neither moved nor leased still counts as demand: see N1 |
| R6 cost leak | **Real** | Regions with hosts are planned with min = max = 0 when they are not configured, and holds are capped at max (0). The orphan sweep lists every `PNAP_LOCATIONS`, and a failed listing only skips that location. The cache release in `act` is guarded in SQL (`role = 'cache' and state in (…)`) |
| R7 busy hosts | **Real; the cost bound holds** | (1) Every silent host is released at the latest when `quiet ≥ jobTimeoutMinutes + 15` (375 min), in both the mass branch and the single-host branch. `quiet` counts from `last_seen_at`, and only a lease that passed the credential and state check updates that (a `releasing` host gets 403 before the update). (2) A real single-host failure is released at once when the host is idle or not `powered-on`, and within 375 min when it is busy and still powered on, as a hung kernel would be. That is at most about $8 per host, as the report says. (3) A draining host is still bounded by `drain_requested_at + 375`. (4) A busy host is never released while two or more hosts are silent and that is half the fleet or more. See note 3 for the window the `running` count leaves |
| R8 release path | **Real** | `try_invoke` never exits. `retry_invoke` tries 6 times with pauses of 5 s doubling to 160 s. The release is asked for again until it goes through. One loop round can take up to about 16 minutes of retries, so the 20-minute bound can overrun to about 36 minutes. That still fits the stated maximum of 3 started hours (90 + 40 + 36 < 180 min) |
| R9 stated maximum | **Real** | The guide and the script's prompt both say "at most about $3.90". 4 started hours for a killed laptop at `--minutes 180` is about $5.20 |
| R10 I/O limit | **Real** (see note 4 for a wrong sentence) | Every drive has a `rate_limiter` (bandwidth and ops) and validates against v1.18 |
| R11 private `probe.sh` | **Real** | The workflow carries `probe.sh` as a heredoc, checked against its SHA-256. The test parses the printed YAML and runs the step |
| Note (a) per-namespace conntrack | Done | `vm_ruleset` has its own `ct count` drop. Real packets, root run |
| Note (b) table re-check | Done, with a defect | See note 1 |

## New finding

| # | Sev | Area | Defect | Failing test |
|---|---|---|---|---|
| N1 | Medium | scaler, cost (R5 regression) | A queued job that no host may lease any more still counts as its old region's demand: the scaler orders job hosts for it, and keeps idle ones up, until GitHub gives up on the job (24 h) | `github-app/tests/integration/review-r014b.test.ts`: **0/3** at `854aa44` |

### N1. Jobs stranded by the R5 lease check still order and keep job hosts (Medium, cost)

Since the R5 fix, a queued job is in one of three cases:
- **leasable:** its installation's current region is the job's region;
- **moved:** the new region is served (`max > 0`), and the scaler's step 2b re-queues the job there;
- **stranded:** the new region is **not** served, or the installation has no region of its own and
  `PNAP_DEFAULT_REGION` was removed or changed.

A stranded job stays `queued` in its old region, and `hosts.ts` refuses it there, which is correct for residency. But
step 4 of `runScaler` still counts it, unchanged since `b7686fd`:

```sql
select region, count(*)::int as n from pnap_jobs where state in ('queued', 'leased') group by region
```

The old region therefore keeps a demand of `ceil(stranded / slots)` hosts, up to its `max`:
- **No host in the old region:** the scaler orders one, at $1.27 per started hour, and no job will ever lease it.
- **An idle host there** (`min = 0`): it is never drained. `desired = 1 = live`, so `planRegion` takes the "keep"
  branch.
- **How long:** until GitHub fails the queued job, after 24 hours, and the `workflow_job completed` webhook cancels it
  in `placement.finished`.

**Cost.** Per occurrence, up to `max` hosts × 24 h: for example ASH `max = 3` gives 3 × 24 × $1.27 ≈ **$91**. The
stranded jobs are those already queued when the change is made. A busy customer can have dozens queued, and
`ceil(n / 15)` hosts are kept for them.

**Both triggers are ordinary operations:**
- the founder runs `set-region` for a European customer before NLD is in `PNAP_REGIONS`;
- the founder drops `PNAP_DEFAULT_REGION` (the round-1 review recommended making installations without a region
  wait).

The author's own test, "R5: a job whose installation now has a region no host serves is neither leased nor moved"
(`pnap-r014-fixes.test.ts`), reaches exactly this state and passes. It never looks at `r.actions`, which on this branch
contain an ASH order.

**Tests** (this branch, `github-app/tests/integration/review-r014b.test.ts`). On `854aa44`, all three fail:
1. A customer is moved to SEA (not configured) with a job queued in ASH. The scaler orders an ASH host:
   `[{"kind":"order","region":"ASH",…,"result":"ordered …"}]`.
2. `PNAP_DEFAULT_REGION` is removed after a job was placed in ASH by default. A ready ASH host leases nothing, and the
   scaler still orders an ASH host.
3. An idle ASH host is 55 minutes into its paid hour, and the only queued job is stranded. The host is not drained (no
   actions). With the stranded job cancelled first, the same test passes: the host is drained. That check was run
   here and not kept.

**Fix.**
- Count as demand only the jobs a host of that region may lease. For example:

  ```sql
  select j.region, count(*)::int as n
    from pnap_jobs j left join gh_installations i using (installation_id)
   where j.state = 'leased'
      or (j.state = 'queued' and coalesce(i.pnap_region, $1::text) = j.region)
   group by j.region
  ```

  With that change, the three N1 tests, the reviewer's R-014 tests and the author's pnap tests pass: 23/23 here. The
  change was not kept.
- Better still, close stranded jobs in step 2b: mark them `cancelled` ("the customer's region has no hosts"), so
  that they are visible too.

## Notes (not counted: Low, or not testable here)

1. **`ensure_host_table` never turns forwarding back on** (Low). When the reload of `inet fenvix` fails, the agent
   writes `net.ipv4.ip_forward=0` and stops leasing, as intended. On a later round, `nft list table` succeeds, either
   because a reload worked or because the table is back. The method then returns `True` and leasing resumes, but
   nothing writes `ip_forward=1` again (only `prepare_host` sets `HOST_SYSCTLS`, at agent start). Every job leased
   from then on boots with no route to GitHub. It keeps its slot until the job limit, while the host heartbeats as
   healthy, so the scaler never replaces it. The trigger needs a failed reload followed by a successful one (for
   example during a package upgrade of `nftables`/`libnftables`), so it is unlikely. **Fix:** in the success path,
   after a reload, re-apply `netplan.HOST_SYSCTLS`.
2. **dm-crypt does not cover the colocated cache** (claim too broad). The report says *"A reboot or a release
   therefore leaves only ciphertext. That also covers the review's note 3."* But `fenvix-cache.service` keeps every
   customer organization's cache in `/var/lib/fenvix-cache` on the **root** filesystem, unencrypted. The same holds
   for the dedicated cache server's disk. Round-1 note 3 (phoenixNAP's wipe on deprovision) therefore still applies
   to cache contents. Either put the cache on the dm-crypt volume (losing it at reboot), or keep it and confirm
   phoenixNAP's wipe policy before the first customer.
3. **R7: "busy" is the host's last `running` report** (narrow window). A lease call that reported `running: []` and
   received jobs leaves `running = 0` in the database until the next call, 5 s later. In a one-host fleet (`silent ≥ 2`
   is needed for the mass rule), a hosts-route outage that starts inside that window gets the busy host released after
   5 minutes. Counting `leased > 0` as busy when the job was leased in the last minute or so would close it.
4. **R10 sentence:** `config.py` says *"15 microVMs at their limit stay below it"*. The arithmetic is 15 × 2 busy
   drives (rootfs, scratch) × 200 MiB/s ≈ 5.9 GiB/s, and up to 11.7 GiB/s with all four drives, which is at or above
   one NVMe drive. The per-job cap (about 1/4 of the drive per job) is what R10 asked for. The sentence should say so
   rather than promise headroom.
5. **Capacity while a silent busy host is kept** (R7 trade-off, by design). A kept host counts as live capacity for up
   to 375 minutes. In a region already at `max`, no replacement is ordered for that time. This follows the round-1
   suggestion. Worth stating in the guide's behaviour section next to the $8 figure.
6. **Not testable here, still on the guide's real-host list (items 7 to 14):** `fenvix-data-disk` on a real NVMe
   drive; `nosmt`, tmpfiles and `update-grub` on phoenixNAP's image; Firecracker v1.18 accepting the `serial` section
   and its drop behaviour under a flood; the `cgroup.events` wait under `--new-pid-ns`. The user data is now about
   54 KB raw and 72 KB base64-encoded, and phoenixNAP's limit is unknown: check it in the first real order.

## Run the new tests

```
cd github-app && TEST_DATABASE_URL=postgresql://postgres@localhost:54329/gh_test bash scripts/prepare-test-db.sh
cd github-app && TEST_DATABASE_URL=postgresql://postgres@localhost:54329/gh_test \
  node --test --test-concurrency=1 tests/integration/review-r014b.test.ts      # 0/3 at 854aa44
```

`github-app`'s `npm test` includes the new file, so it fails until N1 is fixed. That is intended.
