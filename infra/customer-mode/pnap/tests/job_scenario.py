"""One job through fenvix_host.job.run_job, for real except the VMM (fake_jailer.py): disks, the input disk, the
slot's namespace with a real TAP of the jail uid, its rules, the safe result read, fenvix-post's summary to a local
stand-in of the App, and the cleanup. Run inside `unshare --net --mount` as root; prints JSON.

  python3 -I job_scenario.py MODE        MODE: ok | symlink | garbage | hang
"""

import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "host"))
from fenvix_host import netplan  # noqa: E402
from fenvix_host.config import Cache, HostConfig  # noqa: E402
from fenvix_host.job import JobSpec, Users, run_job  # noqa: E402

posted = []


class App(http.server.BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers["content-length"]))
        posted.append({"path": self.path, "auth": self.headers["authorization"], "body": json.loads(body)})
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
    os.chmod(tmp, 0o711)
    for name, size in (("rootfs.ext4", 1 << 20), ("vmlinux", 4096)):
        with open(f"{tmp}/{name}", "wb") as f:
            f.truncate(size)
    other = f"{tmp}/other-tenant-result.img"
    with open(other, "wb") as f:
        body = json.dumps({"summary": {"tenant": "OTHER"}}).encode()
        f.write(b"FXRES001" + len(body).to_bytes(4, "big") + body)
        f.truncate(16 << 20)
    c = HostConfig(host_id="fx-test-h1", region="NLD", slots=4, scratch_gib=4, chroot_base=f"{tmp}/jailer",
                   jailer=os.path.join(HERE, "fake_jailer.py"), kernel=f"{tmp}/vmlinux", rootfs=f"{tmp}/rootfs.ext4",
                   summaries_url=f"http://127.0.0.1:{srv.server_port}/v1/runner/summaries",
                   cache=Cache(mode="colocated"), pub_if="lo")
    spec = JobSpec.from_lease({
        "jobId": 5550001, "runnerName": "fenvix-j5550001", "repositoryId": 4242, "runId": 9001, "runAttempt": 2,
        "vcpus": 2, "memMib": 8192, "jitConfig": "ZmFrZS1qaXQtY29uZmlnLWZvci10ZXN0cw==",
        "summaryToken": "fxr1.eyJuIjoiZmVudml4LWo1NTUwMDAxIn0.c2lnbmF0dXJlLW9mLXRoZS1hcHA",
        "cacheToken": "fxs1.eyJvcmciOiJnaC03NyJ9.cnNhLXNpZ25hdHVyZQ", "cacheOrg": "gh-77", "cacheAccess": "read",
    })
    os.environ.update(FAKE_JAILER_MODE=mode, FAKE_WITNESS=f"{tmp}/witness.json", FAKE_OTHER_RESULT=other)
    out = run_job(c, 3, spec, users=Users(parse=[], post=[]), staging_base=f"{tmp}/run",
                  timeout_s=3 if mode == "hang" else None)
    seen = json.load(open(f"{tmp}/witness.json")) if os.path.exists(f"{tmp}/witness.json") else {}
    n = netplan.slot_net(3)
    left = {
        "jail": os.path.exists(f"{tmp}/jailer/firecracker/fxs3-j5550001"),
        "run_dir_entries": os.listdir(f"{tmp}/run") if os.path.isdir(f"{tmp}/run") else [],
        "netns": n.netns in subprocess.run(["ip", "netns", "list"], capture_output=True, text=True).stdout,
        "root_link": subprocess.run(["ip", "link", "show", n.root_if], capture_output=True).returncode == 0,
    }
    print(json.dumps({"outcome": out.__dict__, "seen": seen, "posted": posted, "left": left}))


if __name__ == "__main__":
    main(sys.argv[1])
