# Machines: providers, prices, limits and isolation (linux x86-64)

**All prices are list prices read on one date, 2026-11-23, not quotes.** USD before tax unless marked €. Every
number names its source; `UNKNOWN` = not found on a page this review could read; `ESTIMATED` = derived, arithmetic
shown; `SNIPPET` = seen only in a search-result summary because the page itself could not be opened from this session
(treat as unverified). arm64 is out of scope (the engine's go-live scope is x86-64).

**Currency.** Hetzner and OVHcloud price in EUR. No exchange-rate source was reachable from this session (ECB and
x-rates did not resolve). Conversions use **1 € = $1.10 (ASSUMED, not read; recompute with the day's rate)**; every
converted figure shows the € price it came from.

**Slot** (for comparing machines of different sizes) = 2 hardware threads + 4 GiB, the shape of today's `c6i.large`
job. Slots on a machine used as a microVM host (ESTIMATED) = min(⌊(threads − 2) ÷ 2⌋, ⌊(RAM GB − 8) ÷ 4⌋): 2 threads
and 8 GB kept for the host (Firecracker's ≤ 5 MiB per microVM is negligible). A 2-vCPU VM used one per job = 1 slot.
**$/slot-hour** = price per hour ÷ slots. Faster CPUs (Zen 4/5 desktop parts vs Ice Lake) would run the same tests
faster per slot; that is not modeled (no benchmark in this review).

## Sources (all read 2026-11-23)

| Key | URL |
|---|---|
| AWS-EC2 | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/eu-west-1/index.csv (publication 2026-11-21); billing: https://aws.amazon.com/ec2/pricing/on-demand/ |
| AWS-Q | https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html |
| AWS-DT | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/eu-west-1/index.json |
| AWS-ST | https://aws.amazon.com/service-terms/ (updated 2026-11-19); https://aws.amazon.com/aup/ (updated 2021-07-01) |
| AWS-NV | https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html |
| AWS-BATCH | https://docs.aws.amazon.com/batch/latest/userguide/when-to-use-fargate.html |
| P1-P6 | phoenixNAP: https://phoenixnap.com/bare-metal-cloud/instances (P1), https://phoenixnap.com/bare-metal-cloud (P2), https://phoenixnap.com/kb/bare-metal-cloud-portal-quick-start-guide (P3), https://phoenixnap.com/kb/phoenixnap-bare-metal-cloud-billing-models (P4, dated 2020-10-30), https://phoenixnap.com/blog/bare-metal-cloud-bandwidth-packages (P5), https://phoenixnap.com/cs/legal/aup.html (P6) |
| HC | Hetzner Cloud: https://www.hetzner.com/cloud/regular-performance, https://www.hetzner.com/cloud/general-purpose, https://www.hetzner.com/cloud/cost-optimized, https://docs.hetzner.com/cloud/billing/faq/, https://docs.hetzner.com/cloud/servers/faq/, https://docs.hetzner.com/cloud/servers/overview/ |
| HD | Hetzner dedicated: https://www.hetzner.com/dedicated-rootserver/matrix-ax/, https://www.hetzner.com/dedicated-rootserver/ax42/, https://docs.hetzner.com/general/infrastructure-and-availability/order-processing/ (changed 2026-11-17), https://docs.hetzner.com/general/billing-and-account-management/cancellation/cancellations-robot/, https://robot.hetzner.com/doc/webservice/en.html |
| HT | Hetzner terms: https://www.hetzner.com/legal/terms-and-conditions/ (v2.0.1, 2026-11-17), https://www.hetzner.com/legal/cloud-server/, https://www.hetzner.com/legal/dedicated-server/, https://www.hetzner.com/legal/system-policies/; price changes: https://www.hetzner.com/pressroom/standardization-and-price-adjustment-of-our-server-products/ |
| OVH | OVHcloud docs source https://github.com/ovh/docs (commit 989d55b): Public Cloud billing, quota, savings plans, API rate-limit guides. Prices SNIPPET only (https://www.ovhcloud.com/en-ie/public-cloud/prices/ did not open: redirect loop) |
| L1-L12 | Latitude.sh: https://www.latitude.sh/pricing (L1), https://www.latitude.sh/docs/billing/on-demand-vs-reserved.md (L2), https://www.latitude.sh/docs/usage/bandwidth.md (L3), https://www.latitude.sh/docs/account-setup/verify-account.md (L6), https://www.latitude.sh/docs/servers/instant-deployment.md (L7), https://www.latitude.sh/docs/regions-locations.md (L8), https://www.latitude.sh/legal/terms (L12: points to the Megaport Global Services Agreement, which did not open) |
| C1-C8 | Cherry Servers: https://www.cherryservers.com/bare-metal-dedicated-servers/instant-servers (C1), https://www.cherryservers.com/pricing/dedicated-servers (C2), https://www.cherryservers.com/network/bandwidth-plans (C4), https://www.cherryservers.com/legal/terms-of-service (C5), https://www.cherryservers.com/knowledge/docs/compute/dedicated-servers (C6), https://www.cherryservers.com/knowledge/docs/usage-billing/payment-options (C7) |
| V1-V5 | Vultr: https://docs.vultr.com/support/platform/billing/how-am-i-billed-for-my-servers.md (V1), https://docs.vultr.com/products/compute/bare-metal/provisioning (V2); plan prices only from third-party pages (V5: https://stackfreeks.com/vultr-pricing-2026/, https://www.techplained.com/best-bare-metal-cloud; vultr.com did not open) |
| GH | https://docs.github.com/en/billing/reference/actions-runner-pricing |

## Machine table

Provider-wide columns (billing, commitment, ready time, API, EU, egress, quota, terms) are stated once per provider
in the provider summary below the table and apply to every row of that provider.

| Provider | Machine | vCPU / threads | RAM GB | CPU model | $/hour | $/vCPU-min | Slots | $/slot-hour | Source |
|---|---|---|---|---|---|---|---|---|---|
| AWS EC2 on-demand | c6i.large | 2 | 4 | Xeon 8375C (Ice Lake) | 0.0912 | 0.0912/2/60 = 0.000760 | 1 (per job) | 0.0912 (+ IPv4 0.005 + disk) | AWS-EC2 |
| AWS EC2 | c6i.xlarge | 4 | 8 | Xeon 8375C | 0.1824 | 0.000760 | 1 | 0.1824 | AWS-EC2 |
| AWS EC2 | c6i.4xlarge | 16 | 32 | Xeon 8375C | 0.7296 | 0.000760 | 6 (microVM host; needs nested virt, not listed for c6i in AWS-NV → UNKNOWN) | 0.1216 | AWS-EC2 |
| AWS EC2 | c7i.large | 2 | 4 | Xeon (Sapphire Rapids) | 0.09576 | 0.000798 | 1 | 0.0958 | AWS-EC2 |
| AWS EC2 | c7i.2xlarge | 8 | 16 | Sapphire Rapids | 0.38304 | 0.000798 | 2 (formula); 3 per the Customer-mode design (`DEPLOY-AWS.md:766`, 2 GiB jobs) | 0.1915 (0.1277 at 3) | AWS-EC2 |
| AWS EC2 | c7i.4xlarge | 16 | 32 | Sapphire Rapids | 0.76608 | 0.000798 | 6 (nested virt supported on C7i, AWS-NV) | 0.1277 | AWS-EC2 |
| AWS EC2 | c7i.metal-48xl | 192 | 384 | Sapphire Rapids | 9.19296 | 0.000798 | 94 | 0.0978 | AWS-EC2 |
| AWS EC2 | c7a.large | 2 | 4 | AMD EPYC 9R14 | 0.11012 | 0.000918 | 1 | 0.1101 | AWS-EC2 |
| AWS EC2 | c7a.4xlarge | 16 | 32 | EPYC 9R14 | 0.88096 | 0.000918 | 6 (nested virt: Intel only per AWS-NV → not on c7a) | 0.1468 | AWS-EC2 |
| AWS EC2 | c7a.metal-48xl | 192 | 384 | EPYC 9R14 | 10.57152 | 0.000918 | 94 | 0.1125 | AWS-EC2 |
| AWS EC2 spot | all of the above | | | | **UNKNOWN** (AWS's spot feed and the mirrors were blocked by this session's network; one unverified snippet gives c7i.large ≈ $0.039-0.043) | UNKNOWN | | UNKNOWN | — |
| phoenixNAP BMC | s0.d1.small (cheapest x86) | 4c/8t (UNVERIFIED, CPU spec not read) | 16 | Xeon E3-1240 v3 (2013) | 0.08 | 0.08/8/60 = 0.000167 | 2 | 0.0400 | P1 |
| phoenixNAP | s2.c1.small | 6c [SNIPPET] /12t (UNVERIFIED) | 64 | Xeon E-2356G | 0.17 | 0.000236 | 5 | 0.0340 | P1 |
| phoenixNAP | s3.c3.medium | 24c/32t (UNVERIFIED) | 128 | Core i9-14900K | 0.47 | 0.000245 | 15 | 0.0313 | P1 |
| phoenixNAP | s4.c6.xlarge | 16c/32t (UNVERIFIED) | 192 | EPYC 4565P | 0.77 (page shows price inversions; re-check) | 0.000401 | 15 | 0.0513 | P1 |
| phoenixNAP | d3.c6.medium | 72c/144t (UNVERIFIED) | 128 | 2× Xeon Platinum 8452Y | 1.47 | 0.000170 | 30 (RAM-bound) | 0.0490 | P1 |
| phoenixNAP | d3.m6.xlarge | 72c/144t (UNVERIFIED) | 512 | 2× Xeon Platinum 8452Y | 1.92 | 0.000222 | 71 | **0.0270** | P1 |
| Hetzner Cloud | CPX22 (shared vCPU) | 2 | 4 | "AMD" (model UNKNOWN) | €0.0272 → 0.0299 | 0.000249 | 1 (per job) | 0.0299 | HC |
| Hetzner Cloud | CPX62 (shared) | 16 | 32 | AMD | €0.1779 → 0.1957 | 0.000204 | 6 (microVM host only if nested virt is exposed: UNKNOWN) | 0.0326 | HC |
| Hetzner Cloud | CCX13 (dedicated vCPU) | 2 | 8 | AMD | €0.0593 → 0.0652 | 0.000544 | 1 | 0.0652 | HC |
| Hetzner Cloud | CCX33 | 8 | 32 | AMD | €0.1891 → 0.2080 | 0.000433 | 3 | 0.0693 | HC |
| Hetzner Cloud | CCX63 | 48 | 192 | AMD | €1.1626 → 1.2789 | 0.000444 | 23 | 0.0556 | HC |
| Hetzner dedicated | AX41 | 6c/12t (ESTIMATED, SMT) | 64 | Ryzen 5 3600 (Zen 2) | €59/month ÷ 730 = €0.0808 → 0.0889 (page hourly €0.0945) | 0.000123 | 5 | 0.0178 | HD |
| Hetzner dedicated | AX42 | 8c/16t (ESTIMATED) | 64 | Ryzen 7 PRO 8700GE (Zen 4) | €99/month → 0.1492 (hourly €0.1586) + setup €49 | 0.000155 | 7 | 0.0213 | HD |
| Hetzner dedicated | AX102 | 16c/32t (ESTIMATED) | 128 | Ryzen 9 7950X3D (Zen 4) | €159/month → 0.2396 (hourly €0.4150) + setup €129 | 0.000125 | 15 | **0.0160** | HD |
| Hetzner dedicated | AX162 (128 GB) | 48c/96t (ESTIMATED) | 128 | EPYC 9454P (Zen 4) | €319/month → 0.4807 (hourly €0.9840) + setup €304 | 0.000083 | 30 (RAM-bound) | **0.0160** | HD |
| Hetzner dedicated | AX162 (512 GB) | 48c/96t | 512 | EPYC 9454P | €614/month → 0.9252 | 0.000161 | 47 | 0.0197 | HD |
| OVHcloud Public Cloud | c3-4 | 2 [SNIPPET] | 4 | UNKNOWN | €0.0457 [SNIPPET] → 0.0503 | 0.000419 | 1 | 0.0503 | OVH |
| OVHcloud | c3-16 | 8 [SNIPPET] | 16 | UNKNOWN | €0.1825 [SNIPPET] → 0.2008 | 0.000418 | 2 | 0.1004 | OVH |
| OVHcloud | b3-8 | 2 | 8 | UNKNOWN | €0.0512 [SNIPPET] → 0.0563 | 0.000469 | 1 | 0.0563 | OVH |
| OVHcloud Bare Metal | Rise / Advance / Scale | UNKNOWN | UNKNOWN | UNKNOWN | EUR UNKNOWN (US site SNIPPET: Advance-1 $204/month + $204 setup) | UNKNOWN | UNKNOWN | UNKNOWN | OVH |
| Latitude.sh | m4.metal.small | 6c/12t (ESTIMATED) | 48 | EPYC 4244P | 0.41 | 0.000569 | 5 | 0.0820 | L1 |
| Latitude.sh | m4.metal.medium | 16c/32t (ESTIMATED) | 128 | EPYC 9124 | 0.62 | 0.000323 | 15 | 0.0413 | L1 |
| Latitude.sh | c4.metal.large | 96c/192t (ESTIMATED) | 384 | EPYC 9655P | 4.00 | 0.000347 | 94 | 0.0426 | L1 |
| Cherry Servers | Ryzen 9 9950X, hourly | 16c/32t | 128 | Ryzen 9 9950X (Zen 5) | 0.70 | 0.000365 | 15 | 0.0467 | C1 |
| Cherry Servers | Ryzen 9 9950X, monthly billing | 16c/32t | 128 | Ryzen 9 9950X | $347.08/month ÷ 730 = 0.4755 | 0.000248 | 15 | **0.0317** | C1 |
| Cherry Servers | Threadripper Pro 7965WX | 24c/48t | 512 | TR Pro 7965WX | 1.961 | 0.000681 | 23 | 0.0853 | C1 |
| Cherry Servers | EPYC 9375F, monthly billing | 32c/64t | 384 | EPYC 9375F | $983.56/month ÷ 730 = 1.3473 (hourly 1.981) | 0.000351 | 31 | 0.0435 | C1 |
| Vultr Bare Metal | E3-1270 | 4c/8t [V5] | 32 | Xeon E3-1270 v6 | $120/month ÷ 672 h = 0.1786 [V5, third party] | 0.000372 | 3 | 0.0595 | V1, V5 |
| Vultr Bare Metal | EPYC 9254 | 24c/48t [V5] | 384 | EPYC 9254 | $825/month ÷ 672 = 1.2277 [V5] | 0.000426 | 23 | 0.0534 | V1, V5 |
| Equinix Metal | — | | | | **Shut down 2026-06-30** (SNIPPET: docs.equinix.com/metal/eos-faq) | | | | — |
| **Benchmark: GitHub-hosted** | Linux 2-core x64 | 2 | (not stated here) | — | $0.006/min = 0.36 | 0.003000 | 1 | **0.36** | GH |
| GitHub-hosted | Linux 1-core (slim) / 4 / 8 / 16 / 32 / 64-core x64 | 1 / 4 / 8 / 16 / 32 / 64 | | — | $0.002 / 0.012 / 0.022 / 0.042 / 0.082 / 0.162 per min | 0.002 / 0.003 / 0.00275 / 0.00263 / 0.00256 / 0.00253 | | 0.36 per 2 cores (4-core: 0.72 ÷ 2) | GH |

## Provider summary (the columns that are the same for every machine of a provider)

| Provider | Billing granularity | Minimum commitment | API request → ready | Provisioning API | EU regions | Egress | New-account quota | Terms on customers' code |
|---|---|---|---|---|---|---|---|---|
| **AWS EC2** on-demand / spot | Per second, 60 s minimum (Linux) [AWS-EC2] | None; spot can be interrupted | UNKNOWN (no official figure; "a few minutes" to spin up a new instance [AWS-BATCH]); repo ESTIMATE 45-75 s to job start | EC2 API, CDK (in use) | Ireland eu-west-1 (today's, `cdk.json:17`) and Frankfurt eu-central-1 (both in the RDS price files read for `API-DB.md`); full EU list not read in this review | 100 GB/month free (all AWS), then $0.09/GB to 10 TB [AWS-DT]; public IPv4 $0.005/h | **5 vCPUs** On-Demand Standard and 5 vCPUs Spot by default, adjustable, raised automatically with usage [AWS-Q] | Allowed; you answer for end users: AUP bars "facilitate or allow others to use" for illegal or abusive use; Service Terms §1.25 bans crypto mining by you or End Users [AWS-ST] |
| **phoenixNAP BMC** | Hourly; "each incomplete hour is charged as a full hour", 1-hour minimum [P4] | None (reservations 1-36 months, "up to 30%" off [P2]) | "one to fifteen minutes, depending on the OS" [P3] | REST API, pnapctl, Terraform [P2] | **Amsterdam** only; which types are offered there: UNKNOWN (portal only) | 15 TB free per location, then $0.01/GB (example) [P2, P5] | **5 servers** by default [P3] | Not prohibited: "Client is responsible for all use of its own account(s)" (§1.3); resale barred only to Spamhaus-listed parties (§6.5) [P6] |
| **Hetzner Cloud** | Hourly, rounded up, capped at the monthly price; billed until deleted [HC] | None | UNKNOWN in docs; SNIPPET ≈ 25-40 s to SSH-ready | REST API, `hcloud` CLI | Nuremberg, Falkenstein (CPX only), Helsinki; CX line "currently unavailable"; SNIPPET: limited availability for new customers since 2026-06-26 | 20-60 TB included (EU), then €1.00 per TB [HC] | Default limit UNKNOWN; raise only after 1 month and a paid invoice [HC] | **Allowed**: T&C 7.1 "entitled to grant third parties a contractual term of use"; customer fully liable (7.2-7.3); mining, scanning foreign networks, fake source IPs, DDoS, open relays banned; breach can suspend all products [HT] |
| **Hetzner dedicated** | Hourly, capped at the monthly price, cancel immediately; **one-time setup fee** (AX41 €0) [HD] | None | Per variant: "a few minutes" to "several weeks" [HD order-processing] | Robot API can order (`POST /order/server/transaction`, must be enabled; IPv6-only unless the IPv4 addon) [HD] | Falkenstein, Helsinki | Unlimited on 1 Gbit/s [HD] | UNKNOWN; SNIPPET: new customers may need one extra business day for authentication | Same terms as above [HT] |
| **OVHcloud Public Cloud** | Hourly; Gen 3 has no monthly mode, only Savings Plans 1-36 months [OVH] | None | UNKNOWN | OpenStack API (Nova 20 req/s per project) [OVH] | Gravelines, Strasbourg, Warsaw, Frankfurt (DE1), London (UK1), Paris 3-AZ, Milan (region codes in the docs; per-flavor availability UNKNOWN) | "The bandwidth for instances is not billed" [OVH] | Default numbers UNKNOWN; paid tiers 20 VMs/40 vCPU to 200 VMs/512 vCPU [OVH] | **UNKNOWN** (terms pages did not open; SNIPPET only) |
| **OVHcloud Bare Metal** | Monthly + setup fee (SNIPPET) | UNKNOWN | SNIPPET "< 120 s" | OVHcloud API | UNKNOWN | SNIPPET "unmetered" | UNKNOWN | **UNKNOWN** |
| **Latitude.sh** | Hourly on a 730-hour month; finer granularity UNKNOWN [L2] | None (reserved "65% cheaper", paid upfront) | "< 10 seconds" for some OSes (instant deploy), ≈ 10 min custom disk [L7] | REST API, Terraform | Frankfurt, London, Amsterdam (soon); per-plan UNKNOWN [L8] | 20 TB free per server, then $0.01/GB [L3] | ID check or $100 top-up; $100 hourly spend limit, rising to $500 [L6] | **UNKNOWN** (Megaport agreement did not open) [L12] |
| **Cherry Servers** | Hourly, prepaid balance; rounding UNKNOWN; monthly and longer terms "up to 50%" off [C2, C6] | None | "12 minutes, on average" pre-built; custom 24-72 h [C6] | REST API | Lithuania, Amsterdam, Stockholm, Frankfurt (per model, C1) | "up to 100TB" free per server, then $0.59/TB [C4] | Max servers UNKNOWN; ID verification for card autopay [C7] | **Allowed**: §2.4 "You may resell the Services"; End Users' use is the Client's responsibility (§4.2b) [C5] |
| **Vultr Bare Metal** | Hourly, capped at 672 h/month, 1-hour minimum [V1] | None | UNKNOWN | API, CLI, Terraform [V2] | 9 EU regions per a blog SNIPPET; per-plan bare metal UNKNOWN | UNKNOWN | UNKNOWN | **UNKNOWN** (vultr.com did not open) |
| **GitHub-hosted** (benchmark) | Per job, rounded up to the minute [GH] | Plan; larger runners need Team or Enterprise Cloud [GH] | Seconds (not measured here) | — | — | — | — | — |

## Viability

Rule: **viable** = linux x86-64, an EU region, terms that allow customers' code, provisioning by API, billing no
coarser than monthly. A provider whose terms could not be read fails "terms allow customers' code" until they are
read (it is not proven).

| Option | Viable? | Rule failed |
|---|---|---|
| AWS EC2 on-demand (c6i, c7i, c7a) | Yes | — |
| AWS EC2 spot | Yes by the rule, but **not costed**: prices UNKNOWN; interruptions need a retry path | — |
| phoenixNAP BMC | Yes, **conditional**: Amsterdam's type list is UNKNOWN until seen in the portal | — |
| Hetzner Cloud (CPX, CCX) | Yes (CX: currently unavailable) | — |
| Hetzner dedicated (AX) | Yes | — |
| OVHcloud Public Cloud | No (until read) | Terms allow customers' code: UNKNOWN; prices SNIPPET only |
| OVHcloud Bare Metal | No (until read) | Terms UNKNOWN; EU prices UNKNOWN |
| Latitude.sh | No (until read) | Terms allow customers' code: UNKNOWN |
| Cherry Servers | Yes | — |
| Vultr Bare Metal | No (until read) | Terms UNKNOWN; EU availability per plan UNKNOWN |
| Equinix Metal | No | Shut down 2026-06-30 (no provisioning at all) |

**Cheapest viable, $/slot-hour** (from the table): Hetzner AX102 0.0160 and AX162-128 0.0160, AX41 0.0178, AX42
0.0213; phoenixNAP d3.m6.xlarge 0.0270; Hetzner CPX22 per job 0.0299 (but hourly rounding: a 10-minute job on a fresh
VM pays the full hour, 6× more); Cherry 9950X monthly 0.0317; phoenixNAP s3.c3.medium 0.0313. AWS c6i.large per job:
0.0998 with IPv4 and disk.

**The three added to `COST.md`** are the cheapest viable option **of each different provider**, because the three
cheapest rows are all Hetzner AX servers with near-identical cost per slot: **Hetzner AX102** (dedicated, monthly cap),
**phoenixNAP d3.m6.xlarge** (hourly bare metal), **Cherry Servers Ryzen 9 9950X** (monthly billing). Each runs jobs in
Firecracker microVMs (isolation way B below).

## Isolation

Customers' tests are untrusted code: a job may try to read another customer's source, cache entries or credentials,
attack the host, or abuse the network (crypto mining is banned by AWS Service Terms §1.25, "You will not use, and will
not facilitate or allow End Users to use, the Services to mine cryptocurrency", https://aws.amazon.com/service-terms/,
updated 2026-11-19, read 2026-11-23; the bare-metal providers make the client responsible for its users' traffic, see
the terms column). Three ways to keep jobs of different customers apart:

| Way | What separates two jobs | Start time per job (source) | Overhead (source) | Where it works |
|---|---|---|---|---|
| **A. One VM per job** (today) | The cloud's hypervisor (Nitro on EC2); the VM and its disk are deleted after the job (`runner-fleet.ts:133`) | ≈ 45-75 s queued → job starts, ESTIMATE (`docs/DEPLOY-AWS.md:536`); "a few minutes" to spin up a new EC2 instance per AWS Batch's guide (https://docs.aws.amazon.com/batch/latest/userguide/when-to-use-fargate.html, read 2026-11-23) | Boot is billed (≈ 1 min per job, `COST.md`); a whole VM per job | Clouds that bill per second or minute: AWS. Not bare metal (servers take 1-15 min or more to provision and bill by the hour or month, rows above) |
| **B. microVM per job on a long-lived host** (Firecracker under its jailer; or Cloud Hypervisor) | KVM hardware virtualization + the jailer (own uid, chroot, cgroup, seccomp); the microVM and its disks are destroyed after the job | Firecracker: ≤ 125 ms from InstanceStart to guest `/sbin/init` (https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/SPECIFICATION.md); an independent end-to-end measurement gives ≈ 350 ms (https://arxiv.org/pdf/2110.11462); up to 150 microVMs per second per host (source of firecracker-microvm.github.io). The GitHub runner inside still has to register and take its job: ESTIMATED 5-15 s, not measured. All read 2026-11-23 | ≤ 5 MiB memory per microVM; guest CPU > 95% of bare metal ("integration test pending") (SPECIFICATION.md) | Any bare-metal server (`/dev/kvm`); EC2 `.metal` sizes; EC2 C7i/M7i/R7i/C8i… with nested virtualization, GA 2026-02-16, no extra cost, Intel only (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html; https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual/, read 2026-11-23); EC2 Nitro Sandboxes (Firecracker on `/dev/nitro_enclaves`, no KVM; not on metal, not on c7i.large) per `docs/DEPLOY-AWS.md:652-668`; cloud VMs of Hetzner/OVH only if they expose nested virtualization (see rows) |
| **C. Containers with a stronger runtime** (gVisor) or **wipe the whole server between jobs** | gVisor: a user-space kernel; wipe: re-install the server | gVisor container start ≈ same as runc via Docker (1,144 vs 1,193 ms); raw syscall 38.2 µs vs 1.9 µs on the old ptrace platform, 0.76 µs on its KVM platform (https://raw.githubusercontent.com/google/gvisor/master/website/performance/); wipe: a re-install, 1-15 min (phoenixNAP) or ≈ 12 min (Cherry), rows above | gVisor: ≈ 19.6 MB per sandbox; syscall-heavy tests (the engine runs `strace -f`, `INVENTORY.md`) would suffer, and ptrace inside gVisor is limited (UNKNOWN for the engine). Wipe: the server is idle while re-installing | gVisor anywhere; wipe only with one customer per server (a dedicated server per large customer) |

**Recommendation for comparison:** on bare metal, B is the only way that keeps the per-job start under the 30 s
target (`docs/DEPLOY-AWS.md:738`) and puts several customers on one server safely. Kata Containers would also give
B-style isolation; its start is ≈ 600 ms or more in the same independent study (https://arxiv.org/pdf/2110.11462).

**Compared with "Customer mode" in `docs/DEPLOY-AWS.md:650-783`.** That design is B on AWS: Firecracker under the
jailer on c7i hosts, with Nitro Sandboxes as the backend and KVM via nested virtualization on the same C7i as the
fallback. Its security measures (jailer per sandbox, no credential on the guest's path, the host never mounts a disk
the guest wrote, per-TAP firewall with connection limits, IPv6 off, mandatory memory pool) carry over unchanged to a
bare-metal host with KVM: only the backend changes (`/dev/kvm` instead of `/dev/nitro_enclaves`), and on bare metal
the KVM backend also gives snapshots and memory overcommit, which Nitro Sandboxes lack (`DEPLOY-AWS.md:756`). What
changes on a non-AWS host: no instance metadata service to block, but the provider's own network (other tenants'
servers on the same public subnet, the provider's DHCP/metadata if any) must be firewalled the same way; the cache
machine and the host must be in the same private network (Hetzner vSwitch/cloud network, OVH vRack, phoenixNAP private
network: availability per provider not verified in this review). Capacity per host differs: Customer mode plans
3 full-speed 2-vCPU jobs on a c7i.2xlarge at $0.38304/h = $0.1277 per slot-hour (ESTIMATED 0.38304 ÷ 3); the
bare-metal rows above give 10-50x more slots per server (slot column).

**Per provider:**

| Provider | Way available | Notes |
|---|---|---|
| AWS EC2 | A (today), B on `.metal` or on C7i/M7i/R7i/C8i with nested virtualization (Intel only, no extra cost, AWS-NV), B on Nitro Sandboxes (Customer mode) | Only provider where A is cheap enough (per-second billing). B on C7i costs $0.1277-0.1915 per slot-hour: dearer than A today. |
| phoenixNAP BMC | B (bare metal, KVM); C-wipe via reinstall (1-15 min) | Full-hour billing and 1-15 min provisioning rule out A. Private network between hosts and a cache host: UNKNOWN in this review. |
| Hetzner Cloud | A (VM per job, but each VM bills a full hour: ≈ 6× the cost for a 10-min job); A' = keep a VM and rebuild it from the image between jobs (rebuild time UNKNOWN); B only if nested virtualization is exposed (UNKNOWN) | Abuse terms (mining, scanning, spoofing) suspend the whole account: B needs egress filtering per microVM as in Customer mode (`DEPLOY-AWS.md` F10). |
| Hetzner dedicated | B | Same abuse terms; setup fees favor long-lived hosts. |
| Cherry Servers | B (ESXi offered, so VT-x is exposed, C6) | Resale explicitly allowed. |
| OVHcloud, Latitude.sh, Vultr | B on bare metal | Not viable until the terms are read. |
| GitHub-hosted | A (GitHub's own VM per job) | Benchmark only. |
