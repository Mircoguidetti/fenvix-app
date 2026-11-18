"""The network of the host and of every microVM: generated, never typed by hand, and tested on real packets
(tests/test_isolation_netns.py builds this exact topology in network namespaces and probes it).

Layout (R-012 F10 and R-012b N3, translated from Nitro Sandboxes to KVM):

    guest eth0 172.16.0.2 ── tap0 172.16.0.1 ┐  netns fxvm<N>: the jailed Firecracker of slot N lives here;
                                             │  ruleset "fxvm": only the guest's own source, SNAT to its link
                                             │  address; nothing in or out of the namespace itself (input and
                                             │  output policy drop: a VMM that escaped the guest has no network)
                       vpeer 10.200.x.2 ─────┘
                           │ veth
                       fxv<N> 10.200.x.1   root namespace, table "inet fenvix":
                                             - nothing from a microVM reaches the host (input drop on fxv*);
                                             - forward policy drop; a microVM's packets are checked by interface
                                               AND source (iifname . saddr in @vm_src), never by source alone;
                                             - IPv6 dropped; per-microVM connection count and new-connection rate;
                                             - no private, link-local, metadata, multicast or host address;
                                               only the region's cache on its one port;
                                             - out through the public interface, masqueraded.

Every microVM has the same inside addresses (they never see each other), so the guest image needs no per-job network
configuration (kernel `ip=` argument). Each job gets a FRESH namespace, deleted with the job.
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass

from .config import CACHE_LINK_NET, GUEST_GW, GUEST_IP, VM_LINK_NET, HostConfig, slot_uid

TABLE = "fenvix"
VM_TABLE = "fxvm"
CACHE_NETNS = "fxcache"
CACHE_ROOT_IF = "fxc0"
CACHE_PEER_IF = "cpeer"


@dataclass(frozen=True)
class SlotNet:
    slot: int
    netns: str
    root_if: str
    peer_if: str
    tap: str
    root_ip: str
    peer_ip: str
    uid: int


def slot_net(slot: int) -> SlotNet:
    base = int(VM_LINK_NET.network_address) + 4 * slot
    return SlotNet(
        slot=slot, netns=f"fxvm{slot}", root_if=f"fxv{slot}", peer_if="vpeer", tap="tap0",
        root_ip=str(ipaddress.IPv4Address(base + 1)), peer_ip=str(ipaddress.IPv4Address(base + 2)), uid=slot_uid(slot),
    )


def cache_endpoint(c: HostConfig) -> tuple[str, int, str] | None:
    """(address, port, interface) of the region's cache as a guest reaches it, or None."""
    if c.cache.mode == "dedicated":
        return c.cache.ip, c.cache.port, c.cache.iface
    if c.cache.mode == "colocated":
        return str(CACHE_LINK_NET.network_address + 2), c.cache.port, CACHE_ROOT_IF
    return None


