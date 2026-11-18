"""One job's microVM: the files in its jail, its Firecracker configuration, and the jailer command line.

Isolation of the VMM itself (R-012 F17, R-012b N3), translated to KVM:
  - the jailer, never Firecracker as root: its own uid and gid per slot (900000 + slot), a chroot holding only this
    job's files, a new PID namespace, the slot's network namespace (--netns), and Firecracker's built-in seccomp
    filter (never --no-seccomp, never a custom --seccomp-filter);
  - a cgroup v2 per microVM under the agent's delegated subtree: CPU (vcpus cores), memory (guest + VMM overhead, no
    swap) and a pids limit, so one job cannot starve the others or the host;
  - resource limits: open files, and the largest file the VMM may write (its largest disk);
  - four disks, all created for this job and deleted after it: a copy of the guest root disk (reflink on the host's
    XFS data disk), a read-only input disk (the just-in-time config and the job's cache token), a raw result disk (no
    filesystem: the host never mounts what a guest wrote, R-012 F9), and an empty scratch disk (Docker's data, the
    runner's work directory).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from .config import GUEST_GW, GUEST_IP, GUEST_MAC, HostConfig
from .netplan import SlotNet

RESULT_BYTES = 16 * 1024 * 1024
INPUT_BYTES = 16 * 1024 * 1024
ROOTFS_MAX_BYTES = 32 * 1024**3
VMM_OVERHEAD_MIB = 512
PIDS_MAX = 128
NO_FILE = 2048
FORBIDDEN_FIRECRACKER_ARGS = ("--no-seccomp", "--seccomp-filter", "--api-sock")


@dataclass(frozen=True)
class Job:
    job_id: int
    runner_name: str
    repository_id: int
    run_id: int
    run_attempt: int
    vcpus: int
    mem_mib: int

    def __post_init__(self) -> None:
        for v in (self.job_id, self.repository_id, self.run_id, self.run_attempt):
            if not isinstance(v, int) or isinstance(v, bool) or v <= 0 or v >= 2**63:
                raise ValueError("job ids must be positive integers")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", self.runner_name):
            raise ValueError("bad runner name")
        if not 1 <= self.vcpus <= 32 or not 512 <= self.mem_mib <= 131072:
            raise ValueError("vcpus 1-32, mem_mib 512-131072")


def jail_id(slot: int, job: Job) -> str:
    return f"fxs{slot}-j{job.job_id}"[:64]


def jail_root(c: HostConfig, slot: int, job: Job) -> str:
    """The jailer builds <chroot_base>/<exec file name>/<id>/root."""
    return f"{c.chroot_base}/firecracker/{jail_id(slot, job)}/root"


def boot_args() -> str:
    # The kernel brings eth0 up itself (CONFIG_IP_PNP): every guest has the same inside address in its own namespace.
    return " ".join([
        "console=ttyS0", "reboot=k", "panic=1", "pci=off", "i8042.noaux", "i8042.nomux", "i8042.dumbkbd",
        f"ip={GUEST_IP}::{GUEST_GW}:255.255.255.252::eth0:off",
    ])


def firecracker_config(c: HostConfig, n: SlotNet, job: Job) -> dict:
    """The --config-file body; every path is inside the jail. Valid against Firecracker's own API description
    (tests: validate-config.mjs with the release's firecracker.yaml)."""
    bucket = lambda size: {"size": size, "refill_time": 1000}  # noqa: E731
    limiter = {"bandwidth": bucket(c.bytes_per_s), "ops": bucket(c.packets_per_s)}
    return {
        "boot-source": {"kernel_image_path": "vmlinux", "boot_args": boot_args()},
        "machine-config": {"vcpu_count": job.vcpus, "mem_size_mib": job.mem_mib, "smt": False},
        "drives": [
            {"drive_id": "rootfs", "path_on_host": "rootfs.ext4", "is_root_device": True, "is_read_only": False},
            {"drive_id": "input", "path_on_host": "input.ext4", "is_root_device": False, "is_read_only": True},
            {"drive_id": "result", "path_on_host": "result.img", "is_root_device": False, "is_read_only": False},
            {"drive_id": "scratch", "path_on_host": "scratch.ext4", "is_root_device": False, "is_read_only": False},
        ],
        "network-interfaces": [{
            "iface_id": "eth0", "guest_mac": GUEST_MAC, "host_dev_name": n.tap,
            "rx_rate_limiter": limiter, "tx_rate_limiter": limiter,
        }],
        "entropy": {},
    }


def cgroup_settings(job: Job) -> list[str]:
    return [
        f"cpu.max={job.vcpus * 100000} 100000",
        f"memory.max={(job.mem_mib + VMM_OVERHEAD_MIB) * 1024 * 1024}",
        "memory.swap.max=0",
        f"pids.max={PIDS_MAX}",
    ]


def jailer_argv(c: HostConfig, n: SlotNet, slot: int, job: Job) -> list[str]:
    largest_disk = max(ROOTFS_MAX_BYTES, c.scratch_gib * 1024**3)
    argv = [
        c.jailer, "--id", jail_id(slot, job), "--exec-file", c.firecracker,
        "--uid", str(n.uid), "--gid", str(n.uid),
        "--chroot-base-dir", c.chroot_base,
        "--netns", f"/var/run/netns/{n.netns}",
        "--new-pid-ns",
        "--cgroup-version", "2", "--parent-cgroup", c.parent_cgroup,
    ]
    for cg in cgroup_settings(job):
        argv += ["--cgroup", cg]
    argv += [
        "--resource-limit", f"no-file={NO_FILE}", "--resource-limit", f"fsize={largest_disk}",
        "--", "--no-api", "--config-file", "config.json", "--level", "Warning",
    ]
    assert not any(a in FORBIDDEN_FIRECRACKER_ARGS for a in argv)
    return argv


def config_json(c: HostConfig, n: SlotNet, job: Job) -> str:
    return json.dumps(firecracker_config(c, n, job), indent=2, sort_keys=True) + "\n"
