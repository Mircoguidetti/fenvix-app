DONE

# Report: customer mode on phoenixNAP Bare Metal Cloud

Branch `claude/customer-mode-pnap` (from `claude/github-app` at `44d2a33`). Commits: `02a98e8` (host side), `78ed9e0`
(control plane), `5c1a766` (infra), `d9bbbdc` (docs and the first real test), plus this report.

All five parts asked for are built and tested **without a real host**, which was the brief. Three things could not be
done in this session:

- **Nothing was ordered at phoenixNAP.** There is no account, as stated in the brief. The API client was run only
  against a fake built from phoenixNAP's own OpenAPI descriptions.
- **No Firecracker microVM booted.** This container has **no `/dev/kvm`** (`ls /dev/kvm`: no such file), so the local
  Firecracker run could not happen. The jailer command line and the Firecracker configuration are checked against
  v1.18.0's documentation and API description. Everything around the VMM ran for real (see "Tests").
- **`fenvix-brain-cli` was not read.** The brief calls it public, but it is **private**: GitHub search lists it with
  `"private": true`, and `git clone` asks for credentials. The brief says not to attach other repositories, so neither
  DECISIONS.md (2026-11-18) nor `sessions/2026-11-18-bare-metal-research/REPORT.md` was read. I worked from the
  founder's decisions as stated in the brief. If those documents set something different (a server type, regions,
  a test budget), this work has not seen it.

## What was built

| # | Asked | Where |
|---|---|---|
| 1 | Host lifecycle through phoenixNAP's API: order, wait for ready, install our host image, drain, release. A scaler Lambda keeps each region's hosts between min and max and releases idle ones after N minutes. One region is one pool, and a job is placed only in its customer's region | `github-app/src/pnap/api.ts` (OAuth2 client credentials; `POST/GET /servers`, `actions/deprovision`, product availability); `scaler.ts` (pure per-region plan plus the run: orders, enrolment deadline, heartbeat loss, drain then release near the end of the paid hour, orphan release, no-capacity backoff, holds); `placement.ts` (the customer's region only: `gh_installations.pnap_region`); `userdata.ts` and the host bundle (cloud-init); `infra/customer-mode/pnap/host/install-host.sh` (KVM check, Firecracker + jailer v1.18.0 with SHA-256 checks, guest kernel and root disk, XFS reflink data disk, nftables, agent); Lambda `scaler` (every minute, reserved concurrency 1); migration `0014` |
| 2 | Per job: a just-in-time runner config from the App, one microVM (2 vCPU / 8 GB by default, configurable) under the jailer, its own disks created and deleted per job, a network isolated per microVM, no long-lived secret in the job. The spike's design and R-012 F9-F17, R-012b N1 and N3, translated to KVM | `github-app/src/pnap/hosts.ts` (`/v1/hosts/enrol` with a single-use secret; `/v1/hosts/lease` gives jobs of the host's own region, each minted at that moment through `GitHubService.mintJob`: a just-in-time runner, the job's summary credential and its cache token); `infra/customer-mode/pnap/host/fenvix_host/` (`job.py` lifecycle, `vm.py` jailer and Firecracker, `netplan.py` network namespaces and nftables, `result.py` safe read, `agent.py`); `guest/` (image build, job service). Mapping per finding: `docs/CUSTOMER-MODE-PNAP.md`, "Isolation" |
| 3 | The cache with proof, per region next to the runners; one namespace per customer organization | The engine's cache service unchanged (vendored, as in per-job mode) behind `fenvix_cache_auth.py`: RSA per-job tokens, organization `gh-<installation id>`, write only on trusted refs. Two placements: **colocated** (its own network namespace on each host: the default and the first test) or **dedicated** (`cache/install-cache.sh`, one s1.c1.small per region on the private network; the scaler orders it) |
| 4 | Tests without a real host | See "Tests" |
| 5 | `docs/CUSTOMER-MODE-PNAP.md`: the founder's steps, SSM, the one-command first test (one host for about an hour, 3 jobs from 2 organizations, isolation and timings, release), its expected cost, and monthly cost at 1, 5 and 10 hosts per region, hourly against 12-month | `docs/CUSTOMER-MODE-PNAP.md`; the command is `infra/customer-mode/pnap/first-test/first-test.sh` (with `probe.sh` run inside each job) |

Demo mode on AWS is unchanged; customer mode runs beside it (`customerMode: "pnap"`, default `off`).
DEPLOY-AWS.md now points to the new document; the AWS Nitro Sandboxes design is kept below it for reference.

## Tests (all run in this container)

