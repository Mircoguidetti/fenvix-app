"""R-014 R3, as production runs it: the host bundle extracted by the user data's own lines (umask 077), the agent's
runtime directory 0700 root as systemd creates it, and every non-root step run by the production code path as the
production accounts (runuser -u fenvix-parse / fenvix-post, the cache service as fenvix-cache). Run inside
`unshare --net --mount` as root, with the accounts created (install-host.sh step 3); prints JSON.

  python3 -I production_users_scenario.py job      one job through run_job with the default Users(): summary posted?
  python3 -I production_users_scenario.py cache    fenvix_cache_auth.py serve as fenvix-cache with the key the agent
                                                   wrote under /etc/fenvix (umask 077): does it start and answer?
"""

import http.server
import json
import os
import pwd
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
posted = []


class App(http.server.BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers["content-length"]))
        posted.append({"path": self.path, "auth": self.headers["authorization"], "body": json.loads(body)})
        self.send_response(202)
        self.end_headers()

    def log_message(self, *a):
        pass


def install_bundle(tmp: str) -> str:
    """The user data's own lines (github-app/src/pnap/userdata.ts), with /opt/fenvix-host moved under tmp."""
    sys.path.insert(0, os.path.join(HERE, ".."))
    import bundle

    ud = open(os.path.join(REPO, "github-app", "src", "pnap", "userdata.ts")).read()
    lines = [m for m in re.findall(r'^\s*"((?:umask|install -d -m 0755 /opt|tar -xzf|chmod -R)[^"]*)",$', ud, re.M)]
    assert len(lines) == 4, lines
    with open(f"{tmp}/fenvix-host.tgz", "wb") as f:
        f.write(bundle.build())
    sh = "; ".join(x.replace("/var/tmp/fenvix-host.tgz", f"{tmp}/fenvix-host.tgz").replace("/opt/fenvix-host", f"{tmp}/opt/fenvix-host") for x in lines)
    subprocess.run(["bash", "-c", f"set -e; {sh}"], check=True)
    return f"{tmp}/opt/fenvix-host"


def job(tmp: str, pkg: str) -> dict:
    os.makedirs("/run/netns", exist_ok=True)
    subprocess.run(["mount", "-t", "tmpfs", "none", "/run/netns"], check=True)
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    srv = http.server.HTTPServer(("127.0.0.1", 0), App)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    sys.path.insert(0, pkg)
    from fenvix_host.config import Cache, HostConfig
    from fenvix_host.job import JobSpec, Users, run_job

    for name, size in (("rootfs.ext4", 1 << 20), ("vmlinux", 4096)):
        with open(f"{tmp}/{name}", "wb") as f:
            f.truncate(size)
    c = HostConfig(host_id="fx-test-h1", region="NLD", slots=4, scratch_gib=4, chroot_base=f"{tmp}/jailer",
                   jailer=os.path.join(HERE, "fake_jailer.py"), kernel=f"{tmp}/vmlinux", rootfs=f"{tmp}/rootfs.ext4",
                   summaries_url=f"http://127.0.0.1:{srv.server_port}/v1/runner/summaries", cache=Cache(mode="colocated"), pub_if="lo")
    spec = JobSpec.from_lease({
        "jobId": 5550003, "runnerName": "fenvix-j5550003", "repositoryId": 4242, "runId": 9003, "runAttempt": 1,
        "vcpus": 2, "memMib": 8192, "jitConfig": "ZmFrZS1qaXQtY29uZmlnLWZvci10ZXN0cw==",
        "summaryToken": "fxr1.eyJuIjoiZmVudml4LWo1NTUwMDAzIn0.c2lnbmF0dXJlLW9mLXRoZS1hcHA",
        "cacheToken": "fxs1.eyJvcmciOiJnaC03NyJ9.cnNhLXNpZ25hdHVyZQ", "cacheOrg": "gh-77", "cacheAccess": "read",
    })
    os.environ.update(FAKE_JAILER_MODE="ok", FAKE_WITNESS=f"{tmp}/witness.json", FAKE_OTHER_RESULT="/nonexistent")
    run = f"{tmp}/run"
    os.makedirs(run, mode=0o700)  # systemd's RuntimeDirectory, before the agent touches it
    out = run_job(c, 2, spec, users=Users(), staging_base=run, timeout_s=120)  # production users, production code path
    return {"outcome": out.__dict__, "posted": posted, "post_uid": Users().post_uid}


def cache(tmp: str, pkg: str) -> dict:
    sys.path.insert(0, pkg)
    from fenvix_host import agent

    etc = f"{tmp}/etc/fenvix"
    os.makedirs(etc)
    os.chmod(etc, 0o711)  # the user data: install -d -m 0711 /etc/fenvix
    old = os.umask(0o077)  # the agent's UMask=0077
    try:
        agent.write_public_key(etc, {"n": "c5" * 256, "e": 65537})
    finally:
        os.umask(old)
    data = f"{tmp}/cache-data"
    os.makedirs(data, mode=0o700)
    u = pwd.getpwnam("fenvix-cache")
    os.chown(data, u.pw_uid, u.pw_gid)  # systemd's StateDirectory
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    p = subprocess.Popen(["runuser", "-u", "fenvix-cache", "--", "python3", "-I", f"{pkg}/cache/fenvix_cache_auth.py", "serve",
                          "--data", data, "--key", f"{etc}/cache/signing-key.json", "--host", "127.0.0.1", "--port", "18787", "--quiet"],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    status, err = None, ""
    for _ in range(50):
        if p.poll() is not None:
            err = p.stderr.read().decode(errors="replace")[-500:]
            break
        try:
            urllib.request.urlopen("http://127.0.0.1:18787/gh-77/x", timeout=1)
            status = 200
        except urllib.error.HTTPError as e:
            status = e.code
        except OSError:
            time.sleep(0.1)
            continue
        break
    alive = p.poll() is None
    p.kill()
    return {"alive": alive, "status": status, "stderr": err}


def main(mode: str) -> None:
    tmp = tempfile.mkdtemp()
    os.chmod(tmp, 0o755)
    pkg = install_bundle(tmp)
    print(json.dumps(job(tmp, pkg) if mode == "job" else cache(tmp, pkg)))


if __name__ == "__main__":
    main(sys.argv[1])
