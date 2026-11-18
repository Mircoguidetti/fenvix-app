"""The mechanisms behind the R-014 fixes (docs/REPORT-customer-mode-pnap-2.md), each on its own, beside the
reviewer's tests (test_review_r014.py):

  R1  the VMM's output is drained into a bounded tail; the agent waits on the microVM's cgroup, not on the jailer
      (with --new-pid-ns the jailer exits as soon as Firecracker is cloned); the agent's own cgroup leaf is capped
  R2  the agent refuses a host with SMT, KSM or swap on
  R3  the cache's public key is world-readable under a traversable /etc/fenvix, whatever the agent's umask
  R4  the agent's start removes every jail, staging and post directory and every microVM cgroup an earlier run left
  R11 the printed workflow carries probe.sh byte for byte, and its SHA-256 check passes
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PNAP = os.path.join(HERE, "..")
sys.path.insert(0, os.path.join(PNAP, "host"))

from fenvix_host import agent, job, vm  # noqa: E402
from fenvix_host.config import HostConfig  # noqa: E402


def script(tmp, name, body):
    p = os.path.join(tmp, name)
    with open(p, "w") as f:
        f.write("#!/usr/bin/env python3\n" + body)
    os.chmod(p, 0o755)
    return p


class VmmOutputAndWait(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cg = f"{self.tmp}/cg"
        os.makedirs(self.cg)

    def events(self, populated):
        with open(f"{self.cg}/cgroup.events", "w") as f:
            f.write(f"populated {populated}\nfrozen 0\n")

    def test_the_tail_keeps_only_the_last_bytes(self):
        r, w = os.pipe()
        t = job.Tail(1000)
        th = threading.Thread(target=t.drain, args=(os.fdopen(r, "rb"),))
        th.start()
        with os.fdopen(w, "wb") as f:
            for i in range(300):
                f.write(bytes([65 + i % 26]) * 997)
        th.join(5)
        self.assertEqual(len(t.buf), 1000)
        self.assertEqual(bytes(t.buf[-997:]), bytes([65 + 299 % 26]) * 997)

    def test_waits_for_the_microvm_after_the_jailer_exits(self):
        # The jailer exits 0 at once (as with --new-pid-ns); the microVM's cgroup stays populated for a while.
        jailer = script(self.tmp, "jailer", "import sys; print('cloned'); sys.exit(0)\n")
        self.events(1)
        threading.Timer(0.8, self.events, args=(0,)).start()
        sh = job.Shell()
        sh.poll_s = 0.05
        t0 = time.monotonic()
        r = sh.vm([jailer], cgroup=self.cg, timeout=30)
        self.assertGreaterEqual(time.monotonic() - t0, 0.7, "the result must not be read while the guest still runs")
        self.assertEqual((r.returncode, r.timed_out), (0, False))
        self.assertIn(b"cloned", r.tail)

    def test_a_microvm_past_its_time_is_killed_through_its_cgroup(self):
        jailer = script(self.tmp, "jailer", "import sys; sys.exit(0)\n")
        self.events(1)
        sh = job.Shell()
        sh.poll_s = 0.05
        r = sh.vm([jailer], cgroup=self.cg, timeout=0.5)
        self.assertTrue(r.timed_out)
        self.assertEqual(open(f"{self.cg}/cgroup.kill").read(), "1")

    def test_a_flood_after_the_jailer_exits_stays_bounded(self):
        # Firecracker keeps the jailer's stdout after the jailer exits: a child that floods it for a while.
        jailer = script(self.tmp, "jailer", (
            "import os, sys\n"
            "if os.fork() == 0:\n"
            "    chunk = b'y' * 65536\n"
            "    for _ in range(1024): os.write(1, chunk)\n"
            "    os._exit(0)\n"
            "sys.exit(0)\n"))
        r = job.Shell().vm([jailer], cgroup=self.cg + "-none", timeout=60)
        self.assertLessEqual(len(r.tail), vm.CONSOLE_TAIL_BYTES)

    def test_the_serial_console_is_rate_limited_in_the_firecracker_config(self):
        from fenvix_host import netplan

        c = HostConfig(host_id="fx-test-h1", region="ASH", slots=2)
        j = vm.Job(job_id=1, runner_name="fenvix-j1", repository_id=1, run_id=1, run_attempt=1, vcpus=2, mem_mib=8192)
        cfg = vm.firecracker_config(c, netplan.slot_net(0), j)
        self.assertEqual(cfg["serial"]["rate_limiter"]["size"], vm.SERIAL_BYTES_PER_S)
        self.assertNotIn("serial_out_path", cfg["serial"], "no file the guest could fill")
        for d in cfg["drives"]:
            self.assertEqual(d["rate_limiter"]["bandwidth"]["size"], c.disk_bytes_per_s, d["drive_id"])

    def test_the_agents_own_cgroup_leaf_has_a_memory_limit(self):
        root = f"{self.tmp}/sys"
        parent = "system.slice/fenvix-agent.service/vms"
        os.makedirs(f"{root}/system.slice/fenvix-agent.service")
        open(f"{root}/cgroup.controllers", "w").close()
        agent.prepare_cgroups(parent, root=root)
        self.assertEqual(int(open(f"{root}/system.slice/fenvix-agent.service/agent/memory.max").read()), agent.AGENT_MEMORY_MAX)
        self.assertLessEqual(agent.AGENT_MEMORY_MAX, 4 * 1024**3)


class Hygiene(unittest.TestCase):
    def fake(self, smt="0", ksm="0", swaps=""):
        tmp = tempfile.mkdtemp()
        for path, text in ((f"{tmp}/sys/devices/system/cpu/smt/active", smt), (f"{tmp}/sys/kernel/mm/ksm/run", ksm),
                           (f"{tmp}/proc/swaps", "Filename Type Size Used Priority\n" + swaps)):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(text + "\n")
        return f"{tmp}/sys", f"{tmp}/proc"

    def test_a_safe_host_passes(self):
        agent.check_host_hygiene(*self.fake())

    def test_smt_ksm_or_swap_stop_the_agent_before_enrolment(self):
        for kw, word in ((dict(smt="1"), "SMT"), (dict(ksm="1"), "KSM"), (dict(swaps="/swap.img file 8388604 0 -2"), "swap")):
            with self.assertRaisesRegex(agent.UnsafeHost, word):
                agent.check_host_hygiene(*self.fake(**kw))

    def test_run_forever_checks_before_it_enrols(self):
        a = agent.Agent(agent.ControlPlane("http://127.0.0.1:1"), state_dir=tempfile.mkdtemp(), etc_dir=tempfile.mkdtemp())
        calls = []
        a.enrol = lambda: calls.append("enrol")  # type: ignore[method-assign]
        orig = agent.check_host_hygiene
        agent.check_host_hygiene = lambda: (_ for _ in ()).throw(agent.UnsafeHost("SMT is active"))
        try:
            with self.assertRaises(agent.UnsafeHost):
                a.run_forever()
        finally:
            agent.check_host_hygiene = orig
        self.assertEqual(calls, [])


class Sweep(unittest.TestCase):
    def test_every_left_over_of_an_interrupted_run_is_removed_at_start(self):
        tmp = tempfile.mkdtemp()
        c = HostConfig(host_id="fx-test-h1", region="ASH", slots=4, chroot_base=f"{tmp}/jailer")
        for jid in ("fxs0-j11", "fxs3-j12"):
            os.makedirs(f"{tmp}/jailer/firecracker/{jid}/root")
            with open(f"{tmp}/jailer/firecracker/{jid}/root/scratch.ext4", "w") as f:
                f.write("a customer's checkout")
        os.makedirs(f"{tmp}/run/staging-fxs1-j13")
        os.makedirs(f"{tmp}/run/post-fxs2-j14")
        os.makedirs(f"{tmp}/run/keep-me")
        cgroot = f"{tmp}/cg"
        os.makedirs(f"{cgroot}/{c.parent_cgroup}")  # no stale cgroup here: removal needs a real cgroupfs
        ran = []

        def run(argv, **kw):
            ran.append(argv)
            out = "fxvm3 (id: 7)\nfxvm1-guest\nsomething-else\n" if argv[:3] == ["ip", "netns", "list"] else ""
            return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")

        gone = agent.sweep_stale(c, cgroup_root=cgroot, staging_base=f"{tmp}/run", run=run)
        self.assertEqual(os.listdir(f"{tmp}/jailer/firecracker"), [])
        self.assertEqual(os.listdir(f"{tmp}/run"), ["keep-me"])
        self.assertEqual([a for a in ran if a[0] == "pkill"], [["pkill", "-KILL", "-u", str(900000 + s)] for s in range(4)])
        self.assertIn(["ip", "netns", "del", "fxvm3"], ran)
        self.assertIn(["ip", "netns", "del", "fxvm1"], ran)
        self.assertNotIn(["ip", "netns", "del", "something-else"], ran)
        self.assertIn("netns fxvm3", gone)

    def test_prepare_host_sweeps_before_anything_else(self):
        src = open(os.path.join(PNAP, "host", "fenvix_host", "agent.py")).read()
        body = src[src.index("def prepare_host"):src.index("def run_forever")]
        self.assertLess(body.index("sweep_stale(self.cfg)"), body.index("host_ruleset"))


class Network(unittest.TestCase):
    def test_each_microvm_namespace_caps_its_own_connections(self):
        from fenvix_host import netplan

        t = netplan.vm_ruleset(netplan.slot_net(2), 4096)
        self.assertIn('iifname "tap0" ct state new add @conn { ip saddr ct count over 4096 } counter drop', t)
        self.assertLess(t.index("ct count over"), t.index('ip saddr 172.16.0.2 accept'), "the cap comes before the accept")
        src = open(os.path.join(PNAP, "host", "fenvix_host", "job.py")).read()
        self.assertIn("netplan.vm_ruleset(n, c.conn_limit)", src)

    def test_a_flushed_host_table_is_reloaded_and_otherwise_forwarding_stops(self):
        a = agent.Agent(agent.ControlPlane("http://127.0.0.1:1"), state_dir=tempfile.mkdtemp(), etc_dir=tempfile.mkdtemp())
        a.cfg = HostConfig(host_id="fx-test-h1", region="ASH", slots=2)
        for table_there, reload_ok, may_lease, expect in (
                (True, True, True, [["nft", "list"]]),
                (False, True, True, [["nft", "list"], ["nft", "-f"]]),
                (False, False, False, [["nft", "list"], ["nft", "-f"], ["sysctl", "-q"]])):
            ran = []

            def run(argv, **kw):
                ran.append(argv)
                ok = table_there if argv[:2] == ["nft", "list"] else reload_ok if argv[:2] == ["nft", "-f"] else True
                return subprocess.CompletedProcess(argv, 0 if ok else 1)

            self.assertEqual(a.ensure_host_table(run=run), may_lease)
            self.assertEqual([x[:2] for x in ran], expect)
            if not may_lease:
                self.assertIn("net.ipv4.ip_forward=0", ran[-1])


class PublicKey(unittest.TestCase):
    def test_the_cache_key_is_readable_by_another_user_whatever_the_umask(self):
        tmp = tempfile.mkdtemp()
        etc = f"{tmp}/etc"
        os.makedirs(etc, mode=0o700)
        old = os.umask(0o077)
        try:
            agent.write_public_key(etc, {"n": "ab", "e": 65537})
        finally:
            os.umask(old)
        self.assertEqual(stat.S_IMODE(os.stat(etc).st_mode) & 0o001, 0o001)
        self.assertEqual(stat.S_IMODE(os.stat(f"{etc}/cache").st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(os.stat(f"{etc}/cache/signing-key.json").st_mode), 0o644)
        if os.geteuid() == 0 and shutil.which("setpriv"):
            os.chmod(tmp, 0o755)
            r = subprocess.run(["setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", "cat", f"{etc}/cache/signing-key.json"],
                               capture_output=True, text=True)
            self.assertEqual(json.loads(r.stdout), {"n": "ab", "e": 65537}, r.stderr)


PROD_USERS = all(u in {p.pw_name for p in __import__("pwd").getpwall()} for u in ("fenvix-parse", "fenvix-post", "fenvix-cache"))


@unittest.skipUnless(os.geteuid() == 0 and PROD_USERS and all(shutil.which(t) for t in ("unshare", "ip", "nft", "runuser", "mkfs.ext4", "debugfs")),
                     "needs root and the production accounts (install-host.sh step 3: useradd --system fenvix-parse fenvix-post fenvix-cache)")
class ProductionUsers(unittest.TestCase):
    """R-014 R3 as production runs it: the bundle extracted by the user data's own lines, runuser to the real
    accounts, the agent's runtime directory as systemd makes it. No stand-in uid, no Users() override."""

    def scenario(self, mode):
        r = subprocess.run(["unshare", "--net", "--mount", "--propagation", "private", "python3", "-I",
                            os.path.join(HERE, "production_users_scenario.py"), mode], capture_output=True, text=True, timeout=300)
        self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])
        return json.loads(r.stdout.strip().splitlines()[-1])

    def test_a_job_posts_its_summary_as_fenvix_parse_and_fenvix_post(self):
        d = self.scenario("job")
        self.assertEqual(d["post_uid"], __import__("pwd").getpwnam("fenvix-post").pw_uid)
        self.assertEqual(d["outcome"]["result"], "summary", d["outcome"])
        self.assertTrue(d["outcome"]["summary_sent"], d["outcome"]["detail"])
        self.assertEqual(len(d["posted"]), 1)
        self.assertEqual(d["posted"][0]["auth"], "Bearer fxr1.eyJuIjoiZmVudml4LWo1NTUwMDAzIn0.c2lnbmF0dXJlLW9mLXRoZS1hcHA")

    def test_the_colocated_cache_starts_as_fenvix_cache_with_the_agents_key(self):
        d = self.scenario("cache")
        self.assertTrue(d["alive"], d["stderr"])
        self.assertEqual(d["status"], 401, "the cache answers, and refuses a request without a token")


