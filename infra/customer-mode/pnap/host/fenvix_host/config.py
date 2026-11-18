"""The host's settings. The App sends them at enrolment (POST /v1/hosts/enrol); install-host.sh adds what only the
host knows (its interfaces and addresses). Every value that reaches a command line or a ruleset is checked here."""

from __future__ import annotations

import ipaddress
import json
import re
from dataclasses import asdict, dataclass, field

IFACE = re.compile(r"^[A-Za-z0-9_.-]{1,15}$")
REGIONS = ("ASH", "PHX", "CHI", "SEA", "NLD")
# Each microVM gets 4 addresses of this /16 (a /30 per slot): at most 16,384 slots, far above any host.
VM_LINK_NET = ipaddress.ip_network("10.200.0.0/16")
# The colocated cache's own namespace (cache mode "colocated").
CACHE_LINK_NET = ipaddress.ip_network("10.201.0.0/30")
# Inside every microVM's namespace (identical in all of them: they never see each other).
GUEST_IP = "172.16.0.2"
GUEST_GW = "172.16.0.1"
GUEST_MAC = "06:00:AC:10:00:02"
# Jail uids: far above any account a distribution or an installer creates (install-host.sh checks the range is free).
UID_BASE = 900000


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Cache:
    """Where a guest finds its region's shared cache. "dedicated": the region's cache server on the phoenixNAP private
    network; "colocated": a cache in its own network namespace on this host (the first test; data dies with the host);
    "off": no cache."""

    mode: str = "off"
    ip: str = ""
    port: int = 8787
    # The interface the cache is reached through (dedicated: the private network's interface).
    iface: str = ""


@dataclass(frozen=True)
class HostConfig:
    host_id: str
    region: str
    slots: int
    vcpus: int = 2
    mem_mib: int = 8192
    scratch_gib: int = 64
    job_timeout_minutes: int = 360
    control_url: str = ""
    summaries_url: str = ""
    pub_if: str = "bond0"
    # Addresses of this host (public and private): a guest reaches none of them.
    host_addrs: tuple[str, ...] = ()
    # Every private range a guest must not reach (phoenixNAP private networks, RFC 1918, CGNAT, link-local...).
    blocked_nets: tuple[str, ...] = (
        "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
        "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
    )
    cache: Cache = field(default_factory=Cache)
    # Per microVM: tracked connections, new connections per second, and Firecracker's bandwidth/packet limiters.
    conn_limit: int = 4096
    new_conn_per_s: int = 200
    bytes_per_s: int = 62_500_000  # 500 Mbit/s each way
    packets_per_s: int = 20_000
    # Per microVM disk (each of its four drives, R-014 R10): 200 MiB/s and 10,000 operations/s. A d3.c1.large's NVMe
    # drive does several GB/s: the cap keeps one job to about 1/4 of it (15 busy microVMs can still saturate it).
    disk_bytes_per_s: int = 200 * 1024 * 1024
    disk_ops_per_s: int = 10_000
    chroot_base: str = "/srv/jailer"
    firecracker: str = "/usr/local/bin/firecracker"
    jailer: str = "/usr/local/bin/jailer"
    kernel: str = "/var/lib/fenvix/guest/vmlinux"
    rootfs: str = "/var/lib/fenvix/guest/rootfs.ext4"
    # The cgroup v2 parent of every microVM (the agent's own delegated subtree, see systemd/fenvix-agent.service).
    parent_cgroup: str = "system.slice/fenvix-agent.service/vms"

    def __post_init__(self) -> None:
        check(self)

    @staticmethod
    def from_json(text: str) -> "HostConfig":
        d = json.loads(text)
        if not isinstance(d, dict):
            raise ConfigError("host config is not an object")
        c = d.pop("cache", None) or {}
        for k in ("host_addrs", "blocked_nets"):
            if k in d:
                d[k] = tuple(d[k])
        known = set(HostConfig.__dataclass_fields__)
        unknown = set(d) - known
        if unknown:
            raise ConfigError(f"unknown host settings: {sorted(unknown)}")
        return HostConfig(cache=Cache(**c), **d)

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, sort_keys=True)


def check(c: HostConfig) -> None:
    if not re.fullmatch(r"[a-z0-9-]{3,63}", c.host_id):
        raise ConfigError("host_id: lower-case letters, digits and hyphens")
    if c.region not in REGIONS:
        raise ConfigError(f"region must be one of {REGIONS}")
    if not 1 <= c.slots <= 250:
        raise ConfigError("slots must be 1-250")
    if not 1 <= c.vcpus <= 32 or not 512 <= c.mem_mib <= 131072 or not 4 <= c.scratch_gib <= 1024:
        raise ConfigError("vcpus 1-32, mem_mib 512-131072, scratch_gib 4-1024")
    if not 1 <= c.job_timeout_minutes <= 24 * 60:
        raise ConfigError("job_timeout_minutes 1-1440")
    for name in ("pub_if",):
        if not IFACE.fullmatch(getattr(c, name)):
            raise ConfigError(f"{name}: not an interface name")
    for u in (c.control_url, c.summaries_url):
        # https only; plain http to the loopback address is for the tests' local stand-ins.
        if u and not re.fullmatch(r"(https://[A-Za-z0-9.-]+|http://127\.0\.0\.1)(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?", u):
            raise ConfigError(f"not an https URL: {u!r}")
    for a in c.host_addrs:
        ipaddress.ip_address(a)
    for n in c.blocked_nets:
        ipaddress.ip_network(n)
    if c.cache.mode not in ("off", "dedicated", "colocated"):
        raise ConfigError("cache.mode: off, dedicated or colocated")
    if c.cache.mode == "dedicated":
        ip = ipaddress.ip_address(c.cache.ip)
        if not ip.is_private:
            raise ConfigError("cache.ip must be on the private network")
        if not IFACE.fullmatch(c.cache.iface):
            raise ConfigError("cache.iface: not an interface name")
    if not 1 <= c.cache.port <= 65535:
        raise ConfigError("cache.port")
    for p in (c.chroot_base, c.firecracker, c.jailer, c.kernel, c.rootfs):
        if not re.fullmatch(r"/[A-Za-z0-9._/-]+", p) or ".." in p:
            raise ConfigError(f"not a plain absolute path: {p!r}")
    if not re.fullmatch(r"[A-Za-z0-9._/-]+", c.parent_cgroup) or ".." in c.parent_cgroup or c.parent_cgroup.startswith("/"):
        raise ConfigError("parent_cgroup: a relative cgroup path")
    for n in ("conn_limit", "new_conn_per_s", "bytes_per_s", "packets_per_s", "disk_bytes_per_s", "disk_ops_per_s"):
        if getattr(c, n) <= 0:
            raise ConfigError(f"{n} must be positive")
    if c.slots * 4 > VM_LINK_NET.num_addresses:
        raise ConfigError("too many slots for the link network")


def slot_uid(slot: int) -> int:
    """Each slot's jail runs as its own uid and gid, never root and never another slot's."""
    return UID_BASE + slot
