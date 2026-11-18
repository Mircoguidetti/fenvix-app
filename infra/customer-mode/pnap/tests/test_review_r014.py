"""Review R-014 (docs/REVIEW-R-014.md): failing tests for the host side, the guest configuration and the first-test
script of customer mode on phoenixNAP. Each test states what must hold; on claude/customer-mode-pnap at b7686fd each
one fails for the reason named in its message."""

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PNAP = os.path.join(HERE, "..")
REPO = os.path.abspath(os.path.join(PNAP, "..", "..", ".."))
sys.path.insert(0, os.path.join(PNAP, "host"))
sys.path.insert(0, PNAP)

from fenvix_host import netplan, vm  # noqa: E402
from fenvix_host.config import HostConfig  # noqa: E402

ROOT_NETNS = os.geteuid() == 0 and all(shutil.which(t) for t in ("unshare", "ip", "nft", "mkfs.ext4", "debugfs", "blkid", "setpriv"))


def scenario(mode):
    r = subprocess.run(["unshare", "--net", "--mount", "--propagation", "private", "python3", "-I",
                        os.path.join(HERE, "review_r014_scenario.py"), mode], capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise AssertionError(r.stdout[-2000:] + r.stderr[-2000:])
    return json.loads(r.stdout.strip().splitlines()[-1])


@unittest.skipUnless(ROOT_NETNS, "needs root, unshare, ip, nft, e2fsprogs and setpriv")
class HostSide(unittest.TestCase):
    def test_r1_a_guest_flooding_its_serial_console_does_not_grow_the_agents_memory(self):
        # The guest kernel has console=ttyS0 and a job is root in its VM: it can write to /dev/ttyS0 for 6 hours.
        # Firecracker writes the serial device to its stdout (no "serial" section, no rate limiter), and run_job runs
        # the jailer with capture_output=True: every byte lands in the root agent's memory (no MemoryMax on
        # fenvix-agent.service). Firecracker v1.18.0 prod-host-setup.md, "8250 Serial Device", warns of exactly this.
        d = scenario("flood")
        self.assertLess(d["rss_growth_mib"], 64, f"256 MiB of guest console output grew the agent by {d['rss_growth_mib']:.0f} MiB")

    def test_r3_summaries_are_posted_when_fenvix_post_is_not_root(self):
        # Production runs fenvix-parse and fenvix-post as their own non-root users; the agent's RuntimeDirectory
        # /run/fenvix is 0700 root, so fenvix-post cannot reach /run/fenvix/post-<jail>/summary-token. The suite's
        # own job tests run both steps as root (Users(parse=[], post=[])), which hides it.
        d = scenario("users")
        self.assertEqual(d["outcome"]["result"], "summary", d["outcome"])
        self.assertTrue(d["outcome"]["summary_sent"], f"no summary posted: {d['outcome']['detail']}")
        self.assertEqual(len(d["posted"]), 1)

    def test_r4_a_jail_left_by_an_interrupted_job_is_deleted(self):
        # Agent restart (Restart=always, KillMode=control-group kills the VMs), crash or host reboot mid-job: the
        # job's jail (its root disk, scratch disk with the customer's checkout and Docker layers, input disk with the
        # just-in-time config and cache token) stays on /srv/jailer. Cleanup only ever removes the NEW job's jail id.
        d = scenario("stale")
        self.assertFalse(d["stale_left"], "an earlier customer's jail (fxs3-j111) is still on the host's data disk")


class Bundle(unittest.TestCase):
    @unittest.skipUnless(os.geteuid() == 0 and shutil.which("setpriv"), "needs root and setpriv")
    def test_r3_the_bundle_as_the_user_data_installs_it_is_readable_by_the_service_users(self):
        # userdata.ts: "umask 077" ... "tar -xzf ... -C /opt/fenvix-host --no-same-owner" ... "chmod -R go-w". The
        # archive holds files only; GNU tar creates their directories with the umask (0700), so fenvix-parse,
        # fenvix-post and fenvix-cache cannot open read_result.py, post.py or fenvix_cache_auth.py.
        import bundle
        tmp = tempfile.mkdtemp()
        os.chmod(tmp, 0o755)
        with open(f"{tmp}/b.tgz", "wb") as f:
            f.write(bundle.build())
        os.makedirs(f"{tmp}/opt", mode=0o755)
        subprocess.run(["bash", "-c", f"umask 077; tar -xzf {tmp}/b.tgz -C {tmp}/opt --no-same-owner; chmod -R go-w {tmp}/opt"], check=True)
        for rel in ("fenvix_host/read_result.py", "fenvix_host/post.py", "cache/fenvix_cache_auth.py"):
            r = subprocess.run(["setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", "head", "-c1", f"{tmp}/opt/{rel}"], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f"a non-root service user cannot read /opt/fenvix-host/{rel}: {r.stderr.strip()}")


class HostSetup(unittest.TestCase):
    def test_r2_the_host_install_turns_smt_off(self):
        # Firecracker v1.18.0 prod-host-setup.md, "Disable SMT": recommended "in production scenarios that require
        # tenant separation". Two customers share a d3.c1.large; with SMT on, one core's two threads run two tenants.
        text = open(os.path.join(PNAP, "host", "install-host.sh")).read()
        self.assertTrue(re.search(r"smt/control|nosmt", text), "install-host.sh never disables SMT")

    def test_r10_every_microvm_disk_has_an_io_limit(self):
        # Four disks per microVM on one shared NVMe drive, no drive rate_limiter and no io.max: one job can saturate
        # the drive and the page cache for every other tenant (prod-host-setup.md, "Noisy-Neighbour Storage").
        c = HostConfig(host_id="fx-test-h1", region="ASH", slots=2)
        n = netplan.slot_net(0)
        job = vm.Job(job_id=1, runner_name="fenvix-j1", repository_id=1, run_id=1, run_attempt=1, vcpus=2, mem_mib=8192)
        cfg = vm.firecracker_config(c, n, job)
        limited = [d["drive_id"] for d in cfg["drives"] if d.get("rate_limiter")]
        io_max = any(s.startswith("io.max=") for s in vm.cgroup_settings(job))
        self.assertTrue(io_max or len(limited) == len(cfg["drives"]), f"drives with a rate limiter: {limited}; io.max: {io_max}")


FAKE_AWS_FLAKY_RELEASE = r'''#!/usr/bin/env python3
import json, os, sys
st = os.environ["FAKE_STATE"]
s = json.load(open(st)) if os.path.exists(st) else {"hosts": [], "status_calls": 0, "release_calls": 0}
a = sys.argv[1:]
payload = json.loads(a[a.index("--payload") + 1]); out = a[-1]
open(os.environ["FAKE_CALLS"], "a").write("aws " + json.dumps(payload, sort_keys=True) + "\n")
act = payload.get("action")
resp = {}
if act == "hold":
    s["hosts"] = [{"host_id": "fx-prod-ash-h1", "region": payload["region"], "role": "runner", "state": "provisioning"}]
elif act == "status":
    s["status_calls"] += 1
    for h in s["hosts"]:
        if h["state"] == "provisioning" and s["status_calls"] >= 2: h["state"] = "ready"
    resp = {"hosts": s["hosts"], "jobs": []}
elif act == "release":
    s["release_calls"] += 1
    if s["release_calls"] == 1 and os.environ.get("FAKE_FIRST_RELEASE_FAILS"):
        json.dump(s, open(st, "w"))
        print("An error occurred (TooManyRequestsException): Rate Exceeded.", file=sys.stderr); sys.exit(254)
    for h in s["hosts"]: h["state"] = "draining"
elif act == "scale":
    for h in s["hosts"]:
        if h["state"] == "draining": h["state"] = "released"
json.dump(s, open(st, "w"))
json.dump(resp, open(out, "w"))
print(json.dumps({"StatusCode": 200}))
'''

FAKE_GH_SLOW = r'''#!/usr/bin/env python3
import os, sys, time
a = sys.argv[1:]
open(os.environ["FAKE_CALLS"], "a").write("gh " + " ".join(a) + "\n")
if a[:2] == ["workflow", "run"]:
    if os.environ.get("FAKE_DISPATCH_FAILS"): sys.exit(1)
    time.sleep(float(os.environ.get("FAKE_GH_SLEEP", "0"))); sys.exit(0)
if a[:2] == ["run", "list"]:
    print("[]"); sys.exit(0)
sys.exit(2)
'''


@unittest.skipUnless(shutil.which("jq") and shutil.which("bash"), "needs jq and bash")
class FirstTestScript(unittest.TestCase):
    SCRIPT = os.path.join(PNAP, "first-test", "first-test.sh")
    ARGS = ["--region", "ASH", "--repo-a", "org-a/t", "--installation-a", "111", "--repo-b", "org-b/t", "--installation-b", "222", "--yes"]

    def setup(self, **env):
        tmp = tempfile.mkdtemp()
        for name, body in (("aws", FAKE_AWS_FLAKY_RELEASE), ("gh", FAKE_GH_SLOW)):
            p = os.path.join(tmp, name)
            with open(p, "w") as f:
                f.write(body)
            os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
        e = {**os.environ, "FENVIX_AWS": os.path.join(tmp, "aws"), "FENVIX_GH": os.path.join(tmp, "gh"), "POLL_SECONDS": "0",
             "FAKE_STATE": os.path.join(tmp, "state.json"), "FAKE_CALLS": os.path.join(tmp, "calls"), **env}
        return tmp, e

    def state(self, tmp):
        with open(os.path.join(tmp, "state.json")) as f:
            return json.load(f)

    def test_r8_a_failed_release_call_is_retried_and_the_host_released(self):
        # release() calls invoke, whose die() runs `exit 1` inside the EXIT trap: "|| true" cannot catch it, so one
        # throttled or expired-credentials call (the scaler has reserved concurrency 1 and runs every minute) ends
        # the release at once, without the wait the script promises.
        tmp, e = self.setup(FAKE_DISPATCH_FAILS="1", FAKE_FIRST_RELEASE_FAILS="1")
        r = subprocess.run(["bash", self.SCRIPT, *self.ARGS], cwd=tmp, env=e, capture_output=True, text=True, timeout=120)
        hosts = self.state(tmp)["hosts"]
        self.assertEqual([h["state"] for h in hosts], ["released"], f"the host was left live after one failed release call:\n{r.stderr[-1500:]}")

    def test_r9_the_stated_maximum_cost_covers_the_scripts_own_deadlines(self):
        # first-test.sh waits up to 90 min for a ready host, 40 min for the runs and 40 x 30 s for the release:
        # the host can be billed 3 started hours by the script's own path. The doc says "at most ≈ $2.60 (2 hours)".
        text = open(self.SCRIPT).read()
        ready = int(re.search(r"deadline=\$\(\( \$\(date \+%s\) \+ (\d+) \* 60 \)\)\nwhile", text).group(1))
        runs = int(re.findall(r"deadline=\$\(\( \$\(date \+%s\) \+ (\d+) \* 60 \)\)", text)[1])
        polls = int(re.search(r"seq 1 (\d+)", text).group(1)) * int(re.search(r'POLL="\$\{POLL_SECONDS:-(\d+)\}"', text).group(1))
        hours = -(-(ready * 60 + runs * 60 + polls) // 3600)
        doc = open(os.path.join(REPO, "docs", "CUSTOMER-MODE-PNAP.md")).read()
        stated = float(re.search(r"at most ≈ \$([0-9.]+)", doc).group(1))
        self.assertGreaterEqual(stated, round(hours * 1.27, 2), f"the script alone can keep the host {hours} started hours (${hours * 1.27:.2f} + IP)")

    def test_r11_the_test_workflow_does_not_fetch_its_probe_from_our_private_repository(self):
        # The workflow downloads probe.sh from raw.githubusercontent.com/Mircoguidetti/fenvix-app/claude/customer-mode-pnap,
        # a PRIVATE repository: unauthenticated, that URL answers 404 (checked 2026-11-18), so every run fails before
        # a single probe and the first test can never pass. The branch name also dies with the merge.
        wf = subprocess.run(["bash", self.SCRIPT, "--print-workflow"], capture_output=True, text=True, check=True).stdout
        fetches_private = re.search(r"raw\.githubusercontent\.com", wf) and "Mircoguidetti/fenvix-app" in wf
        self.assertFalse(fetches_private, "the test workflow fetches probe.sh from the private fenvix-app repository")


if __name__ == "__main__":
    unittest.main()
