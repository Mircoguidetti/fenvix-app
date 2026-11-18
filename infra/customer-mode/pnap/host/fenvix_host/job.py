"""One job, start to finish, on one slot. Everything the job had is deleted on every path (a failed command, a timeout,
an exception): its namespace (and so its TAP and veth), its jail (its four disks), its cgroup, its summary credential
and its connection-tracking entries.

What crosses into the guest: the just-in-time runner config (single use), the job's cache token (its customer's
cache organization only, read-only unless the ref is trusted, expires) and plain settings. Nothing long-lived.
What crosses out: the bytes of the raw result disk, parsed by fenvix-parse. The summary is posted by fenvix-post with
the job's own credential; the ids are the host's record of the job.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from typing import Callable, Protocol

from . import netplan, vm
from .config import HostConfig
from .result import UnsafeResult, open_result

TOKEN = re.compile(r"^fx[rs]1\.[A-Za-z0-9_-]{1,3000}\.[A-Za-z0-9_-]{1,1000}$")
JIT = re.compile(r"^[A-Za-z0-9+/=]{16,65536}$")
ORG = re.compile(r"^gh-[0-9]{1,20}$")
HERE = os.path.dirname(os.path.abspath(__file__))


@dataclass(frozen=True)
class JobSpec:
    """One leased job, as the App sends it (POST /v1/hosts/lease)."""

    job: vm.Job
    jit_config: str
    summary_token: str
    cache_access: str = "read"
    cache_token: str | None = None
    cache_org: str | None = None

    @staticmethod
    def from_lease(d: dict) -> "JobSpec":
        job = vm.Job(job_id=d["jobId"], runner_name=d["runnerName"], repository_id=d["repositoryId"], run_id=d["runId"],
                     run_attempt=d.get("runAttempt", 1), vcpus=d["vcpus"], mem_mib=d["memMib"])
        s = JobSpec(job=job, jit_config=d["jitConfig"], summary_token=d["summaryToken"], cache_access=d.get("cacheAccess", "read"),
                    cache_token=d.get("cacheToken"), cache_org=d.get("cacheOrg"))
        if not isinstance(s.jit_config, str) or not JIT.fullmatch(s.jit_config):
            raise ValueError("the just-in-time config is not base64")
        if not isinstance(s.summary_token, str) or not TOKEN.fullmatch(s.summary_token) or not s.summary_token.startswith("fxr1."):
            raise ValueError("unexpected summary credential")
        if s.cache_token is not None and (not TOKEN.fullmatch(s.cache_token) or not s.cache_token.startswith("fxs1.")):
            raise ValueError("unexpected cache token")
        if s.cache_org is not None and not ORG.fullmatch(s.cache_org):
            raise ValueError("unexpected cache organization")
        if s.cache_access not in ("read", "write"):
            raise ValueError("cache access is read or write")
        return s


class Executor(Protocol):
    def run(self, argv: list[str], *, input: bytes | None = None, timeout: float | None = None, check: bool = True,
            stdin_fd: int | None = None) -> subprocess.CompletedProcess: ...


class Shell:
    """Runs commands for real. Never through a shell: every argument is one argv element."""

    def run(self, argv, *, input=None, timeout=None, check=True, stdin_fd=None):
        return subprocess.run(argv, input=input, stdin=stdin_fd if input is None else None, capture_output=True,
                              timeout=timeout, check=check)


@dataclass
class Users:
    """How to run a step as fenvix-parse or fenvix-post. Production: runuser. The tests run as the current user."""

    parse: list[str] = field(default_factory=lambda: ["runuser", "-u", "fenvix-parse", "--"])
    post: list[str] = field(default_factory=lambda: ["runuser", "-u", "fenvix-post", "--"])
    post_uid: int | None = None  # owner of the credential file (fenvix-post); None: leave as is


@dataclass
class Outcome:
    job_id: int
    slot: int
    result: str  # "summary", "no-summary", "unsafe-result", "timeout", "error"
    detail: str = ""
    summary_sent: bool = False
    timings: dict = field(default_factory=dict)


def cache_url(c: HostConfig, spec: JobSpec) -> str | None:
    ep = netplan.cache_endpoint(c)
    if not ep or not spec.cache_token or not spec.cache_org:
        return None
    ip, port, _ = ep
    return f"http://{ip}:{port}/{spec.cache_org}"


def input_files(c: HostConfig, spec: JobSpec) -> dict[str, str]:
    env = {
        "FENVIX_MODE": "customer-pnap",
        "FENVIX_RUNNER_NAME": spec.job.runner_name,
        "FENVIX_JOB_ID": str(spec.job.job_id),
        "FENVIX_CACHE_ACCESS": spec.cache_access,
    }
    url = cache_url(c, spec)
    files = {"jitconfig": spec.jit_config}
    if url:
        # The cache is on our private side of the host (a namespace, or the region's private network), over HTTP as in
        # per-job mode; the token is per job and per customer organization.
        env.update({"FENVIX_CACHE_URL": url, "FENVIX_CACHE_ORG": spec.cache_org or "", "FENVIX_CACHE_ALLOW_HTTP": "1"})
        files["cache-token"] = spec.cache_token or ""
    files["job.env"] = "".join(f"{k}={v}\n" for k, v in env.items())
    return files


def run_job(c: HostConfig, slot: int, spec: JobSpec, *, sh: Executor | None = None, users: Users | None = None,
            tap_kind: str = "tap", clock: Callable[[], float] = time.time, staging_base: str = "/run/fenvix",
            timeout_s: float | None = None) -> Outcome:
    sh = sh or Shell()
    users = users or Users()
    job = spec.job
    n = netplan.slot_net(slot)
    jid = vm.jail_id(slot, job)
    jail_parent = f"{c.chroot_base}/firecracker/{jid}"
    root = f"{jail_parent}/root"
    staging = f"{staging_base}/staging-{jid}"
    post_dir = f"{staging_base}/post-{jid}"
    t = {"start": clock()}
    out = Outcome(job_id=job.job_id, slot=slot, result="error", timings=t)

    def cleanup() -> None:
        sh.run(["pkill", "-KILL", "-u", str(n.uid)], check=False)
        for cmd in netplan.slot_down(n):
            sh.run(cmd, check=False)
        for d in (jail_parent, staging, post_dir):
            shutil.rmtree(d, ignore_errors=True)
        cg = f"/sys/fs/cgroup/{c.parent_cgroup}/{jid}"
        if os.path.isdir(cg):
            try:
                os.rmdir(cg)
            except OSError:
                pass

    try:
        cleanup()  # whatever a crash left in this slot
        # 1. the jail and the job's disks
        os.makedirs(f"{c.chroot_base}/firecracker", mode=0o711, exist_ok=True)
        os.makedirs(jail_parent, mode=0o700)
        os.makedirs(root, mode=0o700)
        sh.run(["cp", "--reflink=auto", "--sparse=always", c.rootfs, f"{root}/rootfs.ext4"])
        sh.run(["cp", "--reflink=auto", c.kernel, f"{root}/vmlinux"])
        os.makedirs(staging, mode=0o700)
        for name, body in input_files(c, spec).items():
            fd = os.open(f"{staging}/{name}", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(body)
        with open(f"{root}/input.ext4", "wb") as f:
            f.truncate(vm.INPUT_BYTES)
        sh.run(["mkfs.ext4", "-q", "-F", "-L", "fxinput", "-d", staging, f"{root}/input.ext4"])
        shutil.rmtree(staging, ignore_errors=True)
        with open(f"{root}/result.img", "wb") as f:
            f.truncate(vm.RESULT_BYTES)
        with open(f"{root}/scratch.ext4", "wb") as f:
            f.truncate(c.scratch_gib * 1024**3)
        sh.run(["mkfs.ext4", "-q", "-F", "-L", "fxscratch", "-E", "lazy_itable_init=1,lazy_journal_init=1,nodiscard", f"{root}/scratch.ext4"])
        with open(f"{root}/config.json", "w", encoding="utf-8") as f:
            f.write(vm.config_json(c, n, job))
        for name in ("rootfs.ext4", "vmlinux", "input.ext4", "result.img", "scratch.ext4", "config.json"):
            os.chown(f"{root}/{name}", n.uid, n.uid)
            os.chmod(f"{root}/{name}", 0o600 if name != "vmlinux" else 0o400)
        # 2. the job's network namespace, TAP and rules
        for cmd in netplan.slot_up(n, tap_kind=tap_kind):
            sh.run(cmd, input=netplan.vm_ruleset(n).encode() if cmd[-2:] == ["-f", "-"] else None)
        t["prepared"] = clock()
        # 3. the microVM, until the guest powers off (or the job's time is up)
        try:
            r = sh.run(vm.jailer_argv(c, n, slot, job), timeout=timeout_s or c.job_timeout_minutes * 60, check=False)
            t["vm_exit"] = clock()
            if r.returncode != 0:
                out.detail = f"jailer/firecracker exited {r.returncode}"
        except subprocess.TimeoutExpired:
            t["vm_exit"] = clock()
            out.result, out.detail = "timeout", f"no power-off within {timeout_s or c.job_timeout_minutes * 60:.0f} s"
            return out
        # 4. the result: opened without following anything, parsed as fenvix-parse from stdin only
        try:
            fd = open_result(root, n.uid, size=vm.RESULT_BYTES)
        except UnsafeResult as e:
            out.result, out.detail = "unsafe-result", str(e)
            return out
        try:
            pr = sh.run([*users.parse, "python3", "-I", f"{HERE}/read_result.py"], stdin_fd=fd, timeout=60, check=False)
        finally:
            os.close(fd)
        try:
            parsed = json.loads(pr.stdout or b"{}")
        except ValueError:
            parsed = {"summary": None, "error": "parser output"}
        for k in ("t_guest_up", "t_job_done"):
            if isinstance(parsed.get(k), float):
                t[k] = parsed[k]
        if not isinstance(parsed.get("summary"), dict):
            out.result, out.detail = "no-summary", str(parsed.get("error", "none"))
            return out
        # 5. the summary, by fenvix-post with this job's credential (a file only it reads, deleted with the job)
        out.result = "summary"
        if c.summaries_url:
            os.makedirs(post_dir, mode=0o700)
            cred = f"{post_dir}/summary-token"
            fd = os.open(cred, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
            with os.fdopen(fd, "w") as f:
                f.write(spec.summary_token)
            if users.post_uid is not None:
                os.chown(post_dir, users.post_uid, -1)
                os.chown(cred, users.post_uid, -1)
            pp = sh.run([*users.post, "python3", "-I", f"{HERE}/post.py", c.summaries_url, cred, str(job.repository_id),
                         str(job.run_id), str(job.run_attempt), job.runner_name],
                        input=json.dumps({"summary": parsed["summary"]}).encode(), timeout=60, check=False)
            out.summary_sent = pp.returncode == 0
            out.detail = ((pp.stdout or b"") + (pp.stderr or b"")).decode(errors="replace").strip()[-300:]
        return out
    except Exception as e:  # noqa: BLE001 - reported to the App as this job's outcome
        out.result, out.detail = "error", f"{type(e).__name__}: {e}"[:300]
        return out
    finally:
        cleanup()
        t["end"] = clock()
