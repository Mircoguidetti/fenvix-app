FIX 11

# Review R-014: customer mode on phoenixNAP Bare Metal Cloud

Reviewed: branch `claude/customer-mode-pnap` at `b7686fd` (commits `02a98e8`, `78ed9e0`, `5c1a766`, `d9bbbdc`,
`b7686fd`), against `docs/REPORT-customer-mode-pnap.md`, `docs/CUSTOMER-MODE-PNAP.md` and the code they name. This
review is on branch `claude/review-r014`.

The threat model: every job runs hostile code from a paying customer, and two customers share one host. Nothing was
ordered at phoenixNAP, and this container has no `/dev/kvm`.

**Verdict: FIX 11.** The design is sound, and the hard parts hold under attack:
- the per-microVM network namespace and its nftables rules;
- the jailer line;
- the safe result read (R-012b N1);
- the network-less VMM namespace (R-012b N3);
- region-bound host credentials;
- the single-use enrolment;
- the summary credential, which never enters the guest.

I found no way for a job to reach another job's memory, disk, network or cache organization, the host's ports, phoenixNAP's
API credentials (none are on a host) or the host routes of our control plane.

It is **not ready for a first customer**. Eleven defects remain, each with a failing test on this branch:
- **High (3):**
  - R1: one job can exhaust the host agent's memory through its serial console.
  - R2: two tenants' vCPUs share physical cores (SMT on), against Firecracker's production guidance. This also halves the capacity and cost figures.
  - R3: in production no summary is ever posted and the colocated cache never starts, because of file permissions the tests (all run as root) cannot see.
- **Medium (5):** stale jails survive an agent restart (R4), a residency gap (R5), a cost leak (R6), mass release of busy hosts (R7), and a first-test workflow that can never pass (R11).
- **Low (3):** R8, R9, R10.

## What I ran (this container, 2026-11-18)

| Check | Result |
|---|---|
| `github-app`: `npm test` (typecheck, unit, integration; scratch Postgres 16, `scripts/prepare-test-db.sh`) | typecheck ok, **unit 80/80**, **integration 79/79**, as the report says |
| `infra/github-app`: `npm test` (typecheck, templates, cdk-nag in both modes) | **61/61** |
| `infra/customer-mode/pnap`: `python3 -I -m unittest discover -s tests` (as root; conntrack and shellcheck installed) | **45/45**, none skipped |
| `python3 -I infra/customer-mode/pnap/bundle.py --check` | up to date |
| Firecracker v1.18.0 sources (`src/jailer/src/{env,cgroup,main}.rs`, `src/firecracker/src/main.rs`, `src/vmm/src/builder.rs`, `serial.rs`, `docs/prod-host-setup.md`, from raw.githubusercontent.com at tag v1.18.0) | every jailer and Firecracker flag used exists, and `--level Warning` parses. Details in "Configs" |
| phoenixNAP prices, re-read today: `phoenixnap.com/wp-json/pnap/v1/bmc-pricing`, `phoenixnap.com/kb/how-to-deploy-bare-metal-cloud-server` | prices confirmed (see "Costs"). The partial-hour billing is confirmed by phoenixNAP's own KB |
| The host bundle extracted the way the user data does it (`umask 077`, as root) | directories come out **0700** (R3) |
| `curl https://raw.githubusercontent.com/Mircoguidetti/fenvix-app/claude/customer-mode-pnap/.../probe.sh` (unauthenticated) | **404**: the repository is private (R11) |
| **New tests** (this branch) | `github-app/tests/integration/review-r014.test.ts` **0/3**, `github-app/tests/unit/review-r014.test.ts` **0/2**, `infra/customer-mode/pnap/tests/test_review_r014.py` **0/9**. Each fails for the reason in its message |

`npm test` in `github-app` and the Python suite now fail on purpose until the findings are fixed.

## Findings