def host_ruleset(c: HostConfig) -> str:
    """The root namespace's table. Loaded by the agent at each start (Agent.prepare_host) and checked on every lease
    round (Agent.ensure_host_table); replaces any previous version atomically."""
    slots = [slot_net(s) for s in range(c.slots)]
    vm_src = ", ".join(f'"{n.root_if}" . {n.peer_ip}' for n in slots)
    blocked = ", ".join(sorted(set(c.blocked_nets), key=lambda n: ipaddress.ip_network(n)))
    host4 = [a for a in c.host_addrs if ipaddress.ip_address(a).version == 4]
    cache = cache_endpoint(c)
    lines = [
        f"table inet {TABLE}",
        f"delete table inet {TABLE}",
        f"table inet {TABLE} {{",
        "  set blocked4 { type ipv4_addr; flags interval; auto-merge; elements = { " + blocked + " } }",
    ]
    if host4:
        lines.append("  set host4 { type ipv4_addr; elements = { " + ", ".join(host4) + " } }")
    lines += [
        "  # each microVM's interface with the one source address it may use",
        "  set vm_src { type ifname . ipv4_addr; elements = { " + vm_src + " } }",
        "  set vm_conn { type ipv4_addr; size 65535; flags dynamic; }",
        "  set vm_rate { type ipv4_addr; size 65535; flags dynamic,timeout; timeout 60s; }",
        "",
        "  chain input {",
        "    type filter hook input priority filter; policy accept;",
        '    iifname "fxv*" counter drop comment "a microVM reaches no port of the host"',
        f'    iifname "{CACHE_ROOT_IF}" counter drop comment "nor does the colocated cache"',
        "  }",
        "",
        "  chain forward {",
        "    type filter hook forward priority filter; policy drop;",
        '    iifname "fxv*" meta nfproto ipv6 counter drop',
        '    iifname "fxv*" iifname . ip saddr != @vm_src counter drop comment "spoofed source"',
        "    ct state established,related accept",
        "    ct state invalid counter drop",
        '    iifname "fxv*" jump from_vm',
        "  }",
        "",
        "  chain from_vm {",
        f"    ct state new add @vm_conn {{ ip saddr ct count over {c.conn_limit} }} counter drop comment \"connections per microVM\"",
        f"    ct state new add @vm_rate {{ ip saddr limit rate over {c.new_conn_per_s}/second burst {2 * c.new_conn_per_s} packets }} counter drop comment \"new connections per second per microVM\"",
    ]
    if cache:
        ip, port, iface = cache
        lines.append(f'    ip daddr {ip} tcp dport {port} oifname "{iface}" accept comment "the region\'s cache, its one port"')
    lines.append("    ip daddr @blocked4 counter drop comment \"private, link-local, metadata, loopback, multicast\"")
    if host4:
        lines.append("    ip daddr @host4 counter drop comment \"this host's own addresses\"")
    lines += [
        f'    oifname "{c.pub_if}" accept',
        "    counter drop",
        "  }",
        "",
        "  chain postrouting {",
        "    type nat hook postrouting priority srcnat; policy accept;",
        f'    ip saddr {VM_LINK_NET} oifname "{c.pub_if}" masquerade',
    ]
    if cache and c.cache.mode == "dedicated":
        ip, port, iface = cache
        lines.append(f'    ip saddr {VM_LINK_NET} ip daddr {ip} oifname "{iface}" masquerade')
    lines += ["  }", "}", ""]
    return "\n".join(lines)


def vm_ruleset(n: SlotNet, conn_limit: int = 4096) -> str:
    """Inside one microVM's namespace. The namespace forwards the guest's own traffic and nothing else; it accepts and
    sends nothing itself, so the jailed Firecracker in it (a VMM escape) has no network at all (R-012b N3).
    The connection cap is enforced here too, not only in the root namespace: the namespace's own conntrack table
    confirms a flow before the root namespace sees it, so a flooding guest would otherwise fill this table (up to
    nf_conntrack_max, kernel memory charged to no cgroup) with flows the root namespace then drops (R-014 note a)."""
    return "\n".join([
        f"table inet {VM_TABLE} {{",
        "  set conn { type ipv4_addr; size 16; flags dynamic; }",
        "  chain input { type filter hook input priority filter; policy drop; }",
        '  chain output { type filter hook output priority filter; policy drop; counter comment "the namespace itself sends nothing"; }',
        "  chain forward {",
        "    type filter hook forward priority filter; policy drop;",
        "    meta nfproto ipv6 drop",
        f'    iifname "{n.tap}" ct state new add @conn {{ ip saddr ct count over {conn_limit} }} counter drop comment "connections of this microVM"',
        f'    iifname "{n.tap}" oifname "{n.peer_if}" ip saddr {GUEST_IP} accept',
        f'    iifname "{n.peer_if}" oifname "{n.tap}" ct state established,related accept',
        '    counter drop comment "anything else, e.g. a spoofed guest source"',
        "  }",
        "  chain postrouting {",
        "    type nat hook postrouting priority srcnat; policy accept;",
        f'    oifname "{n.peer_if}" ip saddr {GUEST_IP} snat ip to {n.peer_ip}',
        "  }",
        "}",
        "",
    ])


Cmd = list[str]


