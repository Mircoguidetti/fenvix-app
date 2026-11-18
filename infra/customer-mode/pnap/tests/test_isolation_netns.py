"""Isolation with real packets: the generated network (netplan) built in throwaway network namespaces, around
stand-ins for the internet, phoenixNAP's private network, the metadata address, the colocated or dedicated cache,
the host's own services and other microVMs (netns_scenario.py). Needs root, unshare, ip and nft (this repository's
cloud container has them; no /dev/kvm needed)."""

import json
import os
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CAN = os.geteuid() == 0 and all(shutil.which(t) for t in ("unshare", "ip", "nft", "conntrack"))


def scenario(mode):
    r = subprocess.run(["unshare", "--net", "--mount", "--propagation", "private", "python3", "-I", os.path.join(HERE, "netns_scenario.py"), mode],
                       capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise AssertionError(r.stdout + r.stderr)
    return json.loads(r.stdout.strip().splitlines()[-1])


@unittest.skipUnless(CAN, "needs root, unshare, ip, nft and conntrack")
class Isolation(unittest.TestCase):
    MUST_FAIL = [
        "metadata_169.254.169.254", "host_public_ip", "host_private_ip", "host_link_ip", "slot_namespace_gateway",
        "other_vm_link_ip", "other_vm_root_side", "private_network_other_server", "private_network_other_port",
        "cache_other_port", "vmm_namespace_itself_to_internet", "vmm_namespace_itself_to_host",
    ]

    def check_common(self, r):
        for k in ("internet", "internet_next_hop", "cache", "second_vm_internet"):
            self.assertEqual(r[k], "ok", k)
        for k in self.MUST_FAIL:
            self.assertTrue(r[k].startswith("fail"), f"{k}: {r[k]}")
        # Spoofed sources: real raw SYNs; none arrives. The controls (own address) do arrive, so the probe works.
        self.assertEqual(r["spoof_guest_other_inside_address"]["arrived"], 0)
        self.assertEqual(r["spoof_flushed_slot_other_slot_address"]["arrived"], 0)
        self.assertEqual(r["control_guest_own_address"]["arrived"], 10)
        self.assertEqual(r["control_flushed_slot_own_address"]["arrived"], 10)
        # With reverse-path filtering off, the nftables rules alone drop every spoofed packet.
        self.assertEqual(r["no_rp_filter_spoof_guest"], {"arrived": 0, "slot_rule_drops": 10})
        self.assertEqual(r["no_rp_filter_spoof_flushed_slot"], {"arrived": 0, "host_rule_drops": 10})
        self.assertEqual(r["ipv6_addresses_on_vm_interfaces"], "")
        self.assertEqual(r["real_tap_owner"], ["900002", "900002"])
        self.assertEqual(r["slot0_after_down"], {"netns": [], "links": []})

    def test_colocated_cache(self):
        r = scenario("colocated")
        self.check_common(r)
        for k in ("cache_namespace_to_internet", "cache_namespace_to_vm", "cache_namespace_to_host"):
            self.assertTrue(r[k].startswith("fail"), f"{k}: {r[k]}")

    def test_dedicated_cache_on_the_private_network(self):
        self.check_common(scenario("dedicated"))

    def test_connection_limit_per_microvm_does_not_touch_the_others(self):
        r = scenario("connlimit")
        self.assertEqual(r["held_of_15_with_limit_10"], 10)
        self.assertEqual(r["other_vm_meanwhile"], "ok")

    def test_new_connection_rate_per_microvm(self):
        r = scenario("ratelimit")
        self.assertLess(r["burst_of_60_with_5_per_s"], 60)
        # 5 per second plus a burst of 10 over the burst's duration (with slack for timing)
        self.assertLessEqual(r["burst_of_60_with_5_per_s"], 10 + 5 * r["burst_seconds"] + 5)
        self.assertEqual(r["other_vm_meanwhile"], "ok")


if __name__ == "__main__":
    unittest.main()