| Suite | Result | Command |
|---|---|---|
| github-app: typecheck, unit, integration (scratch Postgres 16, migrations 0001-0014 applied twice) | **unit 80/80** (59 before; 21 new), **integration 79/79** (68 before; 11 new) | `cd github-app && TEST_DATABASE_URL=... npm test` |
| infra/github-app: typecheck, templates, cdk-nag in both modes | **61/61** (52 before: 50 passed and 2 failed; 9 new tests) | `cd infra/github-app && npm test` |
| infra/customer-mode/pnap (Python) | **45/45** | `python3 -I -m unittest discover -s infra/customer-mode/pnap/tests` (as root) |
| shellcheck (installed this session) | clean on every script of the host, guest, cache, first test, spike and runner files | inside the suites |

The two infra failures at the start were not regressions. shellcheck was installed for the first time in this session,
and it reported three "info" findings in existing scripts (`install.sh`, `fenvix-register`, the spike's
`run-job.sh`). I fixed them: targeted disable comments where the single quotes are intended, and a rewritten
`A && B || C`.

What the new tests show:

- **Isolation with real packets** (`tests/test_isolation_netns.py`). The exact generated network (host table, one
  namespace per slot with its rules, the colocated cache's namespace, a real TAP device owned by the jail's uid) is
  built in throwaway network namespaces. It sits around stand-ins for the internet, phoenixNAP's private network,
  `169.254.169.254`, the host's services and other microVMs, and is probed with TCP connections:
  - **Reachable:** the internet and the cache's port.
  - **Not reachable:** metadata, the host's public, private and link addresses, the slot's gateway, other microVMs,
    other private servers, the cache's other ports.
  - **From the VMM's own namespace** (the R-012b N3 case): nothing at all.
  - **Spoofed sources**, sent as raw SYNs and counted where they would arrive: 0 of 10 arrive, while 10 of 10
    controls with the real source do. With reverse-path filtering off, the slot's rule and the host's
    interface-and-source rule each drop all 10 by themselves.
  - **Limits:** a connection limit of 10 holds exactly 10 of 15, and the rate limit caps a burst; the other microVM
    is unaffected in both cases.
  - **Cleanup:** after teardown, no namespace and no link are left.
- **The generated configuration** (`tests/test_rules.py`):
  - nftables: forward policy drop; the spoofing check before any accept; only two accepts from a microVM; masquerade
    only to the public interface and the cache; `nft -c` accepts all three tables.
  - jailer: a distinct non-root uid per slot; `--netns`, `--new-pid-ns`, chroot; cgroup v2 `cpu.max`, `memory.max`,
    `memory.swap.max=0`, `pids.max`; no `--no-seccomp`, `--seccomp-filter` or API socket.
  - Firecracker configuration: **valid against Firecracker v1.18.0's own API description** (fixture), and unknown keys
    are refused.
