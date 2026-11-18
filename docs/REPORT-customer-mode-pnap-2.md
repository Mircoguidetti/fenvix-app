DONE

# Report 2: customer mode on phoenixNAP, the fixes for review R-014

Branch `claude/customer-mode-pnap`, on top of `b7686fd`. Review: `docs/REVIEW-R-014.md` on `claude/review-r014`
(verdict FIX 11). The reviewer's four test files were copied onto this branch **unchanged**:
- `github-app/tests/unit/review-r014.test.ts`
- `github-app/tests/integration/review-r014.test.ts`
- `infra/customer-mode/pnap/tests/test_review_r014.py`
- `infra/customer-mode/pnap/tests/review_r014_scenario.py`

`git diff origin/claude/review-r014 -- <these four>` is empty.

Threat model, as in the review: every job runs hostile customer code, and two customers share one host. Nothing was
ordered at phoenixNAP (no account), and this container has no `/dev/kvm`.

**Result: all 11 findings fixed.** Each of the reviewer's 14 tests failed before its fix and passes after it. All
suites pass. That includes the host-side suite run as root, and also run as each of the three production non-root
accounts.

## Findings: fix and test before/after

"Before" is `b7686fd` plus the reviewer's tests (run here, 2026-11-18). "After" is this branch.

| # | Sev | Defect | Fix | Reviewer's test: before → after |
|---|---|---|---|---|
| R1 | High | Guest serial console unbounded into the root agent's memory | Serial rate limiter in the Firecracker config; VMM output drained into a 64 KiB tail; agent waits on the microVM, not the jailer; memory cap on the agent's cgroup leaf | `test_r1_…serial_console…`: **FAIL** (256 MiB of console output grew the agent by **512.5 MiB**) → **PASS** (**0.5 MiB**) |
| R2 | High | SMT on: two tenants per physical core; slots counted in hardware threads | SMT off on every host (now, at each boot, on the kernel command line); KSM off, no swap; the agent refuses to enrol otherwise; slots counted in cores: **15** per d3.c1.large | `R2 SMT` (unit): **FAIL** (28 slots) → **PASS** (15). `test_r2_the_host_install_turns_smt_off`: **FAIL** → **PASS** |
| R3 | High | Service users cannot read their programs or files: no summary, no colocated cache | 0755 directory entries in the bundle, `chmod -R a+rX,go-w`; `/etc/fenvix` 0711, key 0644; `/run/fenvix` 0711; credential file owned by `fenvix-post` by default | `test_r3_…bundle…`: **FAIL** (Permission denied) → **PASS**. `test_r3_summaries_are_posted…`: **FAIL** (no summary) → **PASS**. `R3 permissions` (unit): **FAIL** (`/etc/fenvix` 0700) → **PASS** (0711) |
| R4 | Medium | Jail of an interrupted job stays on the data disk | Each slot sweeps every jail of that slot before use; the agent sweeps all jails, cgroups, namespaces and jail-uid processes at start; data disk on dm-crypt with a per-boot key | `test_r4_a_jail_left_…`: **FAIL** (`fxs3-j111` left) → **PASS** |
| R5 | Medium | Region fixed at placement: an ASH host ran a job of an installation now in NLD | Lease takes only jobs whose installation's current region (or the default) is the host's region; the scaler moves queued jobs to the new region | `R5 residency` (integration): **FAIL** (ASH host leased 951) → **PASS** |
| R6 | Medium | Hosts of a region removed from `pnapRegions` never released | Every region that still has hosts is planned (min = max = 0 when unconfigured); orphans looked for in every location; an unserved region's cache server is released | `R6 cost`: **FAIL** (host stays `ready`) → **PASS** |
| R7 | Medium | Control-plane outage releases every busy host | Mass silence (≥ 2 hosts and ≥ half the fleet) releases nothing and raises an ALERT; one silent host that reported running jobs and is powered on waits up to the job limit + 15 min | `R7 busy hosts`: **FAIL** (servers released) → **PASS** (both `powered-on`) |
| R8 | Low | One failed call inside `release()` ends the release (`die` in the EXIT trap) | Release path uses a non-exiting call with retries and growing pauses; release asked again until it goes through; 20-minute bound; loud final warning | `test_r8_…`: **FAIL** (host left `ready`) → **PASS** (`released`) |
| R9 | Low | "At most ≈ $2.60" is wrong | The guide and the script's prompt state the maximum from the deadlines: **≈ $3.90** (3 started hours), and ≈ $5.20 for a killed laptop at `--minutes 180` | `test_r9_…`: **FAIL** (2.60 < 3.81) → **PASS** (3.90) |
| R10 | Low | No I/O limit per microVM | Firecracker `rate_limiter` on all four drives: 200 MiB/s and 10,000 ops/s each | `test_r10_…`: **FAIL** (no limiter) → **PASS** |
| R11 | Medium | Test workflow downloads `probe.sh` from the private repository (404) | `--print-workflow` puts `probe.sh` into the workflow as a heredoc, with the SHA-256 kept as a self-check | `test_r11_…`: **FAIL** → **PASS** |

