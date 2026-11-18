# Customer-mode spike: one job, one Firecracker microVM, on a Nitro Sandboxes parent

This spike runs **one GitHub job in one fresh Firecracker microVM**, on a **c7i.xlarge** host, with Firecracker's
Nitro Sandboxes backend (v1.18.0 or newer). After the job, the microVM and its disks are deleted. It is meant to
measure and to check isolation. It is not production code. The design and the list of things to test before the
first customer are in `docs/DEPLOY-AWS.md`, "Customer mode".

| File | What |
|---|---|
| `host-setup.sh` | the parent: checks `/dev/nitro_enclaves`; installs Firecracker (SHA-256 checked); raises the sandbox slots; sets up NAT for the sandboxes. A sandbox may not reach the parent, its metadata service or another sandbox |
| `build-guest.sh` | the guest image, built once: Firecracker's CI Ubuntu rootfs plus strace, Docker, the GitHub runner and the fenvix engine (`runner/bootstrap.sh install`, pinned), plus the job service. EFI-stub CI kernel |
| `guest/fenvix-guest-job`, `.service` | inside the guest: run the just-in-time runner for exactly one job, put `summary.json` on the job disk, power off |
| `run-job.sh` | one job: copies the guest disk, writes a job disk holding the just-in-time config, creates a TAP device, starts the sandbox (2 vCPUs, 2 GiB, direct mode, CPU overcommit), waits for it to exit, sends the summary with the **host's** runner token, deletes everything, and prints the timings |
| `guest-kernel-docker-check.sh` | does a guest kernel config have what Docker needs (namespaces, cgroups, overlayfs, bridge, veth, netfilter NAT)? |
| `validate-config.mjs` | checks `run-job.sh`'s Firecracker configuration against Firecracker's own API description of a release |

Checked in this repository's container, where there is no `/dev/nitro_enclaves` and no `/dev/kvm`:

- every script passes shellcheck;
- the configuration is valid against Firecracker 1.18.0's API description (boot source, machine config, both drives,
  the network interface, `enclave`), and an invalid value is refused;
- Firecracker's CI x86_64 6.18 guest kernel config plus its EFI fragment has every option Docker requires (0 missing);
  only the optional ones for swarm and overlay networks (IP_VS, MACVLAN, IPVLAN) are absent.

Nothing here has run on a real host yet.

On a c7i.xlarge (Amazon Linux 2023 kernel 6.18, launched with `--enclave-options Enabled=true`), as root:

```
FIRECRACKER_SHA256=<from the v1.18.0 release page> bash host-setup.sh
KERNEL=<bzImage-6.18 CI artifact> BASE=<ubuntu-24.04.squashfs CI artifact> bash build-guest.sh
JITCONFIG=<encoded_jit_config of a queued job> SLOT=1 bash run-job.sh
```