| # | Sev | Area | Defect | Failing test |
|---|---|---|---|---|
| R1 | High | host (1), configs (4) | The guest's serial console goes into the root agent's memory, unbounded: a cross-tenant DoS | `test_r1_…serial_console…` |
| R2 | High | configs (4), F16 (6) | SMT stays on: one physical core runs two tenants' vCPUs. Slots are counted in hardware threads | `R2 SMT` (unit), `test_r2_the_host_install_turns_smt_off` |
| R3 | High | host (functional) | `fenvix-parse`, `fenvix-post` and `fenvix-cache` cannot read their programs or files: no summary is ever posted, and the colocated cache never starts | `test_r3_…bundle…`, `test_r3_summaries_are_posted…`, `R3 permissions` (unit) |
| R4 | Medium | disks (2) | A jail interrupted by an agent restart, crash or reboot stays on the data disk with the customer's data | `test_r4_a_jail_left_…` |
| R5 | Medium | residency (3) | A job keeps the region it was placed in. An ASH host leases it after the installation was set to NLD (default-region path) | `R5 residency` (integration) |
| R6 | Medium | scaler cost (3) | Hosts of a region removed from `pnapRegions` are never drained or released, and the orphan sweep skips that region | `R6 cost` (integration) |
| R7 | Medium | scaler (3) | When the App stops hearing from all hosts (the hosts function is down), the scaler releases every busy host after 5 minutes | `R7 busy hosts` (integration) |
| R8 | Low | first test (5) | One failed `invoke` inside `release()` ends the release: `die` exits inside the EXIT trap | `test_r8_a_failed_release_call…` |
| R9 | Low | cost (5) | "At most ≈ $2.60" is wrong. The script's own deadlines allow 3 started hours (≈ $3.83 to $3.90) | `test_r9_…maximum_cost…` |
| R10 | Low | configs (4) | No I/O limit on any of the four disks per microVM: one job can saturate the shared NVMe | `test_r10_every_microvm_disk_has_an_io_limit` |
| R11 | Medium | first test (5) | The test workflow downloads `probe.sh` from our **private** repository: 404, so the first test can never pass | `test_r11_…private_repository` |

### R1. The guest's serial console fills the host agent's memory (High)

The guest kernel boots with `console=ttyS0`, and a job is root in its VM (Docker), so it can write to `/dev/ttyS0`
for the whole 6-hour job limit. The Firecracker configuration has no `serial` section, so Firecracker v1.18.0 writes
the 8250 device to its stdout (`builder.rs`: `serial_out_path` unset → stdout) with no rate limiter. `run_job` starts
the jailer through `Shell.run(..., capture_output=True)`, so every byte ends up in the agent's memory.