Totals for the reviewer's tests:
- before: unit 0/2, integration 0/3, Python 0/9;
- after: 2/2, 3/3, 9/9.

## What each fix changed

### R1: the serial console (High)

- **`vm.py`:** the configuration has `"serial": {"rate_limiter": {size 4096, one_time_burst 65536, refill_time 1000}}`.
  - That is 4 KiB/s after a 64 KiB boot burst. Firecracker drops the rest.
  - There is no `serial_out_path`, so the guest has no file to fill.
- **`job.py`, `Shell.vm`:**
  - The jailer runs with stdin `/dev/null`. stdout and stderr go to one pipe, drained by a thread into a `Tail` that
    keeps the last 64 KiB. The jailer's output is never captured whole.
  - It then waits for two signals:
    - end of file on that pipe (Firecracker holds it until it exits);
    - the microVM's cgroup emptied (`cgroup.events` reads `populated 0`).

    This handles the review's caution: under `--new-pid-ns` the jailer exits as soon as it has cloned Firecracker.
  - On the time limit it writes `cgroup.kill`, kills the jailer, and cleanup then runs `pkill -u` on the jail uid.
  - `returncode` is still the jailer's. The result disk is the guest's word.
- **`agent.prepare_cgroups`:** `memory.max` = 2 GiB on the agent's own leaf. A `MemoryMax=` on the unit would also cap
  the microVMs, because they run in the same delegated subtree.
- **New tests in `tests/test_hardening.py`:**
  - the tail is bounded;
  - the agent waits for the microVM after the jailer exits (0.8 s later, not at once);
  - the time limit kills through `cgroup.kill`;
  - a flood after the jailer exits stays bounded;
  - the configuration carries the serial and drive limiters;
  - the agent leaf gets `memory.max`.
- The configuration still validates against v1.18.0's API description: `validate-fc-config.mjs` now knows
  `serial: SerialDevice`.

### R2: SMT (High)

- **`install-host.sh` step 4b:**
  - `echo off > /sys/devices/system/cpu/smt/control`, kept at every boot by `/etc/tmpfiles.d/fenvix-host.conf`, and
    `nosmt` on the kernel command line (`/etc/default/grub.d`, `update-grub`).
  - KSM: unmerge every shared page (write 2), then 0.
  - `swapoff -a`, swap lines commented out of fstab, `swap.target` masked.
  - The step checks `smt/active` = 0, KSM 0 and no swap, and fails the install otherwise.
  - It logs the CPU vulnerability lines into the install log.
- **`agent.check_host_hygiene`** runs before enrolment and refuses a host with SMT, KSM or swap on (tested).
- **`settings.ts`:**
  - `slotsFor` = min((cores − 2) / vCPUs, (memory − 16 GiB) / (guest + 512 MiB)). For a d3.c1.large that is
    min(15, 28) = **15**.
  - An explicit `PNAP_SLOTS_PER_HOST` may lower that number, never raise it.
- The author's tests that encoded 28 slots (`tests/unit/pnap.test.ts`, `tests/integration/pnap.test.ts`) now assert
  15, plus the cap on `PNAP_SLOTS_PER_HOST`.
