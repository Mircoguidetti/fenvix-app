"""Isolation rules as tests on the GENERATED configuration: the host's nftables table, each slot's table, the jailer
command line (uid, chroot, netns, cgroups, seccomp) and the Firecracker configuration (disks, network, limits).
The rules are also exercised with real packets in test_isolation_netns.py."""

import json
import os
import re
import shutil
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "host"))
from fenvix_host import netplan, vm  # noqa: E402
from fenvix_host.config import Cache, ConfigError, HostConfig, UID_BASE  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))


def cfg(**kw):
    base = dict(host_id="fx-ash-h1", region="ASH", slots=30, host_addrs=("203.0.113.10", "10.0.0.11"),
                cache=Cache(mode="dedicated", ip="10.0.0.60", port=8787, iface="bond0.11"))
    base.update(kw)
    return HostConfig(**base)


def job(**kw):
    base = dict(job_id=123456, runner_name="fenvix-j123456", repository_id=42, run_id=777, run_attempt=1, vcpus=2, mem_mib=8192)
    base.update(kw)
    return vm.Job(**base)


def rules(text, chain):
    m = re.search(r"chain " + chain + r" \{(.*?)\n  \}", text, re.S)
    assert m, f"chain {chain} not found"
    return [l.strip() for l in m.group(1).strip().splitlines() if l.strip() and not l.strip().startswith("#")]


class HostTable(unittest.TestCase):
    def setUp(self):
        self.c = cfg()
        self.t = netplan.host_ruleset(self.c)

    def test_forward_defaults_to_drop_and_ipv6_and_spoofing_go_first(self):
        fwd = rules(self.t, "forward")
        self.assertIn("policy drop", fwd[0])
        self.assertEqual(fwd[1], 'iifname "fxv*" meta nfproto ipv6 counter drop')
        self.assertTrue(fwd[2].startswith('iifname "fxv*" iifname . ip saddr != @vm_src counter drop'))
        # The spoofing check comes before anything that accepts (established flows included).
        first_accept = next(i for i, r in enumerate(fwd) if r.endswith("accept"))
        self.assertGreater(first_accept, 2)

    def test_every_slot_is_bound_to_its_interface_and_one_source(self):
        m = re.search(r"set vm_src \{.*?elements = \{(.*?)\}", self.t)
        pairs = [p.strip() for p in m.group(1).split(",")]
        self.assertEqual(len(pairs), self.c.slots)
        for s in range(self.c.slots):
            n = netplan.slot_net(s)
            self.assertIn(f'"{n.root_if}" . {n.peer_ip}', pairs)
        self.assertEqual(len({netplan.slot_net(s).peer_ip for s in range(250)}), 250, "link addresses never repeat")

    def test_no_microvm_reaches_the_host(self):
        self.assertIn('iifname "fxv*" counter drop', "\n".join(rules(self.t, "input")))
        frm = "\n".join(rules(self.t, "from_vm"))
        self.assertIn("ip daddr @host4 counter drop", frm)
        self.assertIn("203.0.113.10", self.t)

    def test_private_link_local_metadata_and_multicast_are_dropped_and_the_cache_is_the_one_exception(self):
        m = re.search(r"set blocked4 \{.*?elements = \{(.*?)\}", self.t)
        nets = {p.strip() for p in m.group(1).split(",")}
        for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "127.0.0.0/8", "224.0.0.0/4"):
            self.assertIn(n, nets)
        frm = rules(self.t, "from_vm")
        cache = [i for i, r in enumerate(frm) if "10.0.0.60" in r]
        blocked = [i for i, r in enumerate(frm) if "@blocked4" in r]
        self.assertEqual(len(cache), 1)
        self.assertIn('ip daddr 10.0.0.60 tcp dport 8787 oifname "bond0.11" accept', frm[cache[0]])
        self.assertLess(cache[0], blocked[0])
        # Only two accepts from a microVM: its cache port and the public interface.
        self.assertEqual([r for r in frm if r.endswith("accept") or " accept " in r],
                         [frm[cache[0]], f'oifname "{self.c.pub_if}" accept'])
        self.assertEqual(frm[-1], "counter drop")

    def test_limits_per_microvm(self):
        frm = "\n".join(rules(self.t, "from_vm"))
        self.assertIn(f"ct count over {self.c.conn_limit}", frm)
        self.assertIn(f"limit rate over {self.c.new_conn_per_s}/second", frm)

    def test_no_accept_is_keyed_on_a_source_address_alone(self):
        for line in self.t.splitlines():
            line = line.strip()
            if line.endswith("accept") and "saddr" in line:
                self.fail(f"accept by source address: {line}")

    def test_masquerade_only_out_of_the_public_interface_and_to_the_cache(self):
        post = rules(self.t, "postrouting")
        self.assertIn(f'ip saddr 10.200.0.0/16 oifname "{self.c.pub_if}" masquerade', post)
        self.assertIn('ip saddr 10.200.0.0/16 ip daddr 10.0.0.60 oifname "bond0.11" masquerade', post)
        self.assertEqual(len([r for r in post if "masquerade" in r]), 2)

    def test_no_cache_means_no_exception(self):
        t = netplan.host_ruleset(cfg(cache=Cache(mode="off")))
        self.assertNotIn("tcp dport", t)

    @unittest.skipUnless(shutil.which("nft") and shutil.which("unshare") and os.geteuid() == 0, "needs root, nft and unshare")
    def test_nft_accepts_the_generated_tables(self):
        for text in (self.t, netplan.vm_ruleset(netplan.slot_net(3)), netplan.cache_ruleset(cfg(cache=Cache(mode="colocated")))):
            r = subprocess.run(["unshare", "-n", "nft", "-c", "-f", "-"], input=text.encode(), capture_output=True)
            self.assertEqual(r.returncode, 0, r.stderr.decode())


