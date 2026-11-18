# Customer mode on phoenixNAP Bare Metal Cloud

From the first paying customer, customer jobs (`runs-on: fenvix`) run on **phoenixNAP Bare Metal Cloud** servers that
we rent **by the hour**, one pool per region. Each job runs in **its own Firecracker microVM on KVM**, under the
jailer, with its own disks and its own network namespace. The microVM and everything it had are deleted after the
job. Demos stay on AWS (demo mode, `docs/DEPLOY-AWS.md`). The control plane stays on AWS Lambda (`github-app/`,
`infra/github-app/`).

**Status: built and tested without a real host.** No phoenixNAP server has been ordered yet. This container has no
`/dev/kvm`, so no Firecracker microVM has booted here either. "The first real test" below does both, in about an hour,
for about $1.30 to $2.60 (at most about $3.90).

## How it works

```
GitHub ── workflow_job.queued ──▶ App (worker Lambda): the installation is linked → placed in its region's queue
                                   (pnap_jobs; region = gh_installations.pnap_region; never another region; a lease
                                   checks the installation's CURRENT region again, and the scaler moves queued jobs
                                   of a customer whose region changed)

scaler Lambda (every minute, one run at a time), per region (one pool):
   desired = clamp(ceil(leasable queued+leased / 15 slots), max(min, hold), max) → orders d3.c1.large (hourly, Ubuntu 24.04)
   with cloud-init user data; drains a host idle ≥ 20 min near the end of its paid hour; releases it once drained;
   releases a host that never enrolled (90 min), went silent (5 min; but never half the fleet at once, which means
   our host route is down: alert instead; and a silent host that reported running jobs and is powered on waits up to
   the job limit, and counts as capacity meanwhile: a region at max orders no replacement), or that phoenixNAP has
   with our prefix but the database does not count as rented (orphan, looked for in every location).
   A region removed from pnapRegions is planned with min = max = 0 until its hosts are gone

phoenixNAP host (d3.c1.large: 2 × Xeon Gold 6536, 32 cores / 64 threads, 256 GB, 2 × 2 TB NVMe):
   cloud-init → /opt/fenvix-host (bundle, SHA-256 checked) → install-host.sh: KVM check, SMT off (no core runs two
   tenants' vCPUs), KSM off, no swap, Firecracker + jailer v1.18.0 (SHA-256 checked), guest kernel and root disk, the
   data disk (an unused NVMe drive under dm-crypt with a key made at each boot and never stored, XFS with reflink),
   nftables, fenvix-agent (which refuses to enrol while SMT, KSM or swap is on, and at each start removes every jail,
   cgroup and namespace an interrupted run left)
   fenvix-agent: POST /v1/hosts/enrol once (single-use secret → host credential), then every 5 s POST /v1/hosts/lease
     → jobs of ITS region only, each minted at that moment: a just-in-time runner (one job), the job's summary
       credential (its runner, repository and run only), its cache token (its customer's cache organization only;
       write only on a trusted ref)
   per job, on a free slot N:
     1. jail /srv/jailer/firecracker/fxsN-j<job>/root, owned by uid 900000+N: reflink copy of the guest root disk,
        read-only input disk (just-in-time config, cache token, plain settings), raw 16 MiB result disk, empty scratch
        disk (Docker data, the runner's work directory)
     2. network namespace fxvmN: tap0 (owned by the jail uid) ↔ guest 172.16.0.2; veth to the host (10.200.x.2/30)
     3. jailer --netns fxvmN --new-pid-ns --cgroup cpu.max/memory.max/pids.max → firecracker --no-api (seccomp on)
        2 vCPU / 8 GiB by default; an I/O limit on each disk; the serial console rate-limited (4 KiB/s) and only its
        last 64 KiB kept by the agent; the agent waits on the microVM's cgroup (the jailer exits once Firecracker is
        cloned); the guest runs exactly one job, writes its result record, reboots (VM exits)
     4. the result is opened without following anything the jail uid controls, parsed by fenvix-parse; the summary
        is sent by fenvix-post with the job's own credential and the host's own ids
     5. everything of the job is deleted on every path (namespace, jail, cgroup, credential file, conntrack entries)

shared cache, per region next to the runners: "colocated" (a cache in its own namespace on each host; the first test)
or "dedicated" (one s1.c1.small per region on the region's private network). One organization per customer
installation (gh-<installation id>), per-job RSA-signed tokens; the cache holds only the public key.
```

