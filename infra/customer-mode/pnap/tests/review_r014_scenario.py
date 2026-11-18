"""Review R-014: one job through fenvix_host.job.run_job, like job_scenario.py, in the situations the review found
broken. Run inside `unshare --net --mount` as root; prints JSON.

  python3 -I review_r014_scenario.py MODE
    flood   the guest writes 256 MiB to its serial console (Firecracker's stdout); reports the agent's memory growth
    users   production users: fenvix-parse and fenvix-post are a real non-root uid (65534), the package is installed
            world-readable, and the staging base is 0700 root like systemd's RuntimeDirectory=fenvix
    stale   a jail left on the data disk by an earlier job of the same slot (the agent was restarted mid-job)
"""

import http.server
import json
import os
import resource
import shutil
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
FLOOD_MIB = 256

FLOOD_JAILER = r'''#!/usr/bin/env python3
import os, sys
chunk = b"x" * (1 << 20)
for _ in range(%d):
    sys.stdout.buffer.write(chunk)
sys.stdout.flush()
sys.exit(0)
''' % FLOOD_MIB

posted = []


class App(http.server.BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers["content-length"]))
        posted.append({"path": self.path, "body": json.loads(body)})
        self.send_response(202)
        self.end_headers()

    def log_message(self, *a):
        pass


def main(mode):
    os.makedirs("/run/netns", exist_ok=True)
    subprocess.run(["mount", "-t", "tmpfs", "none", "/run/netns"], check=True)
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    srv = http.server.HTTPServer(("127.0.0.1", 0), App)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    tmp = tempfile.mkdtemp()
    os.chmod(tmp, 0o755)
    # The host package as install puts it: world-readable (what the user data SHOULD produce, see test R3a).
    pkg = f"{tmp}/opt"
    shutil.copytree(os.path.join(HERE, "..", "host"), pkg, ignore=shutil.ignore_patterns("__pycache__"))
    for d, dirs, files in os.walk(pkg):
        os.chmod(d, 0o755)
        for f in files:
            os.chmod(os.path.join(d, f), 0o644)
    sys.path.insert(0, pkg)
    from fenvix_host.config import Cache, HostConfig
    from fenvix_host.job import JobSpec, Users, run_job

    for name, size in (("rootfs.ext4", 1 << 20), ("vmlinux", 4096)):
        with open(f"{tmp}/{name}", "wb") as f:
            f.truncate(size)
    jailer = os.path.join(HERE, "fake_jailer.py")
    if mode == "flood":
        jailer = f"{tmp}/flood_jailer.py"
        with open(jailer, "w") as f:
            f.write(FLOOD_JAILER)
        os.chmod(jailer, 0o755)
    c = HostConfig(host_id="fx-test-h1", region="NLD", slots=4, scratch_gib=4, chroot_base=f"{tmp}/jailer", jailer=jailer,
                   kernel=f"{tmp}/vmlinux", rootfs=f"{tmp}/rootfs.ext4",
                   summaries_url=f"http://127.0.0.1:{srv.server_port}/v1/runner/summaries", cache=Cache(mode="colocated"), pub_if="lo")
    spec = JobSpec.from_lease({
        "jobId": 5550002, "runnerName": "fenvix-j5550002", "repositoryId": 4242, "runId": 9002, "runAttempt": 1,
        "vcpus": 2, "memMib": 8192, "jitConfig": "ZmFrZS1qaXQtY29uZmlnLWZvci10ZXN0cw==",
        "summaryToken": "fxr1.eyJuIjoiZmVudml4LWo1NTUwMDAyIn0.c2lnbmF0dXJlLW9mLXRoZS1hcHA",
        "cacheToken": "fxs1.eyJvcmciOiJnaC03NyJ9.cnNhLXNpZ25hdHVyZQ", "cacheOrg": "gh-77", "cacheAccess": "read",
    })
    os.environ.update(FAKE_JAILER_MODE="ok", FAKE_WITNESS=f"{tmp}/witness.json", FAKE_OTHER_RESULT="/nonexistent")
    users = Users(parse=[], post=[])
    staging = f"{tmp}/run"
    if mode == "users":
        nobody = ["setpriv", "--reuid=65534", "--regid=65534", "--clear-groups"]
        users = Users(parse=nobody, post=nobody, post_uid=65534)
        os.makedirs(staging, mode=0o700)  # systemd: RuntimeDirectory=fenvix, RuntimeDirectoryMode=0700, owned by root
    stale = f"{c.chroot_base}/firecracker/fxs3-j111/root"
    if mode == "stale":
        os.makedirs(stale, mode=0o700)
        with open(f"{stale}/scratch.ext4", "w") as f:
            f.write("CUSTOMER-A source tree, docker layers, _work with secrets")
    before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    out = run_job(c, 3, spec, users=users, staging_base=staging, timeout_s=120)
    grown_kib = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss - before
    print(json.dumps({"outcome": out.__dict__, "posted": posted, "rss_growth_mib": grown_kib / 1024,
                      "stale_left": os.path.exists(os.path.dirname(stale))}))


if __name__ == "__main__":
    main(sys.argv[1])