class SlotTable(unittest.TestCase):
    def test_the_slot_namespace_forwards_the_guest_only_and_has_no_network_of_its_own(self):
        n = netplan.slot_net(5)
        t = netplan.vm_ruleset(n)
        self.assertIn("chain input { type filter hook input priority filter; policy drop; }", t)
        self.assertRegex(t, r"chain output \{ type filter hook output priority filter; policy drop;")
        fwd = rules(t, "forward")
        self.assertIn("policy drop", fwd[0])
        self.assertIn("meta nfproto ipv6 drop", fwd)
        self.assertIn('iifname "tap0" oifname "vpeer" ip saddr 172.16.0.2 accept', fwd)
        self.assertIn('iifname "vpeer" oifname "tap0" ct state established,related accept', fwd)
        self.assertIn(f'oifname "vpeer" ip saddr 172.16.0.2 snat ip to {n.peer_ip}', t)

    def test_the_tap_belongs_to_the_jail_uid_and_ipv6_is_off(self):
        n = netplan.slot_net(5)
        cmds = netplan.slot_up(n)
        tap = next(c for c in cmds if "tuntap" in c)
        self.assertEqual(tap[-4:], ["user", str(UID_BASE + 5), "group", str(UID_BASE + 5)])
        flat = [" ".join(c) for c in cmds]
        self.assertTrue(any("net.ipv6.conf.all.disable_ipv6=1" in c and n.netns in c for c in flat))
        self.assertTrue(any(f"net.ipv6.conf.{n.root_if}.disable_ipv6=1" in c for c in flat))
        self.assertTrue(any(f"net.ipv4.conf.{n.root_if}.rp_filter=1" in c for c in flat))

    def test_teardown_removes_the_namespace_and_its_flows(self):
        n = netplan.slot_net(2)
        down = netplan.slot_down(n)
        self.assertIn(["ip", "netns", "del", n.netns], down)
        self.assertIn(["conntrack", "-D", "-s", n.peer_ip], down)