- **One job end to end** (`tests/test_job.py`), with a fake jailer standing in for Firecracker and everything else
  real: the disks; the input disk, which holds only the just-in-time config, the cache token and plain settings and
  never the summary credential; the namespace and TAP; the safe result read; the summary posted by `fenvix-post` with
  the job's credential and the host's ids (the guest's `repositoryId` is ignored); and the cleanup on four paths
  (summary, garbage, hung guest, **an escaped VMM's symlink to another tenant's result**, which is refused and nothing
  is posted).
- **Result reader** (`tests/test_result.py`): symlink, hard link, FIFO (no hang), wrong owner or size, swapped jail
  root and a writable parent are each refused.
- **Agent** (`tests/test_agent.py`): enrolment is single use and its files are root-only; leases ask only for free
  slots; outcomes are re-sent until accepted; a malformed job is refused; drain stops new work; credentials renew.
- **Control plane, integration** (`github-app/tests/integration/pnap.test.ts`; Postgres, the fake GitHub, and the fake
  phoenixNAP that validates every request and response against phoenixNAP's OpenAPI descriptions):
  - jobs go to their customer's region only, and an installation without a region is not placed;
  - the scaler orders ceil(demand/28) hosts per region, and none where there is no demand;
  - enrolment works once, with that server's secret only;
  - a lease gives only the host's region's jobs, oldest first, each with a fresh just-in-time runner (the same config
    GitHub returned), a summary credential bound to runner, repository and run, and a cache token for that customer's
    organization;
  - a credential naming another region or generation is refused;
  - a job cancelled before pickup leaves the queue;
  - an idle host is drained, released at phoenixNAP, and its credential is revoked;
  - a silent host is released and its unstarted job is queued again;
  - a host that never enrols is released after the deadline;
  - when phoenixNAP has no capacity, the order fails cleanly and the region backs off;
  - an orphan server with our prefix is released, and another server is left alone;
  - the first test's hold and release-by-hand work.
- **Infra** (`infra/github-app/test/pnap.test.ts`):
  - **scaler** reads only `database-url` and the phoenixNAP client;
  - **hosts** reads the App key, `runner-token`, the host and cache signing keys, and never the webhook, OAuth or
    state secrets;
  - no secret value appears in any function's environment;
  - `POST /v1/hosts/{proxy+}` goes to the hosts function;
  - the schedule is one minute, with reserved concurrency 1;
  - cdk-nag is clean;
  - with `customerMode` off (the default), none of it is in the stack.
- **The first-test command** (`tests/test_first_test.py`), with stand-ins for `aws` and `gh`: the order of calls and
  the report, and **the host is released on every exit path** (a pass, a failure midway, a failed probe).

### Bugs the tests or the runs found (fixed)

1. Leases were not oldest-first: `UPDATE … RETURNING` does not keep the subquery's order (integration test).
2. The fake phoenixNAP gave a server no private address while it was `creating`, which the `Server` schema forbids
   (`minItems 1`). Schema validation caught it.
3. `first-test.sh` divided by the poll interval, so it would have failed with a 0 s interval. It now waits on deadlines.
4. **Running `build-guest.sh` here** (up to the engine bootstrap) found that Firecracker CI's Ubuntu root disk has no
   usable `/tmp`, no apt cache or list directories, and no `/var/log/apt`. Without them, apt fails in the chroot.
   The script now creates them.
5. The CI guest kernel (6.1.155) has no `nf_tables`, while Ubuntu 24.04's Docker uses iptables-nft. The guest now uses
   iptables-legacy (the switch ran successfully in the chroot).
6. Jail uids 30000+ collide with real accounts (`nixbld2` here). They are now 900000+, and the install script refuses
   a host where the range is taken.
7. The first spoofing probe tested nothing: the kernel refused to route the spoofed source (`ENETUNREACH`). It was
   replaced by raw SYNs counted at the destination, with a control. The test also showed that strict `rp_filter`
   drops spoofed packets before nftables sees them; the nftables rules are therefore tested separately, with
   `rp_filter` off.

### What the guest image build reached here

`build-guest.sh` with the pinned kernel and root disk (SHA-256 below) completed these steps: unsquash, apt (Docker,
git, the runner's libraries by name), the iptables-legacy switch, the job user, and the engine-cli checkout at the
pinned commit. It stopped inside the engine's `bootstrap.sh install`, whose tool installers (`astral.sh`,
`sh.rustup.rs`) this session's network policy refuses (`connect_rejected`). A real host reaches them. The run used a
scratch copy of the script that also trusts this session's proxy CA; the committed script is unchanged in that respect.

## Sources read today (2026-11-18)

- **phoenixNAP API:** developers.phoenixnap.com is a client-side portal whose raw spec download was not reachable from
  here. I used phoenixNAP's own OpenAPI descriptions (declared license Apache 2.0) from their Go SDK:
  `bmcapi/api/openapi.yaml`, `billingapi/api/openapi.yaml` and `networkapi`. They are committed as test fixtures with
  their SHA-256 (`github-app/tests/fixtures/pnap/PROVENANCE.md`). The token URL is
  `https://auth.phoenixnap.com/auth/realms/BMC/protocol/openid-connect/token`, with scopes `bmc` and `bmc.read`.
- **cloud-init on BMC** (phoenixnap.com/kb/bmc-cloud-init): NoCloud datasource; user data is base64 in
  `osConfiguration.cloudInit.userData` and is not returned by the API. The server reads it from a floppy for its whole
  life. That is why the enrolment secret is single use.
- **Prices:** the data behind phoenixnap.com/bare-metal-cloud/instances (`phoenixnap.com/wp-json/pnap/v1/bmc-pricing`,
  in the Billing API's `Product` format). d3.c1.large is identical in ASH, PHX, CHI, SEA and NLD:

  | Plan | Price | SKU (ASH) |
  |---|---|---|
  | hourly | $1.27 per hour | BENC-NRSJ-FZOT |
  | 1-month reservation | $804.27 per month | VFSG-SHXD-E8EI |
  | 12-month reservation | $436.59 per month | 7TTJ-XQX8-YR9E |
  | 24-month / 36-month | $394.07 / $360.05 per month | |

  Other items:
  - d3.c1.large metadata: 2 × Xeon Gold 6536, 16 cores each, 256 GB, 2 × 2 TB NVMe, 2 × 25 Gbps.
  - s1.c1.small: $0.16 per hour, $69.29 per month on 12 months.
  - Bandwidth: 15 TB per month free per location, then $0.01 per GB.
  - Public IP blocks: /29 $0.028 per hour, /31 $0.007 per hour.
  - Billing rule (phoenixNAP KB "Bare Metal Cloud Billing Models", found through search): an incomplete hour is
    billed as a full hour, and public IPs are billed hourly whatever the server's model.
  - Not confirmed: whether every server gets a /29 by default.
- **Firecracker:** v1.18.0 jailer documentation and API description (`src/firecracker/swagger/firecracker.yaml`,
  fixture). The CI artifacts, pinned by SHA-256:
  - `firecracker-ci/v1.15/x86_64/vmlinux-6.1.155`: `e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2`. Its config has every option Docker needs
    (the spike's `guest-kernel-docker-check.sh`: 0 missing) and `CONFIG_IP_PNP`.
  - `ubuntu-24.04.squashfs`: `68321e0482baeb3844dafe8a6b08a6902401a7afc41fbfd8c3d9ea08aadd244f`.
- **Engine:** fenvix-engine-cli `claude/shared-cache` `docs/SHARED-CACHE.md` (cache service and client), and
  `claude/runner-node` `runner/bootstrap.sh` (`install` builds the detpy wheel and detjs). The guest pins commit
  `732f4560bcd1ead3433caac44f8a011d3115e2fc`.
- **Reviews:** `docs/REVIEW-R-012.md` (claude/review-r012) and `docs/REVIEW-R-012b.md` (claude/review-r012b).

## Costs (prices DECLARED, read 2026-11-18)

**The first real test:** **≈ $1.30** if the host is ready, runs the 3 jobs and is released within its first billed
hour, **at most ≈ $2.60** if it runs into a second hour. That is d3.c1.large at $1.27 per started hour, plus a /29 at
$0.028 per hour (assumed), with bandwidth and AWS ≈ $0. The script's hold is 60 minutes by default and cannot exceed
180 (≈ $3.90).

**Monthly, per region, hosts on all month** (730 h; IP /29 assumed; AWS ≈ $1.13 per host for 525,600 leases):

| Job hosts | Jobs at once | Hourly | 12-month reservation |
|---|---|---|---|
| 1 | 28 | **$948.67** | **$458.16** |
| 5 | 140 | **$4,743.35** | **$2,290.80** |
| 10 | 280 | **$9,486.70** | **$4,581.60** |

A dedicated cache server adds $137.24 per region hourly or $89.73 on 12 months; colocated adds nothing. With the
scaler, an hourly host costs only the hours it is used: 176 h a month is $223.52. The 12-month reservation is cheaper
above **344 h a month per host (47%)**.

## Not verified, limits and next steps

1. **Everything that needs the real host** (the "Must be checked" list in the doc):
   - Firecracker under the jailer with `--netns`, `--new-pid-ns` and the cgroup v2 parent under the agent's
     `Delegate=yes` subtree. This container has cgroup v1, so `prepare_cgroups` has not run.
   - That `memory.swap.max` exists on the host kernel.
   - The guest boot with `ip=`, reboot ending the VM, Docker in the guest.
   - The install time and the XFS reflink disk.
   - The real timings: queued → leased, leased → microVM up, boot → runner online.
2. **IPv6:** this container's kernel has no IPv6, so the IPv6 drop rules are checked only as text and by `nft -c`,
   not with packets. `probe.sh` checks IPv6 on the first real host.
3. **phoenixNAP specifics to confirm on the first test:**
   - the public IP block a server gets;
   - per-started-hour billing;
   - the user data size limit (ours is about 45 KB);
   - the time from order to `powered-on`;
   - whether 406 is the "no capacity" answer in practice.
4. **The control plane is a public endpoint.** A job can reach it like any website. It cannot use it: the host
   routes need a host credential no job sees, and the summary credential stays on the host. Moving the host routes
   behind mTLS on their own domain would also close that door at the network layer.
5. **Pricing model:** the scaler orders every host with one pricing model (`pnapPricingModel`). Reserved floor hosts
   plus hourly burst hosts need a second setting. A reserved host must never be released (it is billed anyway).
6. **Cache traffic is HTTP**, as in per-job mode: inside the host (colocated) or on the account's private VLAN
   (dedicated). Tokens are per job and expire.
7. **Unused just-in-time runners:** if a host dies after a lease, the requeued job gets a new just-in-time runner. The
   old registration is never used, and GitHub drops it later. The scaler holds no GitHub key, so it cannot delete it.
8. **Release by hand:** the doc and the script say how. Every exit path of the first test releases the host, but a
   killed laptop leaves the hold in place until it expires (60 minutes). After that, the scaler drains the host once it has been idle for 20 minutes, near the end of its paid hour, and then releases it.