### Isolation: the review findings, translated from Nitro Sandboxes to KVM

| Finding | What it asked | Here | Tested by |
|---|---|---|---|
| F9 | never mount a guest disk; ids from the host's record | raw result disk, length-prefixed record, size cap, parsed as `fenvix-parse`; ids and runner name from the lease | `tests/test_job.py` (the guest's `repositoryId` is ignored), `tests/test_result.py` |
| F10 | firewall keyed on the interface; FORWARD drop; IPv6 off; per-sandbox limits | host table `inet fenvix`: forward policy drop, `iifname . saddr` bound per slot, input drop from `fxv*`, private/link-local/metadata/host addresses dropped, the cache's one port allowed, conntrack count and new-connection rate per microVM, Firecracker rate limiters; IPv6 disabled and dropped | `tests/test_isolation_netns.py` (real packets), `tests/test_rules.py` |
| F11 | memory pool (Nitro) | n/a on KVM; slots are computed so neither physical cores nor memory are overcommitted (15 per d3.c1.large) | `tests/unit/pnap.test.ts` |
| F12 | no runner registered before capacity | a just-in-time runner is made only when a host of the region leases the job | `tests/integration/pnap.test.ts` |
| F13 | demo scope | unchanged; an installation without a region is never placed | integration test |
| F15 | secret rotation | host keys: `host-signing-key` + `host-signing-key-previous`, reloaded every 5 min like the others | `tests/unit/pnap.test.ts` |
| F16 | capacity by physical cores | SMT off on every host (install-host.sh; the agent refuses to enrol otherwise), one vCPU per physical core, 2 cores and 16 GiB kept for the host (R-014 R2) | `tests/unit/pnap.test.ts`, `tests/unit/review-r014.test.ts`, `tests/test_review_r014.py`, `tests/test_hardening.py` |
| F17 | jailer, no root, nothing of ours on the guest's path | jailer per job (own uid/gid per slot, chroot, new PID namespace, cgroup v2, seccomp on, no API socket); the host credential is in a root-only file read by the agent only | `tests/test_rules.py`, `tests/test_job.py` |
| N1 | read the result without following the jail uid's symlink | `O_NOFOLLOW` open relative to the root-owned parent, `fstat`: regular file, jail uid, 1 link, exact size; FIFO cannot block | `tests/test_result.py`, `tests/test_job.py` (escaped-VMM symlink attack) |
| N3 | the jailed VMM must not reach credentials | each VMM is in its slot's network namespace, whose own input and output policies are drop; phoenixNAP has no metadata service, and 169.254.0.0/16 is dropped anyway | `tests/test_isolation_netns.py` (`vmm_namespace_itself_*`) |

All test paths above are under `infra/customer-mode/pnap/` or `github-app/`.

**What the job can reach:** the internet (packages, git, GitHub), and its region's cache on one port. **Not:** the
host (any address, any port), another microVM, the slot's own namespace, phoenixNAP's private network (other than
the cache), link-local and metadata addresses, IPv6.

**What the job holds:** a single-use just-in-time runner config and its cache token (one customer organization,
read-only unless the ref is trusted, expires). No long-lived secret. The summary credential stays on the host side,
with `fenvix-post`.

**The control plane is public on the internet** (API Gateway). From inside a job it can be reached like any website.
Its host routes need a host credential, which no job ever sees. The summary route needs the job's summary
credential, which stays on the host. Blocking the API's addresses at the network layer is not possible: they are
shared by API Gateway.

## The founder's steps

### 1. phoenixNAP account and API client

1. Sign up for Bare Metal Cloud (bmc.phoenixnap.com, "Sign Up") and add a payment method.
2. In the BMC portal, check **Quotas** (or `GET /bmc/v1/quotas`): the server quota must allow at least the hosts you
   plan per region (the first test needs 1). Ask for more with "Request edit" if needed.
3. **API Credentials → Create Credentials**. Name it `fenvix-prod-scaler`, permission **bmc** (read and write: it
   orders and releases servers). Copy the **Client ID** and **Client Secret** once.
