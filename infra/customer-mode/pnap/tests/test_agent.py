"""The host agent against a local stand-in of the App's host routes (/v1/hosts/enrol, /v1/hosts/lease)."""

import http.server
import json
import os
import stat
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "host"))
from fenvix_host.agent import Agent, ControlPlane  # noqa: E402
from fenvix_host.job import Outcome  # noqa: E402

ENROL = "fxe1.fx-nld-h7." + "s" * 43
CRED1 = "fxh1.eyJoIjoiZngtbmxkLWg3In0." + "a" * 43
CRED2 = "fxh1.eyJoIjoiZngtbmxkLWg3IiwiZyI6Mn0." + "b" * 43


def lease_job(job_id, **kw):
    d = {"jobId": job_id, "runnerName": f"fenvix-j{job_id}", "repositoryId": 10, "runId": 20, "runAttempt": 1, "vcpus": 2,
         "memMib": 8192, "jitConfig": "aml0LWNvbmZpZy1mb3ItdGVzdHM=", "summaryToken": "fxr1.e30.c2ln", "cacheAccess": "read"}
    d.update(kw)
    return d


class FakeApp(http.server.BaseHTTPRequestHandler):
    calls: list = []
    enrolled = False
    queue: list = []
    drain = False

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        auth = self.headers["authorization"].removeprefix("Bearer ")
        FakeApp.calls.append((self.path, auth, body))
        if self.path == "/v1/hosts/enrol":
            if auth != ENROL or FakeApp.enrolled:
                return self.answer(401, {})
            FakeApp.enrolled = True
            return self.answer(200, {"credential": CRED1, "config": {
                "host_id": "fx-nld-h7", "region": "NLD", "slots": 2, "control_url": "http://127.0.0.1",
                "cache": {"mode": "dedicated", "ip": "10.0.0.60", "port": 8787}}})
        if self.path == "/v1/hosts/lease":
            if auth not in (CRED1, CRED2):
                return self.answer(401, {})
            jobs = FakeApp.queue[: body["free"]]
            del FakeApp.queue[: len(jobs)]
            return self.answer(200, {"jobs": jobs, "drain": FakeApp.drain, "credential": CRED2})
        self.answer(404, {})

    def answer(self, code, doc):
        data = json.dumps(doc).encode()
        self.send_response(code)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


class AgentTest(unittest.TestCase):
    def setUp(self):
        FakeApp.calls, FakeApp.enrolled, FakeApp.queue, FakeApp.drain = [], False, [], False
        self.srv = http.server.HTTPServer(("127.0.0.1", 0), FakeApp)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.tmp = tempfile.mkdtemp()
        self.etc, self.state = f"{self.tmp}/etc", f"{self.tmp}/state"
        os.makedirs(self.etc)
        with open(f"{self.etc}/enrol", "w") as f:
            f.write(ENROL)
        self.ran = []
        self.release = threading.Event()

        def runner(cfg, slot, spec):
            self.ran.append((slot, spec.job.job_id, spec.cache_org))
            self.release.wait(5)
            return Outcome(job_id=spec.job.job_id, slot=slot, result="summary", summary_sent=True, timings={"start": 1.0})

        self.agent = Agent(ControlPlane(f"http://127.0.0.1:{self.srv.server_port}"), state_dir=self.state, etc_dir=self.etc,
                           runner=runner, host_facts={"pub_if": "bond0", "host_addrs": ["203.0.113.7"]},
                           route_dev=lambda ip: "bond0.12")

    def tearDown(self):
        self.release.set()
        self.srv.shutdown()

    def wait(self, cond, s=5):
        end = time.time() + s
        while time.time() < end and not cond():
            time.sleep(0.02)
        self.assertTrue(cond())

    def test_enrolment_is_single_use_and_leaves_only_root_files(self):
        self.agent.enrol()
        self.assertFalse(os.path.exists(f"{self.etc}/enrol"))
        for f in (f"{self.state}/host-credential", f"{self.etc}/host.json"):
            self.assertEqual(stat.S_IMODE(os.stat(f).st_mode), 0o400, f)
        self.assertEqual(open(f"{self.state}/host-credential").read(), CRED1)
        cfg = json.load(open(f"{self.etc}/host.json"))
        self.assertEqual((cfg["region"], cfg["pub_if"], cfg["host_addrs"], cfg["cache"]["iface"]), ("NLD", "bond0", ["203.0.113.7"], "bond0.12"))
        # A restart reads its files and never enrols again (the App would refuse the spent secret).
        again = Agent(self.agent.cp, state_dir=self.state, etc_dir=self.etc)
        again.enrol()
        self.assertEqual(again.cred, CRED1)
        self.assertEqual(sum(1 for c in FakeApp.calls if c[0] == "/v1/hosts/enrol"), 1)

    def test_leases_only_for_free_slots_reports_outcomes_and_renews_its_credential(self):
        self.agent.enrol()
        FakeApp.queue = [lease_job(1, cacheOrg="gh-5", cacheToken="fxs1.e30.c2ln"), lease_job(2), lease_job(3)]
        self.agent.tick()
        self.wait(lambda: len(self.ran) == 2)
        self.assertEqual(sorted(s for s, _, _ in self.ran), [0, 1])
        self.assertEqual(FakeApp.calls[-1][2]["free"], 2)
        self.assertEqual(open(f"{self.state}/host-credential").read(), CRED2, "renewed credential kept")
        self.agent.tick()  # both slots busy: asks for none
        self.assertEqual(FakeApp.calls[-1][2]["free"], 0)
        self.assertEqual(sorted(FakeApp.calls[-1][2]["running"]), [1, 2])
        self.release.set()
        self.wait(lambda: not self.agent.running)
        self.agent.tick()
        done = FakeApp.calls[-1][2]["done"]
        self.assertEqual(sorted(d["jobId"] for d in done), [1, 2])
        self.assertTrue(all(d["result"] == "summary" for d in done))
        self.wait(lambda: not self.agent.running)  # job 3 was leased by the tick above and has finished too
        self.agent.tick()
        self.assertEqual([d["jobId"] for d in FakeApp.calls[-1][2]["done"]], [3])
        self.agent.tick()
        self.assertEqual(FakeApp.calls[-1][2]["done"], [], "an outcome is sent until accepted, then never again")

    def test_a_malformed_job_is_refused_and_reported(self):
        self.agent.enrol()
        FakeApp.queue = [lease_job(9, summaryToken="fxs1.e30.c2ln")]  # a cache token where the summary credential goes
        self.agent.tick()
        self.assertEqual(self.ran, [])
        self.agent.tick()
        self.assertEqual([(d["jobId"], d["result"]) for d in FakeApp.calls[-1][2]["done"]], [(9, "error")])

    def test_drain_stops_new_work(self):
        self.agent.enrol()
        FakeApp.drain = True
        self.agent.tick()
        FakeApp.queue = [lease_job(4)]
        self.agent.tick()
        self.assertTrue(self.agent.draining)
        self.assertEqual(FakeApp.calls[-1][2]["free"], 0)
        self.assertTrue(FakeApp.calls[-1][2]["draining"])
        self.assertEqual(self.ran, [])


if __name__ == "__main__":
    unittest.main()
