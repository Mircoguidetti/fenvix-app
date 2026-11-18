"""first-test.sh with stand-ins for `aws` (the scaler function) and `gh` (the two test repositories): the order of
calls, the report, and above all that the host is released on every exit path."""

import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "first-test", "first-test.sh")

FAKE_AWS = r'''#!/usr/bin/env python3
import json, os, sys
st = os.environ["FAKE_STATE"]
s = json.load(open(st)) if os.path.exists(st) else {"hosts": [], "status_calls": 0}
a = sys.argv[1:]
payload = json.loads(a[a.index("--payload") + 1]); out = a[-1]
open(os.environ["FAKE_CALLS"], "a").write("aws " + json.dumps(payload, sort_keys=True) + "\n")
act = payload.get("action")
resp = {}
if act == "hold":
    s["hosts"] = [{"host_id": "fx-prod-ash-h1", "region": payload["region"], "role": "runner", "state": "provisioning"}]
    resp = {"actions": [{"kind": "order", "region": payload["region"], "result": "ordered"}]}
elif act == "status":
    s["status_calls"] += 1
    for h in s["hosts"]:
        if h["state"] == "provisioning" and s["status_calls"] >= 2: h["state"] = "ready"
    jobs = [{"job_id": j, "queued_at": "2026-11-18T10:00:00.123Z", "leased_at": "2026-11-18T10:00:04.5Z",
             "timings": {"start": 100.0, "prepared": 101.5, "vm_exit": 190.0}} for j in (71, 72, 73)]
    resp = {"hosts": s["hosts"], "jobs": jobs}
elif act == "release":
    for h in s["hosts"]: h["state"] = "draining"
elif act == "scale":
    for h in s["hosts"]:
        if h["state"] == "draining": h["state"] = "released"
json.dump(s, open(st, "w"))
json.dump(resp, open(out, "w"))
print(json.dumps({"StatusCode": 200}))
'''

FAKE_GH = r'''#!/usr/bin/env python3
import datetime, json, os, sys
a = sys.argv[1:]
open(os.environ["FAKE_CALLS"], "a").write("gh " + " ".join(a) + "\n")
repo = a[a.index("-R") + 1] if "-R" in a else ""
if a[:2] == ["workflow", "run"]:
    if os.environ.get("FAKE_DISPATCH_FAILS"): sys.exit(1)
    sys.exit(0)
ids = {"org-a/t": [11, 12], "org-b/t": [21]}
if a[:2] == ["run", "list"]:
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(json.dumps([{"databaseId": i, "status": "completed", "conclusion": "success", "createdAt": now} for i in ids.get(repo, [])])); sys.exit(0)
if a[:2] == ["run", "view"]:
    rid = int(a[2])
    if "--log" in a:
        org = "gh-111" if repo == "org-a/t" else "gh-222"
        bad = os.environ.get("FAKE_PROBE_FAIL") and rid == 21
        print(f"x FENVIX-PROBE metadata_169.254.169.254 blocked {'ok' if bad else 'blocked'} {'FAIL' if bad else 'PASS'}")
        print("x FENVIX-PROBE internet_https ok ok PASS")
        print(f"x FENVIX-INFO cache organization {org} access write"); sys.exit(0)
    q = a[a.index("-q") + 1]
    if q == ".conclusion": print("failure" if os.environ.get("FAKE_PROBE_FAIL") and rid == 21 else "success")
    elif q == ".jobs[0].databaseId": print({11: 71, 12: 72, 21: 73}[rid])
    sys.exit(0)
sys.exit(2)
'''


@unittest.skipUnless(shutil.which("jq") and shutil.which("bash"), "needs jq and bash")
class FirstTest(unittest.TestCase):
    def run_script(self, **env):
        tmp = tempfile.mkdtemp()
        for name, body in (("aws", FAKE_AWS), ("gh", FAKE_GH)):
            p = os.path.join(tmp, name)
            with open(p, "w") as f:
                f.write(body)
            os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
        calls = os.path.join(tmp, "calls")
        e = {**os.environ, "FENVIX_AWS": os.path.join(tmp, "aws"), "FENVIX_GH": os.path.join(tmp, "gh"), "POLL_SECONDS": "0",
             "FAKE_STATE": os.path.join(tmp, "state.json"), "FAKE_CALLS": calls, **env}
        r = subprocess.run(["bash", SCRIPT, "--region", "ASH", "--repo-a", "org-a/t", "--installation-a", "111", "--repo-b", "org-b/t",
                            "--installation-b", "222", "--minutes", "60", "--yes"], cwd=tmp, env=e, capture_output=True, text=True, timeout=120)
        lines = []
        if os.path.exists(calls):
            with open(calls) as f:
                lines = f.read().splitlines()
        aws = [json.loads(l[4:]) for l in lines if l.startswith("aws ")]
        report = ""
        for f in os.listdir(tmp):
            if f.startswith("fenvix-first-test-") and f.endswith(".md"):
                with open(os.path.join(tmp, f)) as fh:
                    report = fh.read()
        return r, aws, lines, report

    def test_the_whole_test_passes_and_releases_the_host(self):
        r, aws, lines, report = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        acts = [a["action"] for a in aws]
        self.assertEqual(acts[:3], ["set-region", "set-region", "hold"])
        self.assertEqual({(a.get("installationId"), a.get("region")) for a in aws[:2]}, {(111, "ASH"), (222, "ASH")})
        self.assertEqual(aws[2], {"action": "hold", "region": "ASH", "hosts": 1, "minutes": 60})
        self.assertIn("release", acts)
        self.assertEqual(sum(1 for l in lines if l.startswith("gh workflow run")), 3)
        self.assertIn("Result: PASS", report)
        self.assertIn("Host released: yes", report)
        self.assertIn("| gh-111 |", report)
        self.assertIn("| gh-222 |", report)
        # queued -> leased (whole seconds), leased -> microVM up, microVM lifetime, from the job record
        self.assertIn("| 71 | 4 s | 1.5 s | 89 s |", report)

    def test_a_failure_midway_still_releases_the_host(self):
        r, aws, _, _ = self.run_script(FAKE_DISPATCH_FAILS="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("release", [a["action"] for a in aws])
        self.assertIn("released: no host of ASH left", r.stderr)

    def test_a_failed_probe_fails_the_test_and_still_releases(self):
        r, aws, _, report = self.run_script(FAKE_PROBE_FAIL="1")
        self.assertEqual(r.returncode, 1)
        self.assertIn("Result: FAIL", report)
        self.assertIn("metadata_169.254.169.254 blocked ok FAIL", report)
        self.assertIn("release", [a["action"] for a in aws])


if __name__ == "__main__":
    unittest.main()