- **Capacity and cost** (`docs/CUSTOMER-MODE-PNAP.md`, prices unchanged, DECLARED 2026-11-18):

  | Job hosts | Jobs at once (was) | Hourly, all month | 12-month reservation |
  |---|---|---|---|
  | 1 | **15** (28) | $948.67 | $458.16 |
  | 5 | **75** (140) | $4,743.35 | $2,290.80 |
  | 10 | **150** (280) | $9,486.70 | $4,581.60 |

  - **Per job slot, all month: $63.24 hourly (was $33.88), $30.54 reserved (was $16.36).**
  - The old 28 / 140 / 280 jobs at once now take 2 / 10 / 19 hosts:
    - hourly: $1,897.34 / $9,486.70 / $18,024.73;
    - reserved: $916.32 / $4,581.60 / $8,705.04.
  - The break-even of reservation against hourly is unchanged: 344 h a month per host.
  - Core scheduling (`PR_SCHED_CORE`) could keep SMT on and about 28 slots. It is noted in the guide and not built.

### R3: permissions (High)

- **`bundle.py`:** the archive carries every directory as a 0755 entry. GNU tar, extracting as root, keeps the mode.
- **User data:**
  - `install -d -m 0711 /etc/fenvix` (and `/var/lib/fenvix` stays 0700);
  - `chmod -R a+rX,go-w /opt/fenvix-host`.
- **`agent.write_public_key`:** `/etc/fenvix` gets o+x, `cache/` 0755 and the key 0644 (`fchmod`), whatever the
  agent's `UMask=0077`.
- **`/run/fenvix`:**
  - The unit sets `RuntimeDirectoryMode=0711`, and `run_job` sets 0711 on the staging base too.
  - Each `staging-*` stays 0700 root. Each `post-*` is 0700 and owned by `fenvix-post`.
- **A defect the reviewer's test could not see**, found by running the production code path as the real accounts:
  - `Users()` defaulted to `post_uid=None`, so in production the credential file stayed root's 0400, and `fenvix-post`
    could never read it. The reviewer's test passes `post_uid=65534` explicitly, so it did not show this.
  - Now `post_uid` defaults to the uid of `fenvix-post`.
- **New test `test_hardening.ProductionUsers`** (with `tests/production_users_scenario.py`):
  - It extracts the bundle with the user data's own lines, read from `userdata.ts`.
  - It creates the runtime directory 0700 as systemd does.
  - It runs `run_job` with the default `Users()`, that is `runuser -u fenvix-parse` and `runuser -u fenvix-post`.
  - It starts `fenvix_cache_auth.py serve` as `fenvix-cache` with the key the agent wrote under umask 077.
  - Before: the job ended `no-summary`. After: the summary is posted with the job's own credential, and the cache
    starts and answers 401 without a token.

### R4: stale jails (Medium)

- **`run_job`'s first cleanup** removes every `fxs<slot>-j*` jail, staging directory, post directory and cgroup of its
  slot. The pattern keeps the hyphen, so slot 1 never matches slot 10.
- **`agent.sweep_stale`** runs in `prepare_host` before anything else, so before the first lease. It:
  - kills every jail uid;
  - removes every jail, staging and post directory and every `vms/*` cgroup;
  - tears down every `fxvm*` namespace with its conntrack entries.

  It is tested.
- **"Better still" from the review, built:** `host/bin/fenvix-data-disk` and `fenvix-data.service` run before the
  agent at every boot.
  - The unused NVMe drive, chosen at install and recorded by its `/dev/disk/by-id` name, is opened with
    `cryptsetup --type plain`, AES-XTS, and a 512-bit key read from `/dev/urandom` that is never stored.
  - It is formatted XFS with reflink and mounted `nodev,nosuid`.
  - The guest image, now kept on the root filesystem under `/var/lib/fenvix/guest-image`, is copied onto it.
  - A reboot or a release therefore leaves only ciphertext. That also covers the review's note 3 (data on the NVMe
    after release).
  - Without an unused drive, `/srv/jailer` stays on the root filesystem, unencrypted, and the script deletes left-over
    jails at boot.
  - Shellchecked. **Not run here**: there is no block device to test with.

### R5: residency (Medium)

- **`hosts.ts`, the lease:**
  - It joins `gh_installations` and takes only jobs where `coalesce(i.pnap_region, PNAP_DEFAULT_REGION) = host region`
    (`for update of j skip locked`).
  - An installation that changed region, or a deleted installation, is never leased elsewhere.
