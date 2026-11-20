# Customer-mode spike: one job, one Firecracker microVM, on a Nitro Sandboxes parent

This spike runs **one GitHub job in one fresh Firecracker microVM**, on a **c7i** host, with Firecracker's Nitro
Sandboxes backend (v1.18.0 or newer), under the **jailer**. After the job, the microVM and its disks are deleted. It is
meant to measure and to check isolation. It is not production code. The design and the list of things to test before
the first customer are in `docs/DEPLOY-AWS.md`, "Customer mode" (review R-012 F9, F10, F11, F16, F17 applied).

| File | What |
|---|---|
| `host-setup.sh` | the parent: refuses to go on without `/dev/nitro_enclaves` and the memory pool on the kernel command line; installs Firecracker and the jailer (SHA-256 checked); creates `fenvix-post` (sends summaries, holds the job's credential) and `fenvix-parse` (reads guest results); 12 slots; the sandboxes' firewall on `fctap+` (FORWARD DROP, DNS only in link-local, no parent port, no sandbox-to-sandbox, IPv6 dropped, `rp_filter`, per-sandbox connection and rate limits) |
| `build-guest.sh` | the guest image, built once: Firecracker's CI Ubuntu rootfs plus strace, Docker, the GitHub runner (its libraries installed by name) and the fenvix engine (`runner/bootstrap.sh install`, pinned), plus the job service. EFI-stub CI kernel |
| `guest/fenvix-guest-job`, `.service` | inside the guest: read the just-in-time config from the read-only input disk, run the runner for exactly one job, write one length-prefixed result record onto the raw result disk, power off |
| `run-job.sh` | one job, with everything taken from the host's own job record (repository, run, attempt, runner name, jitconfig, the job's summary credential): the job's files in a jailer chroot owned by the jail's uid, a TAP device for that uid (IPv6 off, its source address only), the sandbox under the jailer (2 vCPUs, 2 GiB, direct mode, CPU overcommit, bandwidth limits); then the result read in userspace and sent by `fenvix-post`; everything deleted, also on failure (`trap`); timings |
| `read-result.py` | the result reader: a size-capped, length-prefixed JSON record from raw bytes on stdin; never mounts or follows anything; outputs only the summary and two timings |
| `guest-kernel-docker-check.sh` | does a guest kernel config have what Docker needs (namespaces, cgroups, overlayfs, bridge, veth, netfilter NAT)? |
| `validate-config.mjs` | checks `run-job.sh`'s Firecracker configuration against Firecracker's own API description of a release |

Checked in this repository's container, where there is no `/dev/nitro_enclaves` and no `/dev/kvm`:

- every script parses (`bash -n`); shellcheck runs in the tests when it is installed (it was not in the R-012 fix
  session);
- `run-job.sh --print-config` prints three drives (root, read-only input, raw result) and rate-limited networking;
  `read-result.py` accepts a well-formed record and refuses the rest (tests in `infra/github-app/test/`);
- Firecracker's CI x86_64 6.18 guest kernel config plus its EFI fragment has every option Docker requires (0 missing);
  only the optional ones for swarm and overlay networks (IP_VS, MACVLAN, IPVLAN) are absent.

Nothing here has run on a real host yet. In particular, **the Nitro Sandboxes backend under the jailer** (the
`/dev/nitro_enclaves` node made in the chroot for the jail's uid) is the first thing to try.

On a c7i (Amazon Linux 2023 kernel 6.18, launched with `--enclave-options Enabled=true` and metadata hop limit 1), as
root:

```
# 0. the memory pool (once; without it the parent has 0 sandbox slots)
grubby --update-kernel=ALL --args='nitro_enclaves.mempool=7G@0' && reboot
# 1. the host
FIRECRACKER_SHA256=<from the v1.18.0 release page> bash host-setup.sh
# 2. the guest image
KERNEL=<bzImage-6.18 CI artifact> BASE=<ubuntu-24.04.squashfs CI artifact> bash build-guest.sh
# 3. one job (the values a worker would put in the job's queue message)
JITCONFIG=<encoded_jit_config> SLOT=1 REPOSITORY_ID=<id> RUN_ID=<id> RUN_ATTEMPT=1 RUNNER_NAME=fenvix-j<job id> \
  SUMMARY_TOKEN_FILE=<file, 0400 fenvix-post> FENVIX_SUMMARIES_URL=https://api.fenvix.dev/v1/runner/summaries \
  bash run-job.sh
```