class InlineProbe(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node") and os.path.isdir(os.path.join(PNAP, "..", "..", "..", "github-app", "node_modules", "yaml")),
                         "needs node and github-app's node_modules (yaml)")
    def test_the_printed_workflow_recreates_probe_sh_and_its_check_passes(self):
        wf = subprocess.run(["bash", os.path.join(PNAP, "first-test", "first-test.sh"), "--print-workflow"], capture_output=True, text=True, check=True).stdout
        self.assertNotIn("curl", wf.split("cat >probe.sh")[0])
        tmp = tempfile.mkdtemp()
        with open(f"{tmp}/wf.yml", "w") as f:
            f.write(wf)
        yaml = os.path.join(PNAP, "..", "..", "..", "github-app", "node_modules", "yaml")
        js = ("const {parse}=require(process.argv[1]);const w=parse(require('fs').readFileSync(process.argv[2],'utf8'));"
              "const st=w.jobs.isolation.steps[0];process.stdout.write(JSON.stringify({run:st.run,env:st.env}))")
        step = json.loads(subprocess.run(["node", "-e", js, os.path.abspath(yaml), f"{tmp}/wf.yml"], capture_output=True, text=True, check=True).stdout)
        # Everything up to the SHA-256 check, as the runner would run it (bash, with the step's env).
        lines = step["run"].replace("${{ inputs.nonce }}", "n").split("\n")
        upto = next(i for i, x in enumerate(lines) if x.startswith("echo \"${PROBE_SHA256}"))
        with open(f"{tmp}/step.sh", "w") as f:
            f.write("\n".join(lines[: upto + 1]) + "\n")
        r = subprocess.run(["bash", f"{tmp}/step.sh"], cwd=tmp, env={**os.environ, **{k: str(v) for k, v in step["env"].items()}},
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(open(f"{tmp}/probe.sh", "rb").read(), open(os.path.join(PNAP, "first-test", "probe.sh"), "rb").read())


if __name__ == "__main__":
    unittest.main()
