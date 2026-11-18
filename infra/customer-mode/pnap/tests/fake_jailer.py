#!/usr/bin/env python3
"""Stands in for the jailer + Firecracker in job_scenario.py (no /dev/kvm here). It checks what the real jailer would
be given, records what it saw, then plays a guest according to FAKE_JAILER_MODE:
  ok       writes a result record onto result.img, exits 0 (the guest powered off)
  symlink  replaces result.img with a symlink to another tenant's result (an escaped VMM, R-012b N1)
  garbage  writes no record
  hang     never powers off
"""

import json
import os
import subprocess
import sys
import time

argv = sys.argv[1:]
sep = argv.index("--")
opts, fc = argv[:sep], argv[sep + 1:]


def opt(name):
    return [opts[i + 1] for i, a in enumerate(opts) if a == name]


jid, base, uid, netns = opt("--id")[0], opt("--chroot-base-dir")[0], int(opt("--uid")[0]), opt("--netns")[0]
root = f"{base}/firecracker/{jid}/root"
seen = {"argv": argv, "netns_exists": os.path.exists(netns), "owners": {}, "input": {}}
for f in sorted(os.listdir(root)):
    st = os.stat(f"{root}/{f}")
    seen["owners"][f] = [st.st_uid, oct(st.st_mode & 0o777)]
cfg = json.load(open(f"{root}/config.json"))
seen["config_drives"] = [d["path_on_host"] for d in cfg["drives"]]
listing = subprocess.run(["debugfs", "-R", "ls -p /", f"{root}/input.ext4"], capture_output=True, text=True).stdout
for line in listing.splitlines():
    parts = line.strip("/").split("/")
    if len(parts) >= 5 and parts[4] not in (".", "..", "lost+found", ""):
        name = parts[4]
        seen["input"][name] = subprocess.run(["debugfs", "-R", f"cat /{name}", f"{root}/input.ext4"], capture_output=True, text=True).stdout
seen["scratch_label"] = subprocess.run(["blkid", "-o", "value", "-s", "LABEL", f"{root}/scratch.ext4"], capture_output=True, text=True).stdout.strip()
with open(os.environ["FAKE_WITNESS"], "w") as w:
    json.dump(seen, w)

mode = os.environ.get("FAKE_JAILER_MODE", "ok")
if mode == "hang":
    time.sleep(3600)
if mode == "symlink":
    os.remove(f"{root}/result.img")
    os.symlink(os.environ["FAKE_OTHER_RESULT"], f"{root}/result.img")
if mode == "ok":
    body = json.dumps({"summary": {"tests": 3, "reused": 2}, "t_guest_up": time.time(), "t_job_done": time.time(),
                       "repositoryId": 999999}).encode()  # the guest's word on ids is ignored
    with open(f"{root}/result.img", "r+b") as f:
        f.write(b"FXRES001" + len(body).to_bytes(4, "big") + body)
sys.exit(0)