- **`scaler.ts` step 2b:** queued jobs move to their installation's current region when that region is served, so
  demand is counted where it now belongs. Otherwise they wait and are never leased.
- The comment in migration 0014 is corrected. Only the comment changed; no SQL.
- **New integration tests (`tests/integration/pnap-r014-fixes.test.ts`):**
  - a job follows its customer to NLD and an NLD host leases it;
  - a job whose new region is unserved is neither moved nor leased.
- The review's note on job metadata passing through eu-west-1 stays a policy question for the founder.

### R6: cost leak (Medium)

- **`runScaler`:**
  - It plans every location that is configured or still has a host (`min = max = 0` when unconfigured). Idle hosts
    there drain at the end of their paid hour and are released.
  - Orphans are looked for in every `PNAP_LOCATIONS`.
- **`planRegion`:** a region with max 0 and no job host left releases its cache server, and orders none there.
- **New tests:**
  - an orphan in SEA, an unconfigured location, is released;
  - an unserved region's dedicated cache server is released.

### R7: busy hosts (Medium)

- **Silent hosts are collected first, then decided on.**
  - **Mass silence:** 2 or more ready hosts silent, and at least half of the ready fleet. Nothing is released, and
    `ALERT: … the App's host route … is the likely cause` is logged and returned in `report.alerts`. Only the job
    time limit + 15 minutes ends the wait.
  - **One silent host** that last reported running jobs, and whose server phoenixNAP reports `powered-on`, is kept
    (an alert is raised) up to the same limit. A silent idle host is released at once, as before.
- "Busy" is the host's own `running` count. It is not the leased count: a job leased but never reported running
  probably never started, and the author's test that it is queued again still holds.
- **New tests:**
  - one busy silent host is kept, then released after the limit, while a healthy host is untouched;
  - an idle silent host is released, while a fleet-wide silence holds everything.

### R8 to R11: the first test

- **R8:**
  - `try_invoke` never exits.
  - `retry_invoke` tries 6 times, with pauses of 5, 10, 20 … s.
  - `release()` asks for the release again until it went through once, checks status with retries, and stops after 20
    minutes in all.
  - The final warning says what to do and that the hold plus the idle drain still bound the cost.
- **R9:**
  - The guide's total says "≈ $1.30 to $2.60 likely; at most ≈ $3.90 (3 started hours)".
  - It also gives the killed-laptop case: ≈ $2.60 at the default 60 minutes, ≈ $5.20 at 180. That is 4 started hours,
    so the review's "about $5.10" plus the IP.
  - The script's own confirmation prompt states the same maximum.
- **R10:** see the table above.
- **R11:**
  - The workflow template has `cat >probe.sh <<'FENVIX_PROBE'`, filled by `--print-workflow` with awk at YAML
    indentation, and `sha256sum -c` against the SHA printed with it. Nothing is downloaded.
  - The script refuses a `probe.sh` containing the delimiter.
  - New test: it parses the printed workflow as YAML, runs its step up to the SHA check in bash, and gets `probe.sh`
    back byte for byte with the check passing.
  - The guide's step says to print and commit the workflow again when `probe.sh` changes.

### Review notes also done (not counted)

- **(a) Per-namespace conntrack:**
  - `vm_ruleset` now has its own `ct count over conn_limit` drop before the accept, so a flooding guest cannot fill
    its namespace's conntrack table.
  - `nft -c` accepts it, and the real-packet netns scenarios still pass.
- **(b) The host table stays loaded:**
  - `Agent.ensure_host_table` runs on every lease round. If `inet fenvix` is gone, it is reloaded.
  - If the reload fails, `ip_forward=0` and no job is leased (tested with a stand-in for `nft`).
- **(c) `fenvix-net.service`:** the docstring now says what loads the table.
- **Note 5 (KSM, swap):** done with R2.

## What I ran (this container, 2026-11-18)