class Jailer(unittest.TestCase):
    def setUp(self):
        self.c = cfg()

    def argv(self, slot=4, **kw):
        return vm.jailer_argv(self.c, netplan.slot_net(slot), slot, job(**kw))

    def val(self, argv, flag):
        return [argv[i + 1] for i, a in enumerate(argv) if a == flag]

    def test_never_root_and_one_uid_per_slot(self):
        uids = set()
        for s in range(self.c.slots):
            a = self.argv(slot=s)
            self.assertEqual(self.val(a, "--uid"), [str(UID_BASE + s)])
            self.assertEqual(self.val(a, "--gid"), [str(UID_BASE + s)])
            uids.add(UID_BASE + s)
        self.assertEqual(len(uids), self.c.slots)
        self.assertNotIn(0, uids)

    def test_chroot_netns_pid_namespace(self):
        a = self.argv()
        self.assertEqual(a[0], self.c.jailer)
        self.assertEqual(self.val(a, "--exec-file"), [self.c.firecracker])
        self.assertEqual(self.val(a, "--chroot-base-dir"), ["/srv/jailer"])
        self.assertEqual(self.val(a, "--netns"), ["/var/run/netns/fxvm4"])
        self.assertIn("--new-pid-ns", a)
        self.assertEqual(self.val(a, "--id"), ["fxs4-j123456"])

    def test_cgroups_bound_cpu_memory_and_pids(self):
        a = self.argv(vcpus=4, mem_mib=8192)
        self.assertEqual(self.val(a, "--cgroup-version"), ["2"])
        self.assertEqual(self.val(a, "--parent-cgroup"), ["system.slice/fenvix-agent.service/vms"])
        cg = dict(x.split("=", 1) for x in self.val(a, "--cgroup"))
        self.assertEqual(cg["cpu.max"], "400000 100000")
        self.assertEqual(int(cg["memory.max"]), (8192 + 512) * 1024 * 1024)
        self.assertEqual(cg["memory.swap.max"], "0")
        self.assertLessEqual(int(cg["pids.max"]), 256)

    def test_seccomp_stays_on_and_there_is_no_api_socket(self):
        a = self.argv()
        fc = a[a.index("--") + 1:]
        for bad in ("--no-seccomp", "--seccomp-filter", "--api-sock"):
            self.assertNotIn(bad, a)
        self.assertEqual(fc[:3], ["--no-api", "--config-file", "config.json"])

    def test_resource_limits(self):
        a = self.argv()
        rl = dict(x.split("=", 1) for x in self.val(a, "--resource-limit"))
        self.assertEqual(rl["no-file"], "2048")
        self.assertGreaterEqual(int(rl["fsize"]), self.c.scratch_gib * 1024**3)


class FirecrackerConfig(unittest.TestCase):
    def test_disks_network_and_limits(self):
        c = cfg()
        n = netplan.slot_net(1)
        fc = vm.firecracker_config(c, n, job())
        d = {x["drive_id"]: x for x in fc["drives"]}
        self.assertEqual(set(d), {"rootfs", "input", "result", "scratch"})
        self.assertTrue(d["rootfs"]["is_root_device"])
        self.assertTrue(d["input"]["is_read_only"])
        for x in fc["drives"]:
            self.assertNotIn("/", x["path_on_host"], "every disk is inside the jail")
        self.assertEqual(fc["machine-config"], {"vcpu_count": 2, "mem_size_mib": 8192, "smt": False})
        nic = fc["network-interfaces"]
        self.assertEqual(len(nic), 1)
        self.assertEqual(nic[0]["host_dev_name"], "tap0")
        for k in ("rx_rate_limiter", "tx_rate_limiter"):
            self.assertEqual(nic[0][k]["bandwidth"]["size"], c.bytes_per_s)
        for absent in ("vsock", "mmds-config", "balloon", "logger", "metrics"):
            self.assertNotIn(absent, fc)
        self.assertIn("ip=172.16.0.2::172.16.0.1:255.255.255.252::eth0:off", fc["boot-source"]["boot_args"])

    @unittest.skipUnless(shutil.which("node") and os.path.isdir(os.path.join(REPO, "github-app", "node_modules", "ajv")),
                         "needs node and github-app's node_modules (ajv, yaml)")
    def test_valid_against_firecracker_v1_18_0_api_description(self):
        path = os.path.join(HERE, "fc-config.json")
        with open(path, "w") as f:
            f.write(vm.config_json(cfg(), netplan.slot_net(1), job()))
        try:
            r = subprocess.run(["node", os.path.join(HERE, "validate-fc-config.mjs"), os.path.join(HERE, "fixtures", "firecracker-v1.18.0.yaml"), path],
                               capture_output=True, text=True)
        finally:
            os.remove(path)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("Firecracker API 1.18.0", r.stdout)


class Settings(unittest.TestCase):
    def test_bad_values_are_refused(self):
        for kw in (dict(region="FRA"), dict(slots=0), dict(host_id="Bad_Id"), dict(pub_if="eth0; rm -rf /"),
                   dict(cache=Cache(mode="dedicated", ip="8.8.8.8", iface="bond0")), dict(control_url="http://example.com"),
                   dict(parent_cgroup="../escape"), dict(kernel="/var/lib/../etc/shadow")):
            with self.assertRaises((ConfigError, ValueError), msg=str(kw)):
                cfg(**kw)

    def test_round_trip(self):
        c = cfg()
        self.assertEqual(HostConfig.from_json(c.to_json()), c)
        with self.assertRaises(ConfigError):
            HostConfig.from_json(json.dumps({**json.loads(c.to_json()), "surprise": 1}))


if __name__ == "__main__":
    unittest.main()
