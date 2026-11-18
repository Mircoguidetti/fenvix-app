"""One job end to end on the host, except the VMM (fake_jailer.py): see job_scenario.py."""

import json
import os
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CAN = os.geteuid() == 0 and all(shutil.which(t) for t in ("unshare", "ip", "nft", "mkfs.ext4", "debugfs", "blkid"))


def scenario(mode):
    r = subprocess.run(["unshare", "--net", "--mount", "--propagation", "private", "python3", "-I", os.path.join(HERE, "job_scenario.py"), mode],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise AssertionError(r.stdout + r.stderr)
    return json.loads(r.stdout.strip().splitlines()[-1])


NOTHING_LEFT = {"jail": False, "run_dir_entries": [], "netns": False, "root_link": False}


@unittest.skipUnless(CAN, "needs root, unshare, ip, nft and e2fsprogs")
class Job(unittest.TestCase):
    def test_a_job_runs_and_its_summary_is_posted_with_the_hosts_ids_and_its_own_credential(self):
        d = scenario("ok")
        self.assertEqual(d["outcome"]["result"], "summary")
        self.assertTrue(d["outcome"]["summary_sent"])
        self.assertEqual(len(d["posted"]), 1)
        p = d["posted"][0]
        self.assertEqual(p["auth"], "Bearer fxr1.eyJuIjoiZmVudml4LWo1NTUwMDAxIn0.c2lnbmF0dXJlLW9mLXRoZS1hcHA")
        # repositoryId 999999 in the guest's record is ignored: the ids are the host's.
        self.assertEqual({k: p["body"][k] for k in ("repositoryId", "runId", "runAttempt", "runnerName")},
                         {"repositoryId": 4242, "runId": 9001, "runAttempt": 2, "runnerName": "fenvix-j5550001"})
        self.assertEqual(d["left"], NOTHING_LEFT)
        for k in ("prepared", "vm_exit", "t_guest_up", "end"):
            self.assertIn(k, d["outcome"]["timings"])

    def test_what_the_vmm_is_given(self):
        seen = scenario("ok")["seen"]
        self.assertTrue(seen["netns_exists"])
        # every file in the jail belongs to the slot's uid (900003), private
        for name, (uid, mode) in seen["owners"].items():
            self.assertEqual(uid, 900003, name)
            self.assertIn(mode, ("0o600", "0o400"), name)
        # the input disk: the just-in-time config, the cache token and plain settings; never the summary credential
        self.assertEqual(set(seen["input"]), {"jitconfig", "cache-token", "job.env"})
        self.assertNotIn("fxr1.", json.dumps(seen["input"]))
        self.assertIn("FENVIX_CACHE_URL=http://10.201.0.2:8787/gh-77", seen["input"]["job.env"])
        self.assertEqual(seen["scratch_label"], "fxscratch")
        self.assertEqual(seen["config_drives"], ["rootfs.ext4", "input.ext4", "result.img", "scratch.ext4"])

    def test_an_escaped_vmm_cannot_make_the_host_post_another_tenants_result(self):
        d = scenario("symlink")
        self.assertEqual(d["outcome"]["result"], "unsafe-result")
        self.assertEqual(d["posted"], [])
        self.assertEqual(d["left"], NOTHING_LEFT)

    def test_no_record_and_a_hung_guest_end_cleanly(self):
        for mode, result in (("garbage", "no-summary"), ("hang", "timeout")):
            d = scenario(mode)
            self.assertEqual(d["outcome"]["result"], result)
            self.assertEqual(d["posted"], [])
            self.assertEqual(d["left"], NOTHING_LEFT)


if __name__ == "__main__":
    unittest.main()