| Suite | Before (b7686fd + reviewer's tests) | After |
|---|---|---|
| `github-app`: typecheck | ok | ok |
| `github-app`: unit | 80 pass, **2 fail** (R2, R3) | **82/82** |
| `github-app`: integration (scratch Postgres 16, `scripts/prepare-test-db.sh`) | 79 pass, **3 fail** (R5, R6, R7) | **88/88** (79 + reviewer's 3 + 6 new; the 6 new fail 0/6 before) |
| `infra/github-app`: `npm test` (templates, cdk-nag in both modes, pnap included) | 61/61 | **61/61** |
| `infra/customer-mode/pnap`, as **root** (conntrack, shellcheck, iproute2 installed) | 45 pass, **9 fail** (reviewer's) | **71/71**, none skipped (45 + reviewer's 9 + 17 new) |
| same suite as **`fenvix-parse`** / **`fenvix-post`** / **`fenvix-cache`** (each a real non-root system account, `runuser`, its own copy of the tree) | (not run) | **49 pass, 22 skipped, 0 fail** for each account |
| non-root steps as the production accounts, from root (`test_hardening.ProductionUsers`: `runuser -u fenvix-parse/-post`, the cache as `fenvix-cache`) | job `no-summary` | **2/2**: summary posted, cache up |
| `bundle.py --check` | | up to date (22 files) |
| `shellcheck` install-host.sh, fenvix-data-disk, first-test.sh, install-cache.sh | | clean |

When the suite runs as a non-root account, 22 tests skip. Each one needs root: to make network namespaces, to own
files as a jail uid, or to switch to another uid. Those 22 run in the root run above.

Commands:

```
cd github-app && TEST_DATABASE_URL=postgresql://postgres@localhost:54329/gh_test bash scripts/prepare-test-db.sh && npm test
cd infra/github-app && npm test
cd infra/customer-mode/pnap && python3 -I -m unittest discover -s tests              # as root
useradd --system --no-create-home --shell /usr/sbin/nologin fenvix-parse   # and fenvix-post, fenvix-cache
runuser -u fenvix-post -- python3 -I -m unittest discover -s tests                    # in a copy owned by that account
```

## Not done, and risks

1. **Not built:**
   - Note 1: a uid per job rather than per slot.
   - Note 2: the first test's `release` still drains every host of the region (fine before the first customer).
   - Core scheduling.
   - Mixing reserved and hourly hosts. That was already a follow-up.
2. **User data size.** The host bundle grew: the user data is now about **54 KB**, up from about 45 KB at `b7686fd`,
   and about 72 KB once phoenixNAP's API base64-encodes it. Most of the growth is the new host code. phoenixNAP's
   API description states no limit. This is on the first real test's list.
3. **Untested here, by design (no KVM, no block device, no phoenixNAP):**
   - the dm-crypt data disk;
   - `nosmt`, tmpfiles and update-grub;
   - Firecracker accepting the `serial` section of the configuration file;
   - the real cgroup wait under `--new-pid-ns`.

   Each is in the guide's "Must be checked on the first real host", items 7 to 14, added from the review's list.
4. **The silent-host policy trades cost for safety.** A host that really died while it had running jobs is paid for
   up to the job limit + 15 minutes: at most about $8 per host.

## Files

- **Host:**
  - `host/fenvix_host/{agent,job,vm,config,netplan}.py`
  - `host/install-host.sh`
  - `host/bin/fenvix-data-disk` (new)
  - `host/systemd/fenvix-data.service` (new)
  - `host/systemd/fenvix-agent.service`
  - `bundle.py`
  - `first-test/{first-test.sh,fenvix-first-test.yml}`
- **Control plane:**
  - `github-app/src/pnap/{settings,hosts,scaler,userdata}.ts`
  - `host-bundle.generated.ts` (regenerated)
  - the comment in migration 0014
- **Tests:**
  - the reviewer's four files, unchanged;
  - new: `infra/customer-mode/pnap/tests/{test_hardening,production_users_scenario}.py` and
    `github-app/tests/integration/pnap-r014-fixes.test.ts`;
  - updated slot counts in the author's `pnap.test.ts` (unit and integration);
  - `validate-fc-config.mjs` knows `serial`.
- **Docs:**
  - `docs/CUSTOMER-MODE-PNAP.md`: capacity and cost at 15 slots, first-test maximum, behaviour, real-host checks 7 to 14;
  - `infra/customer-mode/pnap/README.md`;
  - this report.