4. Optional: **SSH Keys → Add** your own public key and mark it default, so that you can log in to a host to debug.
   Every server gets the account's default keys. The agent itself needs no inbound port.

### 2. Secrets in SSM (your laptop, as the deployer)

None of these is ever in git, in cdk.json or in a Lambda environment variable.

```
aws ssm put-parameter --type SecureString --name /fenvix/prod/pnap/client-id     --value '<Client ID>'
read -rsp "phoenixNAP client secret: " v; echo
aws ssm put-parameter --type SecureString --name /fenvix/prod/pnap/client-secret --value "$v"; unset v
aws ssm put-parameter --type SecureString --name /fenvix/prod/github-app/host-signing-key --value "$(openssl rand -hex 32)"
# The cache signing key, if it does not exist yet (demo mode does not need it): prints cdk.json's cacheSigningPublicKey
bash infra/github-app/scripts/cache-key.sh
```

| Parameter | Read by | What |
|---|---|---|
| `/fenvix/prod/pnap/client-id`, `/fenvix/prod/pnap/client-secret` | scaler only | the phoenixNAP API client |
| `/fenvix/prod/github-app/host-signing-key` (`-previous` while rotating) | hosts function only | signs and verifies host credentials |
| `/fenvix/prod/cache/signing-key` | hosts function (and the per-job worker) | signs per-job cache tokens |
| `/fenvix/prod/github-app/{database-url, private-key, runner-token}` | already there | the hosts function also reads these |

### 3. The database

In the Supabase SQL editor, paste and run `supabase/migrations/0014_pnap_customer_mode.sql`. It is safe to repeat. It
adds `gh_installations.pnap_region`, `pnap_hosts`, `pnap_jobs` and `pnap_region_holds`, readable only by the App's
role.

### 4. The AWS policies (an admin, once)

`permissions-boundary.json` now also allows `/fenvix/prod/pnap/*` parameters, and `deploy-policy.json` lets the deployer
invoke the scaler function by hand (the first test does). Update both managed policies with a new default version:

```
cd infra/github-app
aws iam create-policy-version --policy-arn arn:aws:iam::865859654353:policy/fenvix-prod-github-app-boundary --policy-document file://permissions-boundary.json --set-as-default
aws iam create-policy-version --policy-arn arn:aws:iam::865859654353:policy/<the deployer policy of DEPLOY-AWS.md step 10> --policy-document file://deploy-policy.json --set-as-default
```

(A managed policy keeps at most 5 versions; delete the oldest one first if the call says so.)

### 5. Settings and deploy

The Firecracker release archive's SHA-256: download `firecracker-v1.18.0-x86_64.tgz` from
github.com/firecracker-microvm/firecracker/releases/tag/v1.18.0 and run `sha256sum` on it (or compare with the
`.sha256.txt` published next to it). Every host checks its own download against this value.

In `infra/github-app/cdk.json` (context):

| Setting | First test | Meaning |
|---|---|---|
| `customerMode` | `pnap` | adds the scaler and hosts functions and the `/v1/hosts/*` route (`off` by default) |
| `pnapRegions` | `ASH:0:1` | `REGION:MIN:MAX,...` of ASH (Ashburn), PHX (Phoenix), CHI (Chicago), SEA (Seattle), NLD (Amsterdam); one pool each |
| `pnapDefaultRegion` | empty | region of an installation that has none set (empty: such jobs are not placed) |
| `pnapServerType` | `d3.c1.large` | |
| `pnapPricingModel` | `HOURLY` | what the scaler orders |
| `pnapVmVcpus`, `pnapVmMemMib` | `2`, `8192` | one microVM; 15 per d3.c1.large (one vCPU per physical core) |
| `pnapIdleMinutes` | `20` | an idle host is drained after this, near the end of its paid hour |
| `pnapMaxHostsTotal` | `10` | across all regions: the cost ceiling |
| `pnapCacheMode` | `colocated` | `colocated`, `dedicated` (one s1.c1.small per region) or `off` |
| `pnapFirecrackerSha256` | the value above | |
| `pnapSshKeyIds` | empty | phoenixNAP SSH key ids to add to every server (optional) |
| `cacheSigningPublicKey` | from `cache-key.sh` | |