def slot_up(n: SlotNet, *, tap_kind: str = "tap") -> list[Cmd]:
    """Commands that create slot N's namespace for one job. tap_kind "veth" is for the tests only: a veth whose other
    end is a stand-in guest namespace, under the same name and rules as the TAP."""
    ns = ["ip", "-n", n.netns]
    cmds: list[Cmd] = [
        ["ip", "netns", "add", n.netns],
        ["ip", "link", "add", n.root_if, "type", "veth", "peer", "name", n.peer_if, "netns", n.netns],
        ["sysctl", "-q", "-e", "-w", f"net.ipv6.conf.{n.root_if}.disable_ipv6=1", f"net.ipv4.conf.{n.root_if}.rp_filter=1"],
        ["ip", "addr", "add", f"{n.root_ip}/30", "dev", n.root_if],
        ["ip", "link", "set", n.root_if, "up"],
        ["ip", "netns", "exec", n.netns, "sysctl", "-q", "-e", "-w", "net.ipv4.ip_forward=1", "net.ipv4.conf.all.rp_filter=1",
         "net.ipv4.conf.default.rp_filter=1", "net.ipv6.conf.all.disable_ipv6=1", "net.ipv6.conf.default.disable_ipv6=1"],
        [*ns, "link", "set", "lo", "up"],
        [*ns, "addr", "add", f"{n.peer_ip}/30", "dev", n.peer_if],
        [*ns, "link", "set", n.peer_if, "up"],
        [*ns, "route", "add", "default", "via", n.root_ip],
    ]
    if tap_kind == "tap":
        cmds.append([*ns, "tuntap", "add", "dev", n.tap, "mode", "tap", "user", str(n.uid), "group", str(n.uid)])
    else:
        cmds.append(["ip", "link", "add", n.tap, "netns", n.netns, "type", "veth", "peer", "name", "eth0", "netns", f"{n.netns}-guest"])
    cmds += [
        [*ns, "addr", "add", f"{GUEST_GW}/30", "dev", n.tap],
        [*ns, "link", "set", n.tap, "up"],
        ["ip", "netns", "exec", n.netns, "nft", "-f", "-"],  # stdin: vm_ruleset(n)
    ]
    return cmds


def slot_down(n: SlotNet) -> list[Cmd]:
    """Deleting the namespace deletes its TAP and both veth ends. Then the connection-tracking entries of the slot's
    address, so nothing of this job's flows reaches the next job in the slot."""
    return [
        # Deleting the root end removes both veth ends at once; the namespace itself is torn down asynchronously.
        ["ip", "link", "del", n.root_if],
        ["ip", "netns", "del", n.netns],
        ["conntrack", "-D", "-s", n.peer_ip],
        ["conntrack", "-D", "-d", n.peer_ip],
    ]


def cache_ruleset(c: HostConfig) -> str:
    """The colocated cache's namespace: its port, from microVMs only; it starts no connection of its own."""
    return "\n".join([
        "table inet fxcache {",
        "  chain input {",
        "    type filter hook input priority filter; policy drop;",
        '    iifname "lo" accept',
        "    ct state established,related accept",
        f'    iifname "{CACHE_PEER_IF}" ip saddr {VM_LINK_NET} tcp dport {c.cache.port} ct state new accept',
        "  }",
        "  chain output {",
        "    type filter hook output priority filter; policy drop;",
        '    oifname "lo" accept',
        "    ct state established,related accept",
        "  }",
        "}",
        "",
    ])


def cache_up(c: HostConfig) -> list[Cmd]:
    root = str(CACHE_LINK_NET.network_address + 1)
    peer = str(CACHE_LINK_NET.network_address + 2)
    ns = ["ip", "-n", CACHE_NETNS]
    return [
        ["ip", "netns", "add", CACHE_NETNS],
        ["ip", "link", "add", CACHE_ROOT_IF, "type", "veth", "peer", "name", CACHE_PEER_IF, "netns", CACHE_NETNS],
        ["sysctl", "-q", "-e", "-w", f"net.ipv6.conf.{CACHE_ROOT_IF}.disable_ipv6=1", f"net.ipv4.conf.{CACHE_ROOT_IF}.rp_filter=1"],
        ["ip", "addr", "add", f"{root}/30", "dev", CACHE_ROOT_IF],
        ["ip", "link", "set", CACHE_ROOT_IF, "up"],
        ["ip", "netns", "exec", CACHE_NETNS, "sysctl", "-q", "-e", "-w", "net.ipv6.conf.all.disable_ipv6=1", "net.ipv6.conf.default.disable_ipv6=1"],
        [*ns, "link", "set", "lo", "up"],
        [*ns, "addr", "add", f"{peer}/30", "dev", CACHE_PEER_IF],
        [*ns, "link", "set", CACHE_PEER_IF, "up"],
        # Only the way back to the microVMs: no default route, so the cache reaches nothing else.
        [*ns, "route", "add", str(VM_LINK_NET), "via", root],
        ["ip", "netns", "exec", CACHE_NETNS, "nft", "-f", "-"],  # stdin: cache_ruleset(c)
    ]


HOST_SYSCTLS = [
    "net.ipv4.ip_forward=1",
    # New interfaces (every fxv*, fxc0) start with strict reverse-path filtering and no IPv6.
    "net.ipv4.conf.default.rp_filter=1",
    "net.ipv6.conf.default.disable_ipv6=1",
    # Room in the shared connection-tracking table that no single microVM can fill (conn_limit each).
    "net.netfilter.nf_conntrack_max=1048576",
]
