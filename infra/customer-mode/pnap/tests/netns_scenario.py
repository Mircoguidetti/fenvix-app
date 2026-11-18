"""Builds one host's network exactly as the agent does (fenvix_host.netplan: the host table, each slot's namespace
and rules, the colocated cache namespace), around stand-ins for the internet, phoenixNAP's private network, the
metadata address and the guests, then probes it with real TCP connections. Prints a JSON object of results.

Run by test_isolation_netns.py inside `unshare --net --mount` (a throwaway network and mount namespace), as root:
    python3 -I netns_scenario.py MODE        MODE: colocated | dedicated | connlimit | ratelimit
A guest here is a network namespace behind a veth named tap0 in the slot's namespace (same name, same rules as the
real TAP); slot 2 also gets a real TAP device owned by its jail uid, as in production.
"""

import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "host"))
from fenvix_host import netplan  # noqa: E402
from fenvix_host.config import Cache, HostConfig  # noqa: E402

PROBE = os.path.join(HERE, "netns_probe.py")
procs = []


def sh(*argv, input=None, check=True):
    r = subprocess.run(list(argv), input=input, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise SystemExit(f"command failed: {' '.join(argv)}: {r.stderr.strip()}")
    return r.stdout


def ns(name, *argv, check=True):
    return sh("ip", "netns", "exec", name, *argv, check=check)


def listen(nsname, *addrs):
    pre = ["ip", "netns", "exec", nsname] if nsname else []
    p = subprocess.Popen([*pre, "python3", "-I", PROBE, "listen", *addrs], stdout=subprocess.PIPE, text=True)
    p.stdout.readline()
    procs.append(p)


def probe(nsname, ip, port, src="-", timeout="1"):
    return ns(nsname, "python3", "-I", PROBE, "connect", ip, str(port), src, timeout).strip()


def veth_to(nsname, host_if, peer_if, host_cidr, peer_cidrs):
    sh("ip", "netns", "add", nsname)
    sh("ip", "link", "add", host_if, "type", "veth", "peer", "name", peer_if, "netns", nsname)
    sh("ip", "addr", "add", host_cidr, "dev", host_if)
    sh("ip", "link", "set", host_if, "up")
    ns(nsname, "ip", "link", "set", "lo", "up")
    for c in peer_cidrs:
        ns(nsname, "ip", "addr", "add", c, "dev", peer_if)
    ns(nsname, "ip", "link", "set", peer_if, "up")


def counter(listing, comment):
    for line in listing.splitlines():
        if comment in line and "counter packets" in line:
            return int(line.split("counter packets")[1].split()[0])
    return None


OBSERVER = """table ip obs {
  chain seen {
    type filter hook prerouting priority -300; policy accept;
    tcp dport 81 tcp flags & (syn|ack) == syn counter comment "syn to 81"
  }
}
"""


def send_syn(nsname, src, count):
    ns(nsname, "python3", "-I", PROBE, "syn", src, "203.0.113.50", "81", str(count))
    time.sleep(0.3)


def run_cmds(cmds, stdin_text):
    for cmd in cmds:
        sh(*cmd, input=stdin_text if cmd[-2:] == ["-f", "-"] else None)


def main(mode):
    os.makedirs("/run/netns", exist_ok=True)
    sh("mount", "-t", "tmpfs", "none", "/run/netns")
    sh("ip", "link", "set", "lo", "up")
    # The internet (public interface bond0) and phoenixNAP's private network (priv0).
    veth_to("inet", "bond0", "uplink", "198.51.100.1/24", ["198.51.100.2/24"])
    for a in ("203.0.113.50/32", "169.254.169.254/32"):
        ns("inet", "ip", "addr", "add", a, "dev", "lo")
    ns("inet", "ip", "route", "add", "default", "via", "198.51.100.1")
    sh("ip", "route", "add", "default", "via", "198.51.100.2")
    veth_to("privnet", "priv0", "pnet", "10.0.0.1/24", ["10.0.0.50/24", "10.0.0.60/24"])
    ns("privnet", "ip", "route", "add", "default", "via", "10.0.0.1")
    listen("inet", "203.0.113.50:80", "198.51.100.2:80", "169.254.169.254:80")
    listen("privnet", "10.0.0.50:8787", "10.0.0.50:22", "10.0.0.60:8787", "10.0.0.60:22")
    listen(None, "198.51.100.1:2222", "10.0.0.1:2222", "0.0.0.0:2223")

    kw = dict(host_id="fx-test-h1", region="ASH", slots=3, pub_if="bond0", host_addrs=("198.51.100.1", "10.0.0.1"))
    if mode == "dedicated":
        kw["cache"] = Cache(mode="dedicated", ip="10.0.0.60", port=8787, iface="priv0")
    else:
        kw["cache"] = Cache(mode="colocated", port=8787)
    if mode == "connlimit":
        kw["conn_limit"] = 10
    if mode == "ratelimit":
        kw["new_conn_per_s"] = 5
    c = HostConfig(**kw)
    sh("sysctl", "-q", "-e", "-w", *[s for s in netplan.HOST_SYSCTLS if "conntrack" not in s])
    sh("nft", "-f", "-", input=netplan.host_ruleset(c))
    if c.cache.mode == "colocated":
        run_cmds(netplan.cache_up(c), netplan.cache_ruleset(c))
        listen(netplan.CACHE_NETNS, "10.201.0.2:8787", "10.201.0.2:22")

    slots = [netplan.slot_net(s) for s in range(3)]
    for n in slots[:2]:
        sh("ip", "netns", "add", f"{n.netns}-guest")
        run_cmds(netplan.slot_up(n, tap_kind="veth"), netplan.vm_ruleset(n))
        g = f"{n.netns}-guest"
        ns(g, "ip", "link", "set", "lo", "up")
        ns(g, "ip", "addr", "add", "172.16.0.2/30", "dev", "eth0")
        ns(g, "ip", "link", "set", "eth0", "up")
        ns(g, "ip", "route", "add", "default", "via", "172.16.0.1")
    run_cmds(netplan.slot_up(slots[2], tap_kind="tap"), netplan.vm_ruleset(slots[2]))
    listen("fxvm1-guest", "172.16.0.2:8080")
    listen("fxvm0", "0.0.0.0:2225")  # a service inside the slot's own namespace (where the VMM lives)
    slot0_listener = procs[-1]

    r = {}
    g0 = "fxvm0-guest"
    if mode in ("colocated", "dedicated"):
        cache_ip = "10.201.0.2" if mode == "colocated" else "10.0.0.60"
        r.update({
            "internet": probe(g0, "203.0.113.50", 80),
            "internet_next_hop": probe(g0, "198.51.100.2", 80),
            "metadata_169.254.169.254": probe(g0, "169.254.169.254", 80),
            "host_public_ip": probe(g0, "198.51.100.1", 2222),
            "host_private_ip": probe(g0, "10.0.0.1", 2222),
            "host_link_ip": probe(g0, "10.200.0.1", 2223),
            "slot_namespace_gateway": probe(g0, "172.16.0.1", 2225),
            "other_vm_link_ip": probe(g0, "10.200.0.6", 8080),
            "other_vm_root_side": probe(g0, "10.200.0.5", 2223),
            "private_network_other_server": probe(g0, "10.0.0.50", 8787),
            "private_network_other_port": probe(g0, "10.0.0.50", 22),
            "cache": probe(g0, cache_ip, 8787),
            "cache_other_port": probe(g0, cache_ip, 22),
            "second_vm_internet": probe("fxvm1-guest", "203.0.113.50", 80),
            "vmm_namespace_itself_to_internet": probe("fxvm0", "203.0.113.50", 80),
            "vmm_namespace_itself_to_host": probe("fxvm0", "10.200.0.1", 2223),
        })
        if mode == "colocated":
            r["cache_namespace_to_internet"] = probe(netplan.CACHE_NETNS, "203.0.113.50", 80)
            r["cache_namespace_to_vm"] = probe(netplan.CACHE_NETNS, "10.200.0.6", 8080)
            r["cache_namespace_to_host"] = probe(netplan.CACHE_NETNS, "10.201.0.1", 2223)
        # Spoofed sources, with real packets (raw TCP SYNs to port 81, counted where they would arrive).
        sh("ip", "netns", "exec", "inet", "nft", "-f", "-", input=OBSERVER)
        arrived = lambda: counter(ns("inet", "nft", "list", "chain", "ip", "obs", "seen"), "syn to 81")  # noqa: E731
        base = arrived()
        # a) the guest of slot 1 (its slot's rules intact) sends from another inside address
        send_syn("fxvm1-guest", "172.16.0.6", 10)
        r["spoof_guest_other_inside_address"] = {"arrived": arrived() - base, "slot_rule_drops": counter(ns("fxvm1", "nft", "list", "chain", "inet", "fxvm", "forward"), "anything else")}
        # b) control: the same raw SYNs from the guest's own address do arrive (masqueraded)
        base = arrived()
        send_syn("fxvm1-guest", "172.16.0.2", 10)
        r["control_guest_own_address"] = {"arrived": arrived() - base}
        # c) a VMM escape that also flushed its slot's rules sends from slot 1's link address: the host's table
        #    refuses it (interface AND source); from its own link address it still gets out (as the guest would).
        ns("fxvm0", "nft", "flush", "ruleset")
        base, root_base = arrived(), counter(sh("nft", "list", "chain", "inet", "fenvix", "forward"), "spoofed source")
        send_syn("fxvm0", "10.200.0.6", 10)
        r["spoof_flushed_slot_other_slot_address"] = {"arrived": arrived() - base, "host_rule_drops": counter(sh("nft", "list", "chain", "inet", "fenvix", "forward"), "spoofed source") - root_base}
        base = arrived()
        send_syn("fxvm0", "10.200.0.2", 10)
        r["control_flushed_slot_own_address"] = {"arrived": arrived() - base}
        # d) the same two spoofs with strict reverse-path filtering OFF everywhere (it dropped them first above): the
        #    nftables rules alone must still stop them, and their counters show it.
        for k in ("all", "fxv0", "fxv1"):
            sh("sysctl", "-q", "-w", f"net.ipv4.conf.{k}.rp_filter=0")
        for k in ("all", "default", "tap0", "vpeer"):
            ns("fxvm1", "sysctl", "-q", "-w", f"net.ipv4.conf.{k}.rp_filter=0")
            ns("fxvm0", "sysctl", "-q", "-e", "-w", f"net.ipv4.conf.{k}.rp_filter=0")
        base, slot_base = arrived(), counter(ns("fxvm1", "nft", "list", "chain", "inet", "fxvm", "forward"), "anything else")
        send_syn("fxvm1-guest", "172.16.0.6", 10)
        r["no_rp_filter_spoof_guest"] = {"arrived": arrived() - base,
                                         "slot_rule_drops": counter(ns("fxvm1", "nft", "list", "chain", "inet", "fxvm", "forward"), "anything else") - slot_base}
        base, root_base = arrived(), counter(sh("nft", "list", "chain", "inet", "fenvix", "forward"), "spoofed source")
        send_syn("fxvm0", "10.200.0.6", 10)
        r["no_rp_filter_spoof_flushed_slot"] = {"arrived": arrived() - base,
                                                "host_rule_drops": counter(sh("nft", "list", "chain", "inet", "fenvix", "forward"), "spoofed source") - root_base}
        r["ipv6_addresses_on_vm_interfaces"] = (sh("ip", "-6", "-o", "addr", "show", "dev", "fxv0")
                                               + ns("fxvm1", "ip", "-6", "-o", "addr", "show")).strip()
        r["real_tap_owner"] = [ns("fxvm2", "cat", "/sys/class/net/tap0/owner").strip(), ns("fxvm2", "cat", "/sys/class/net/tap0/group").strip()]
        slot0_listener.kill()
        slot0_listener.wait()
        for cmd in netplan.slot_down(slots[0]):
            sh(*cmd, check=False)
        time.sleep(0.5)
        r["slot0_after_down"] = {"netns": [l for l in sh("ip", "netns", "list").splitlines() if l.split()[0] == "fxvm0"],
                                 "links": [l.split(":")[1].strip() for l in sh("ip", "-o", "link").splitlines() if l.split(":")[1].strip().split("@")[0] == "fxv0"]}
    elif mode == "connlimit":
        held = subprocess.Popen(["ip", "netns", "exec", g0, "python3", "-I", PROBE, "hold", "203.0.113.50", "80", "15"],
                                stdout=subprocess.PIPE, text=True)
        out = held.stdout.readline().strip()
        r["held_of_15_with_limit_10"] = int(out)
        r["other_vm_meanwhile"] = probe("fxvm1-guest", "203.0.113.50", 80)
        held.kill()
    elif mode == "ratelimit":
        t = time.time()
        r["burst_of_60_with_5_per_s"] = int(ns(g0, "python3", "-I", PROBE, "burst", "203.0.113.50", "80", "60").strip())
        r["burst_seconds"] = round(time.time() - t, 1)
        r["other_vm_meanwhile"] = probe("fxvm1-guest", "203.0.113.50", 80)
    print(json.dumps(r))


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    finally:
        for p in procs:
            p.kill()