Customer mode runs beside demo mode (`runnerMode` stays `demo`). Then deploy as usual (`bash scripts/deploy.sh`,
DEPLOY-AWS.md step E). The stack gains `fenvix-prod-github-app-hosts`, `fenvix-prod-github-app-scaler` (with a
one-minute schedule and reserved concurrency 1) and the route `POST /v1/hosts/{proxy+}`.

### 6. Two test organizations

1. Create two GitHub organizations (free plan), e.g. `fenvix-test-a` and `fenvix-test-b`, each with one private
   repository (`fenvix-test`).
2. Into each repository, commit the workflow that the script prints:
   `bash infra/customer-mode/pnap/first-test/first-test.sh --print-workflow > .github/workflows/fenvix-first-test.yml`.
   It carries `probe.sh` inline (the test repositories cannot read fenvix-app, which is private) and checks it
   against its SHA-256 before running it. Print and commit it again whenever `probe.sh` changes.
3. Install the App on both organizations (that repository only). Link each installation to its own fenvix
   organization in the dashboard (two test accounts), as a customer would.
4. Note both installation ids: the number at the end of `https://github.com/organizations/<org>/settings/installations/<id>`.

### 7. The first real test (one command)

```
bash infra/customer-mode/pnap/first-test/first-test.sh --region ASH \
  --repo-a fenvix-test-a/fenvix-test --installation-a <id A> \
  --repo-b fenvix-test-b/fenvix-test --installation-b <id B>
```

It asks for confirmation (`--yes` skips it), then:

1. puts both installations in the region (`set-region`);
2. holds one host there for 60 minutes (`hold`): the scaler orders one d3.c1.large;
3. waits until the host is ready (phoenixNAP provisioning, then our install, including building the guest image, then
   enrolment) and prints how long that took;
4. dispatches 3 runs: 2 in organization A and 1 in organization B;
5. waits for them, then reads each job's log. `probe.sh` checks, from inside each microVM:
   - the internet, the shared cache with its own token, and Docker work;
   - the metadata address, the slot's gateway, the host's link and public addresses, other microVMs' addresses,
     private networks, the cache's other ports, a forged cache token for another organization, and IPv6 do not;
6. reads the timings of each job from the job record: queued → leased, leased → microVM up, microVM lifetime;
7. checks that the two organizations got two different cache organizations;
8. **releases the host on every exit path** (including Ctrl-C and errors) and waits until no host of the region is
   live;
9. writes `fenvix-first-test-<time>.md` with the table, every probe line and `Result: PASS` or `FAIL`.

Afterwards, in the BMC portal: no server named `fx-prod-*`; under **Billing → Rated Usage**, the hours charged.

If something fails: scaler log `/aws/lambda/fenvix-prod-github-app-scaler`, hosts log `.../hosts`, and on the host
(while it lives; `ssh ubuntu@<public IP>` with your key) `/var/log/fenvix-install.log` and
`journalctl -u fenvix-agent`. To release by hand: `aws lambda invoke --function-name fenvix-prod-github-app-scaler
--cli-binary-format raw-in-base64-out --payload '{"action":"release","region":"ASH"}' out.json`.

### Expected cost of the first test (prices DECLARED, read 2026-11-18)