That agent is the root process that holds the host credential. Its unit (`fenvix-agent.service`) has no `MemoryMax`,
and its 4 threads and 16 GiB are the host's whole reserve. When memory runs out:
- the kernel OOM-kills either the agent (systemd restarts it, and `KillMode=control-group` then kills **every
  tenant's microVM** on the host);
- or another tenant's 8.5 GiB Firecracker.

Firecracker's own `docs/prod-host-setup.md` ("8250 Serial Device") warns of exactly this unbounded memory or storage
use. Test: 256 MiB of console output grows the agent by **513 MiB**.

**Fix:**
- Configure `"serial": {"rate_limiter": …}` with a small bucket, or `serial_out_path` to a bounded sink. Do not rely
  on `8250.nr_uarts=0` alone: the guest can re-enable the device.
- Run the jailer with stdout and stderr to `/dev/null` or a size-capped file.
- Add `MemoryMax=` (or a memory cap on the `agent` leaf) for the agent.

Caution: with `--new-pid-ns` the jailer **exits at once** after cloning Firecracker (`env.rs`,
`exec_into_new_pid_ns` → `libc::exit(0)`). `run_job` today waits for the VM only because the captured pipes stay open
until Firecracker closes them. Once output no longer goes to a pipe, wait on the Firecracker pid
(`<jail>/firecracker.pid`) or on the cgroup's `cgroup.events` (`populated 0`). Otherwise the result is read while the
guest is still booting. That wait also gives Firecracker's real exit status: today `returncode` is always the
jailer's 0.

### R2. SMT on: two tenants per physical core (High; R-012 F16 carried over inverted)

`slotsFor` gives "one vCPU per hardware thread": (64 − 4) / 2 = 30, so 28 slots by memory. `install-host.sh` never
turns SMT off. The scheduler therefore puts vCPUs of two different customers on the two threads of one core.
Firecracker v1.18.0 `docs/prod-host-setup.md`, "Disable SMT": *"our recommendation is to disable SMT in production
scenarios that require tenant separation"*. That is exactly this threat model. R-012 F16's point was capacity "bounded
by the physical cores". The KVM translation dropped it.

**Fix:**
- `echo off > /sys/devices/system/cpu/smt/control`, plus `nosmt` on the kernel command line. Check
  `/sys/devices/system/cpu/smt/active` = 0 before enrolment.
- Count slots in cores: (32 − 2) / 2 = **15** per d3.c1.large.
- Also check KSM off (`/sys/kernel/mm/ksm/run` = 0) and no host swap, as the same guide asks.

**Cost impact:** the doc's table becomes 15 / 75 / 150 jobs at once for 1 / 5 / 10 hosts. Keeping 28 / 140 / 280 jobs
at once takes 2 / 10 / 19 hosts, so the per-job cost almost doubles: about $63 a month per job slot hourly-all-month,
instead of $34. (Core scheduling, `prctl(PR_SCHED_CORE)` per VM, is the alternative that keeps SMT, but it needs
care and a measurement.)

### R3. The service users cannot read what they need (High: in production no summary is ever posted, and the colocated cache never starts)

Three permission errors, all hidden because every test runs as root (`Users(parse=[], post=[])`):

1. **The bundle.** The user data sets `umask 077`, then runs `tar -xzf … --no-same-owner`. The archive holds files
   only, so GNU tar creates their directories with the umask: `fenvix_host/`, `cache/`, `bin/`, `guest/` and
   `systemd/` come out **0700 root**. `chmod -R go-w` does not add read.
   - `runuser -u fenvix-parse python3 -I …/read_result.py` → `Permission denied` → the agent parses `{}` → every job
     ends "no-summary".
   - `fenvix-cache.service` (User=fenvix-cache) cannot open `fenvix_cache_auth.py`.
2. **`/run/fenvix`.** It is 0700 root (`RuntimeDirectoryMode=0700`). `post_dir` is created inside it, so `fenvix-post`
   cannot reach `summary-token` (`PermissionError`, test).
3. **`/etc/fenvix`.**
   - The user data creates it 0700 root, and both cache services read `/etc/fenvix/cache/signing-key.json` as
     `fenvix-cache`.
   - The agent also writes that key under its `UMask=0077`, so the file itself is 0600 root.

**Fix:**
- Put `0755` directory entries in the bundle (or extract with `umask 022`).
- Keep `post-*` outside the 0700 runtime directory, or make `/run/fenvix` 0711 with each `post-*` 0700 owned by
  `fenvix-post`.
- Make `/etc/fenvix` 0711 with `cache/` 0755 and the public key 0644.
- Add a job test that really drops to a non-root uid. The new test does this with `setpriv`.

### R4. A jail interrupted mid-job stays on the host (Medium)

`run_job`'s cleanup removes only the **new** job's jail id (`fxs<N>-j<new job>`). Interrupted jobs leave
`/srv/jailer/firecracker/fxs<N>-j<old>/root` on the XFS data disk. This happens on an agent restart (`Restart=always`;
the kill of the cgroup also kills the VMs), an agent crash or a host reboot. The jail holds:
- the customer's root disk;
- the scratch disk (checkout, Docker layers, `_work`, anything the job's secrets touched);
- the input disk (just-in-time config, cache token).

Nothing ever sweeps it. It stays until the server is released, and it may then reach phoenixNAP's next tenant of that
hardware (see the "real host" list). The matching `vms/<id>` cgroups also stay.

**Fix:**
- At agent start (`prepare_host`), before the first lease: kill every jail uid, delete every directory under
  `<chroot_base>/firecracker/`, every `fxvm*` namespace and every `vms/*` cgroup.
- Better still, put `/srv/jailer` on dm-crypt with a random key generated at boot (lost at reboot). A release or
  reboot is then a crypto-erase.

### R5. Residency: the region is fixed at placement, not at lease (Medium)

`placement.ts` stores the region when the job is queued, and `hosts.ts` leases by `pnap_jobs.region` alone. `mintJob`
never compares the installation's current `pnap_region`.

With `pnapDefaultRegion` set, which the doc offers:
1. A new European customer installs the App and pushes.
2. The job is queued in, say, ASH.
3. The founder then runs `set-region NLD`.
4. An ASH host still leases the queued job, mints its just-in-time runner and cache token, and runs the customer's
   code and cache traffic in the US.

The same happens to any queued job when a customer moves region. Migration 0014's comment ("NULL: not placed until
set (no job ever runs in another region)") is not true once a default region is set.

**Fix:**
- In the lease, join `gh_installations` and lease only `where j.region = i.pnap_region` (or the default when NULL).
  Re-place or cancel the rest.
- Better: drop the default region, or make it per jurisdiction. An installation without an explicit region should
  wait.

Note, not a placement defect: the control plane is in **eu-west-1**. Summaries, outcomes and the minting of every US
job's credentials go through Ireland. The brief's rule ("US data stays in the US") should say whether it covers
job metadata.

### R6. A region removed from `pnapRegions` keeps its hosts for ever (Medium, cost)

`runScaler` plans and sweeps orphans only for the configured regions (`regions = Object.keys(d.s.regions)`). Step 1
keeps hearing a host there, so the host is never silent, never drained and never released. Placement no longer sends
it jobs either. One d3.c1.large left this way costs $1.27/h, $927 a month.

Example: the founder runs the first test with `ASH:0:1`, then changes it to `NLD:0:2`. Any ASH host still up is
orphaned. Its server is not swept either, because its hostname is in the database.

**Fix:** plan every region that has live hosts (with min = max = 0 when it is not configured), and list servers in
all `PNAP_LOCATIONS` for the orphan sweep.

### R7. A control-plane outage releases every busy host (Medium)

A `ready` host not heard from for 300 s is released at phoenixNAP, even when it has running and leased jobs and
phoenixNAP reports it `powered-on`. The scaler can reach the database and phoenixNAP while the hosts function cannot
answer, for example:
- a bad deploy of `hosts`;
- throttling;
- an API Gateway incident;
- an expired certificate on the domain.

In that case every host in every region goes "silent" in the same minute, and the next scaler run deprovisions the
whole fleet mid-job.

**Fix:**
- Treat the release as a decision about one host, not the fleet. If more than a small share of live hosts went silent
  at once, release nothing and alert.
- For a host with running or leased jobs whose server is `powered-on`, wait at least the job time limit, or first
  probe it out of band.

### R8. `first-test.sh`: one failed call ends the release (Low)

`release()` runs `invoke … || true`. But `invoke` calls `die`, which runs `exit 1`, and `exit` inside the EXIT trap
cannot be caught by `|| true`.

One throttled call ends the release at once, without the 20-minute wait the doc promises. A throttle is likely: the
scaler has reserved concurrency 1 and also runs every minute. Expired SSO credentials do the same.

The fallback still bounds the cost: the hold expires after `--minutes`, then the scaler drains the host when idle at
the end of its paid hour. So this is Low.

Test: with the first release call failing, the host is left `ready`.

**Fix:** a non-exiting `invoke` for the trap path, with retries (back off on throttling), and a loud final warning.

SIGHUP is **not** a problem: bash runs the EXIT trap of a script on SIGHUP. I checked that, and dropped my own test
for it.

### R9. The stated maximum cost of the first test (Low)

The doc says "**at most ≈ $2.60 (2 hours)**". The script's own deadlines are:
- 90 minutes to wait for ready;
- 40 minutes for the runs;
- 40 × 30 s of release polling.

That allows 150 minutes, so **3 started hours: $3.81 + IP ≈ $3.83 to $3.90**. With `--minutes 180` and a killed
laptop, the hold keeps the host 180 minutes, then the idle drain releases it at the end of the paid hour: 4 started
hours, about $5.10. (The doc's "≈ $3.90" for the 180-minute hold is therefore low too.)

The likely case (ready in 20 to 45 minutes, jobs about 10 minutes) is still $1.27 to $2.54 plus the IP.

**Fix:** state the maximum from the deadlines, or cap the whole script at 115 minutes from the order.

### R10. No I/O limit per microVM (Low)

There are four disks per microVM on one shared NVMe, no `rate_limiter` on any drive, no `io.max` in the cgroup, and
only a 500 Mbit/s network limiter. One job (`fio`, a large `docker build`) can saturate the drive and the host page
cache, which slows every other tenant's boot (reflink copy, mkfs) and build. See `prod-host-setup.md`, "Mitigating
Noisy-Neighbour Storage Device Contention".

**Fix:** a drive `rate_limiter` (bandwidth and ops) on `rootfs` and `scratch`, or `io.max` on the data disk's
`MAJ:MIN` through `--cgroup`.

### R11. The first test cannot pass: `probe.sh` comes from a private repository (Medium)

`fenvix-first-test.yml` runs
`curl -fsSL https://raw.githubusercontent.com/Mircoguidetti/fenvix-app/claude/customer-mode-pnap/infra/customer-mode/pnap/first-test/probe.sh`.
`Mircoguidetti/fenvix-app` is **private**. Unauthenticated, that URL answers **404** (checked today). The test
organizations' `GITHUB_TOKEN` cannot read it either.

Every run therefore fails before a single probe, and the test reports FAIL with "0 pass, 0 fail". The ref is also a
branch that disappears with the merge.

**Fix:** have `--print-workflow` inline `probe.sh` into the workflow (a heredoc), keeping the SHA-256 line as a
self-check. Or commit `probe.sh` next to the workflow in each test repository.

## (1)–(2) Isolation: what I attacked and what held

- **Job → job.**
  - **Network:** another microVM's link address, the shared guest address, spoofed sources (raw SYN), and the slot
    gateway are all dropped. I re-read `netplan.py` and `tests/netns_scenario.py`: the rules are checked by interface
    and source, policy drop, and the tests send real packets.
  - **Disk:** each jail root is 0700 under a 0700 root-owned parent, the uid is distinct per slot, and nothing is
    shared.
  - **Memory:** separate KVM VMs, with `memory.swap.max=0`. But see R2 for SMT.
  - **Cache:** per-job RSA tokens bound to `gh-<installation>`. Colocated: the cache's namespace accepts only
    `10.200.0.0/16` on its port. Dedicated: the private network only.
  - **Summary credential:** never on the input disk (the test asserts it), and in a per-job file of `fenvix-post`.
    R3 makes that file unreachable even for `fenvix-post` today, which fails closed.
- **Job → host.** Input from `fxv*` is dropped, and the host's addresses and all RFC 1918, CGNAT, link-local and
  multicast ranges are dropped. IPv6 is disabled in each namespace and dropped in the host's forward chain. The VMM's
  own namespace drops input and output (N3).
- **Job → phoenixNAP.** There is no metadata service (NoCloud floppy). `169.254.0.0/16` is dropped anyway. The API
  client is only in the scaler Lambda. The cloud-init floppy holds a single-use enrolment secret, spent at enrolment.
- **Job → control plane.**
  - The API is public, as the doc says.
  - `/v1/hosts/enrol` needs the `fxe1` secret.
  - `/v1/hosts/lease` needs `fxh1`, bound to host, region and generation (tested).
  - Summaries need the per-job `fxr1`, which stays on the host.
- **Per-job disks and network.** Created per job and deleted on every path of a run: four paths are tested, and I
  re-ran them. The exception is an interrupted run (R4).
- **Survival past the job's end.**
  - Guest disks are deleted, and the root disk is a reflink copy, so the base is never written.
  - Slot processes are killed with `pkill -u`.
  - Conntrack entries are flushed.
  - The cache is the only persistence, and only within the customer's own organization (write only on trusted refs,
    by design).
  - Defense-in-depth notes are below (uid reuse, IPC).

## (3) Scaler

- **Leaks:**
  - R6.
  - An order that crashed is failed after 10 minutes and its server swept as an orphan (tested by the author).
  - A host that never enrols is released after 90 minutes.
  - A draining host that went silent with a stale `running > 0` is kept until `jobTimeoutMinutes + 15` (375 minutes),
    which is acceptable but worth a note.
- **Busy host released:** R7.
  - Drain and release are guarded in SQL (`not exists leased`, `running = 0`).
  - The lease race (a lease reads `ready` while the scaler drains) is covered by the next run's `leased > 0` check.
- **Wrong region:**
  - Order `location`, enrolment, lease, credential and dedicated cache are all bound to the host's own region.
  - The gap is the job side (R5).

## (4) Configs for Firecracker 1.18 on KVM

- **Jailer flags** (checked against `src/jailer/src/main.rs` v1.18.0): `--id` (`fxs<slot>-j<job id>`, at most 26 characters of `[A-Za-z0-9-]`; the jailer allows 64),
  `--exec-file`, `--uid`/`--gid` (distinct per slot), `--chroot-base-dir`, `--netns`, `--new-pid-ns`,
  `--cgroup-version 2`, `--parent-cgroup`, `--cgroup` and `--resource-limit fsize|no-file` all exist and are used
  correctly.
  - The jailer chowns the jail root to the uid (`FOLDER_HIERARCHY` includes `/`), as `result.py` assumes.
  - It enables each controller in every ancestor's `cgroup.subtree_control`. That works because `prepare_cgroups`
    moves the agent into an `agent` leaf ("no internal processes"). This must be seen on the real host.
- **Firecracker** (`src/firecracker/src/main.rs`): `--no-api --config-file config.json --level Warning` are valid. The
  configuration validates against v1.18.0's swagger (the author's test). `smt: false` and `entropy` are fine.
  Missing:
  - `serial` (R1);
  - drive rate limiters (R10).
- **cgroups:**
  - `cpu.max` of vCPUs × 100 ms also caps Firecracker's own I/O threads (a slight throttle, acceptable).
  - `memory.max` is the guest plus 512 MiB.
  - `memory.swap.max=0` and `pids.max=128` are right.
  - `kvm-pit` threads stay in the root cgroup (prod guide; minor).
- **seccomp:** the default filter; `--no-seccomp`, `--seccomp-filter` and the API socket are refused by an assertion.
  Correct.
- **nftables:** correct for the purpose, and tested with packets. Notes:
  - (a) The per-VM connection limit is enforced in the root namespace only. Each VM's own namespace confirms
    conntrack entries before the root namespace drops them. A flooding guest can hold up to `nf_conntrack_max`
    (1,048,576, per namespace) entries in its own namespace: about 300 MB of kernel memory, not charged to its
    cgroup. Add the same `ct count` limit in `vm_ruleset`.
  - (b) Nothing re-checks that the `inet fenvix` table is still loaded. If anything runs `flush ruleset` (an enabled
    `nftables.service` with Ubuntu's default `/etc/nftables.conf`, ufw), forwarding stays on and `fxv*` input is
    accepted. Check it on every lease tick.
  - (c) The `fenvix-net.service` that `netplan.py` mentions does not exist: the agent loads the table.

## (5) The first-test script and its cost

- **Release on failure:** R8; R11 makes every run fail.
- **Prices**, re-read today from phoenixNAP's own data, are all as the doc states:

  | Item | Price |
  |---|---|
  | d3.c1.large, ASH, PHX, CHI, SEA, NLD (SKU ASH `BENC-NRSJ-FZOT`) | hourly $1.27; 1-month $804.27; 12-month $436.59; 24-month $394.07; 36-month $360.05 |
  | s1.c1.small | $0.16/h; 12-month $69.29 |
  | Public IP blocks | /29 $0.028/h, /31 $0.007/h |
  | Bandwidth | $0.01/GB metered |
  | Hardware | 2 × Xeon Gold 6536, 16 cores each, 256 GB, 2 × 2 TB NVMe, 2 × 25 Gbps |

  - phoenixNAP's KB confirms the billing rule: *"You will be charged a full hour even if you decommission a server
    before 60 minutes expire."*
  - It gives deployment as "three to fifteen minutes".
  - The BMC API's default `ipBlocksConfiguration` is `PURCHASE_NEW`, "the smallest supported range", probably a /31,
    so the doc's /29 assumption is conservative.
  - The monthly arithmetic checks ($927.10, $20.44, break-even 344 h), except that the capacity column needs R2.
- **First test:**
  - **≈ $1.30** (1 started hour) to **$2.60** (2) in the likely case.
  - **At most ≈ $3.90** by the script's own deadlines (R9).
  - With a killed laptop: about $2.60 at `--minutes 60`, about $5.10 at `--minutes 180`.

## (6) R-012 / R-012b carried over to KVM

| Finding | Carried over? |
|---|---|
| F9 (no guest disk mounted; ids from the host) | **Yes.** Raw result disk, a length-prefixed record capped at 8 MiB, parsed in userspace as `fenvix-parse` from an fd. Ids and runner name come from the lease. The guest's `repositoryId` is ignored (tested). Today R3 stops the parser from running at all |
| F10 (interface-keyed firewall, FORWARD drop, IPv6, per-sandbox limits) | **Yes**, with real packets. Note (a) above on per-namespace conntrack |
| F11 (Nitro memory pool) | n/a on KVM |
| F12 (no runner before capacity) | **Yes.** The just-in-time runner is minted at lease. Remaining: an unused runner after a host loss (author's note 7) |
| F13 (demo scope) | **Yes**, unchanged |
| F14 (cdk-nag fully evaluated) | **Yes**: cdk-nag passes in both modes, including pnap |
| F15 (secret rotation) | **Yes**: host keys current and previous, 5-minute reload |
| F16 (capacity by physical cores) | **No: R2.** Hyperthreads are counted, and SMT stays on |
| F17 (jailer, no root, nothing of ours on the guest's path) | **Mostly.** Jailer, uid per slot, chroot, PID and network namespaces, cgroup v2, seccomp, and a root-only host credential are all in place. Gaps: R1 (guest bytes into the credential-holding agent, unbounded) and R2 |
| N1 (no symlink-following read) | **Yes.** `O_NOFOLLOW` relative to the root-owned 0700 parent, `fstat` (regular file, the jail uid, 1 link, exact size), `O_NONBLOCK` against FIFOs. The escaped-VMM symlink attack is tested |
| N3 (a jailed VMM reaches no credential) | **Yes.** Each VMM is in its own namespace with input and output dropped (tested). phoenixNAP has no IMDS |

## Notes (not counted)

1. **uid per slot, not per job:**
   - the next customer's VMM in a slot runs as the same uid;
   - the jailer creates no IPC namespace (SysV IPC, keyrings).

   Firecracker's seccomp filter very probably blocks those syscalls, but a per-job uid, cycled from a larger range,
   is cheap defense in depth.
2. **`release` drains every host of the region**, a real customer's host included. That is fine before the first
   customer; later, the first test should hold and release its own host only.
3. **Data on the NVMe after release:** confirm phoenixNAP's wipe policy on deprovision. The dm-crypt-with-random-key
   suggestion in R4 makes this moot.
4. **Disk layout:** if phoenixNAP's Ubuntu image uses both NVMe drives (software RAID), there is no free drive. Jobs'
   disks are then full copies on the root filesystem: slower, and 28 × 50 GiB sparse scratch on the root FS.
5. `install-host.sh` checks neither KSM nor swap (`prod-host-setup.md`).

## Must be tested on a real host before the first customer

After the fixes:
1. **Boot under the jailer** with the exact line:
   - `--netns`, `--new-pid-ns`;
   - the cgroup v2 parent under the agent's delegated subtree (the `agent` leaf move);
   - `cpu.max`, `memory.max` and `memory.swap.max` present and effective (`cat` them in `vms/<id>/`);
   - the `ip=` boot argument;
   - `reboot -f` ends Firecracker;
   - `run_job` waits on Firecracker, not on the exited jailer (R1 fix).
2. **SMT and host hygiene:** `/sys/devices/system/cpu/smt/active` = 0, KSM off, no swap, current microcode, and
   `grep . /sys/devices/system/cpu/vulnerabilities/*` all "Not affected" or "Mitigation".
3. **Serial flood:** inside a job, `cat /dev/zero > /dev/ttyS0` for 10 minutes. The agent's RSS stays flat and the
   other microVMs are unaffected.
4. **Non-root steps (R3):** the summary appears on the PR, and `fenvix-cache.service` is active with the key
   readable.
5. **Probes from inside real microVMs:**
   - all of `probe.sh`, which now has to be inlined (R11);
   - from the VMM's namespace as the jail uid (`nsenter --net=/run/netns/fxvm0 setpriv --reuid 900000 curl …`):
     nothing reachable;
   - IPv6 with packets (this container has no IPv6).
6. **Agent restart and reboot mid-job:** afterwards, no jail, namespace, cgroup or conntrack entry is left (R4).
7. **The ruleset stays loaded:** `nft list table inet fenvix` after a reboot, after `apt upgrade`, and with
   `nftables.service`/ufw states as the image ships them.
8. **Noisy neighbours:** `fio` in one job (R10) and a UDP/SYN flood in another (note (a)), while a third job's timings
   are measured.
9. **Control-plane outage:** stop the hosts function for 6 minutes during a job. Nothing is released (R7).
10. **phoenixNAP facts:**
    - the IP block a server gets;
    - per-started-hour billing on Rated Usage;
    - the user data size limit (about 45 KB);
    - order → powered-on time;
    - 406 as "no capacity";
    - disk wipe on deprovision.
11. **Timings:** queued → leased, leased → microVM up, boot → runner online. Then redo the cost table with 15 slots
    per host (R2).

## Run the new tests

```
cd github-app && TEST_DATABASE_URL=postgresql://postgres@localhost:54329/gh_test \
  node --test --test-concurrency=1 tests/integration/review-r014.test.ts      # 0/3 pass at b7686fd
cd github-app && node --test tests/unit/review-r014.test.ts                   # 0/2
cd infra/customer-mode/pnap && python3 -I -m unittest discover -s tests -p 'test_review_r014.py'   # 0/9 (as root)
```

`github-app`'s `npm test` and the Python suite include them, and fail until R1 to R11 are fixed. That is intended.