| Item | Price | First test |
|---|---|---|
| d3.c1.large, hourly, ASH (same in PHX, CHI, SEA, NLD) | $1.27 per hour; each started hour is billed as a full hour | 1 hour if ready + 3 jobs + release fit in 60 min after provisioning; 2 if not; 3 at most by the script's own deadlines |
| public IPv4 block | $0.028 per hour for a /29 (assumed allocated with each server; a /31 is $0.007) | 1 to 3 hours |
| bandwidth | 15 TB per month free per location, then $0.01 per GB | $0 |
| Ubuntu | free | $0 |
| AWS (Lambda, API Gateway, the hold's scaler runs) | cents | ≈ $0 |
| **Total** | | **≈ $1.30 (1 hour) to $2.60 (2 hours) in the likely case; at most ≈ $3.90 (3 started hours)** by the script's own deadlines: 90 minutes to wait for a ready host, 40 for the runs, 20 for the release. If the laptop dies mid-test, the hold keeps the host `--minutes` (default 60), then the scaler drains it at the end of its paid hour: ≈ $2.60 at 60, ≈ $5.20 (4 started hours) at the maximum of 180. |

The time to ready is an ESTIMATE until measured: phoenixNAP's provisioning (minutes), then our install. The install
builds the guest image on the host (apt, the engines' bootstrap, which compiles the detpy wheel and detjs), probably
15 to 30 minutes on 32 cores (SMT is off). A prebuilt guest image (`PNAP_GUEST_IMAGE_URL`) would cut this.

## Monthly cost per region (prices DECLARED, read 2026-11-18; 730 hours a month)

phoenixNAP's price list (`phoenixnap.com/wp-json/pnap/v1/bmc-pricing`, the data behind
phoenixnap.com/bare-metal-cloud/instances) is the same in ASH, PHX, CHI, SEA and NLD:

| d3.c1.large | Price |
|---|---|
| hourly | $1.27 per hour |
| 1-month reservation | $804.27 per month |
| **12-month reservation** | **$436.59 per month** |
| 24-month / 36-month | $394.07 / $360.05 per month |
| s1.c1.small (dedicated cache server): hourly / 12-month | $0.16 per hour / $69.29 per month |

Hosts kept on all month (no scaling down):

A d3.c1.large runs **15 jobs at once** (2 vCPU / 8 GiB each): one vCPU per physical core with SMT off, 2 cores kept
for the host (R-014 R2: two customers' vCPUs never share a core; Firecracker's production guidance). Memory would
allow 28.

| Job hosts in the region | Jobs at once (2 vCPU / 8 GiB) | Hourly, 730 h | 12-month reservation |
|---|---|---|---|
| 1 | 15 | $927.10 + IP $20.44 + AWS $1.13 = **$948.67** | $436.59 + $20.44 + $1.13 = **$458.16** |
| 2 | 30 | **$1,897.34** | **$916.32** |
| 5 | 75 | $4,635.50 + $102.20 + $5.65 = **$4,743.35** | $2,182.95 + $102.20 + $5.65 = **$2,290.80** |
| 10 | 150 | $9,271.00 + $204.40 + $11.30 = **$9,486.70** | $4,365.90 + $204.40 + $11.30 = **$4,581.60** |
| 19 | 285 | **$18,024.73** | **$8,705.04** |
| dedicated cache server (optional), per region | | $116.80 + $20.44 = $137.24 | $69.29 + $20.44 = $89.73 |

- **Per job slot (one job at once, all month):** $948.67 / 15 = **$63.24** hourly, $458.16 / 15 = **$30.54** reserved.
  (Before R-014, counted in hardware threads with SMT on: 28 slots, $33.88 and $16.36. That doubled up two tenants on
  a core.) The earlier 28 / 140 / 280 jobs at once now take **2 / 10 / 19 hosts**.
- Core scheduling (`prctl(PR_SCHED_CORE)` per microVM) could keep SMT on and about 28 slots per host, safely. It needs
  care and a measurement on the real host: not built.

- IP: one /29 per server at $0.028/h (an assumption; check what the first test's server gets).
- AWS: each host leases every 5 s, which is 525,600 requests a month. That is $0.58 of API Gateway, $0.11 of Lambda
  requests and about 26,000 GB-s ($0.44) beyond the free tier. The scaler adds 43,800 runs a month, about $0.01.
- Bandwidth: free up to 15 TB a month per location.
- **Hourly with the scaler costs only the hours used.** For example, 1 host × 8 h × 22 working days = 176 h = $223.52.
  The 12-month reservation is cheaper above **344 hours a month (47% of the month)** per host. The rule: keep the
  region's `min` hosts on 12-month reservations once the load is steady, and burst on hourly hosts.
- Not built yet: the scaler orders every host with one pricing model (`pnapPricingModel`). Mixing reserved floor hosts
  with hourly burst hosts needs a separate setting, and a reserved host must never be released (it is billed anyway).
  This is the first follow-up once a region has steady load.

## Operations

- **Where a customer's jobs run:** `aws lambda invoke --function-name fenvix-prod-github-app-scaler --cli-binary-format
  raw-in-base64-out --payload '{"action":"set-region","installationId":123,"region":"NLD"}' out.json`. Without a region
  (and no `pnapDefaultRegion`), the customer's jobs wait and are never placed elsewhere.
- **What runs:** `{"action":"status"}` lists hosts and the last day's jobs, with outcomes and timings.
- **Release a region:** `{"action":"release","region":"ASH"}` drains its hosts; the scaler releases them once empty.
- **Rotate the host signing key:** put the current value in `host-signing-key-previous`, a new one in
  `host-signing-key`, wait 5 minutes (the functions reload secrets), and remove the previous one after 12 hours (a
  host credential's lifetime). Hosts renew their credential on every lease.
- **Revoke one host:** set it to `releasing` in `pnap_hosts` (the next scaler run releases it, and its credential
  generation is bumped).
- **Update the host software:** change the code, run `python3 -I infra/customer-mode/pnap/bundle.py`, and deploy. New
  hosts get the new bundle. Existing hosts keep theirs until they are released.

## Tests (no real host needed)

| Suite | Command | What |
|---|---|---|
| host side (Python) | `python3 -I -m unittest discover -s infra/customer-mode/pnap/tests` (root, for the namespace tests) | generated rules (nftables, jailer cgroups, uids, seccomp flags, Firecracker config valid against v1.18.0's API description), real-packet isolation in network namespaces (4 scenarios), one job end to end with a fake jailer (disks, TAP of the jail uid, safe result read, summary post, cleanup, symlink attack), the agent, the first-test script with stand-ins for aws and gh |
| control plane | `cd github-app && npm test` (scratch Postgres) | placement by region, scaler planning and runs, enrolment, leases, credentials, user data, the API client against a fake built from phoenixNAP's OpenAPI descriptions |
| infra | `cd infra/github-app && npm test` | the new functions, what each reads, the route, the schedule, cdk-nag |

## Must be checked on the first real host

1. The install: the time to ready, the guest image build on the host, the XFS reflink disk.
2. Firecracker v1.18.0 under the jailer with `--netns`, `--new-pid-ns` and the cgroup v2 parent of the agent's
   delegated subtree (`Delegate=yes`): the microVM boots, and the kernel `ip=` argument brings `eth0` up.
3. The guest's runner takes exactly one job, Docker works (iptables-legacy), and the result record comes back.
4. The probes (`probe.sh`): all as expected from inside real microVMs.
5. Timings: queued → leased (scaler and lease interval), leased → microVM up (reflink copy, mkfs of the input and
   scratch disks), boot → runner online.
6. Billing: what the server's public IP block is, and that an incomplete hour is billed as one.
7. Host hygiene (R-014 R2): `/sys/devices/system/cpu/smt/active` is 0 after the install and after a reboot (tmpfiles
   and `nosmt`), KSM off, no swap; `grep . /sys/devices/system/cpu/vulnerabilities/*` (in the install log) shows only
   "Not affected" or "Mitigation"; the microcode is current.
8. Serial flood (R-014 R1): inside a job, `cat /dev/zero > /dev/ttyS0` for 10 minutes; the agent's memory stays flat,
   the other microVMs are unaffected. That Firecracker v1.18.0 accepts the `serial` section of the configuration file
   (it validates against the API description; the config-file key is the reviewer's reading of the sources).
9. The agent waits for the microVM itself (`cgroup.events`, and end of file on the VMM's output), not for the jailer,
   which exits once it has cloned Firecracker under `--new-pid-ns`.
10. Non-root steps (R-014 R3): the summary appears on the pull request; `fenvix-cache.service` is active and reads its key.
11. Data disk (R-014 R4): `fenvix-data.service` opens the drive with dm-crypt and a per-boot key; restart the agent
    and reboot the host in the middle of a job: afterwards no jail, namespace, cgroup or conntrack entry is left. If
    phoenixNAP's image uses both drives (software RAID), there is no free drive: jobs' disks are then on the root
    filesystem, unencrypted, and removed by the agent at start.
    The caches (`/var/lib/fenvix-cache`, and the dedicated cache server's disk) are NOT on dm-crypt: confirm
    phoenixNAP's disk wipe on deprovision before the first customer (R-014b note 2).
12. The ruleset stays loaded after a reboot and an `apt upgrade` (the agent reloads it on every lease round if not).
13. Noisy neighbours (R-014 R10): `fio` in one job and a SYN flood in another while a third job's timings are measured.
14. Control-plane outage (R-014 R7): stop the hosts function for 6 minutes during a job: nothing is released, and the
    scaler logs an ALERT.
