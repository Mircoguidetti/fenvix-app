"""The host agent (fenvix-agent.service, root): the only process on the host that talks to the App.

  1. Enrolment, once: the cloud-init user data left /etc/fenvix/enrol (host id + a single-use enrolment secret).
     POST /v1/hosts/enrol exchanges it for the host's settings and a host credential (fxh1., bound to this host and its
     region, valid hours, renewed by the App on each lease). The secret is spent at once: the copy on phoenixNAP's
     cloud-init floppy is worthless afterwards.
  2. Every few seconds, POST /v1/hosts/lease with the free slots and the running jobs. The App answers with jobs of
     THIS host's region only (each with its just-in-time runner config, its summary credential and its cache token,
     minted at that moment), a renewed credential when due, and whether to drain.
  3. Each job runs on its own slot (job.run_job); the outcome goes back with POST /v1/hosts/done.
  4. Draining: no new leases; when no job is left the App's scaler releases the server.

The host credential can lease jobs of this region, so it stays in this process and a root-only file; no jail uid, no
fenvix-parse/fenvix-post process and no guest can read it.
"""

from __future__ import annotations

import glob
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import asdict
from typing import Callable

from .config import HostConfig
from .job import JobSpec, Outcome, remove_cgroup, run_job

log = logging.getLogger("fenvix-agent")
ENROL = re.compile(r"^fxe1\.[a-z0-9-]{3,63}\.[A-Za-z0-9_-]{32,128}$")
HOSTCRED = re.compile(r"^fxh1\.[A-Za-z0-9_-]{1,2000}\.[A-Za-z0-9_-]{20,200}$")


class ControlPlane:
    def __init__(self, base_url: str, timeout: float = 30):
        if not base_url.startswith("https://") and not base_url.startswith("http://127.0.0.1"):
            raise ValueError("the App is reached over https")
        self.base = base_url.rstrip("/")
        self.timeout = timeout

    def call(self, path: str, token: str, body: dict) -> dict:
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(), method="POST",
                                     headers={"content-type": "application/json", "authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            data = r.read(4 * 1024 * 1024)
            return json.loads(data) if data else {}


def write_public_key(etc_dir: str, key: dict) -> None:
    os.chmod(etc_dir, os.stat(etc_dir).st_mode & 0o7777 | 0o711)
    os.makedirs(f"{etc_dir}/cache", exist_ok=True)
    os.chmod(f"{etc_dir}/cache", 0o755)
    path = f"{etc_dir}/cache/signing-key.json"
    tmp = f"{path}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        os.fchmod(f.fileno(), 0o644)
        json.dump(key, f)
    os.replace(tmp, path)


def write_private(path: str, text: str) -> None:
    """Root-only file, replaced atomically."""
    tmp = f"{path}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o400)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


class Agent:
    def __init__(self, cp: ControlPlane, state_dir: str = "/var/lib/fenvix", etc_dir: str = "/etc/fenvix",
                 runner: Callable[..., Outcome] = run_job, poll_s: float = 5.0, host_facts: dict | None = None,
                 route_dev: Callable[[str], str] | None = None):
        self.cp, self.state_dir, self.etc_dir, self.runner, self.poll_s = cp, state_dir, etc_dir, runner, poll_s
        self.route_dev = route_dev or route_dev_of
        self.host_facts = host_facts or {}
        self.cfg: HostConfig | None = None
        self.cred: str | None = None
        self.running: dict[int, tuple[int, threading.Thread]] = {}  # job id -> (slot, thread)
        self.lock = threading.Lock()
        self.draining = False
        self.stop = threading.Event()
        self.outbox: list[dict] = []  # outcomes not yet accepted by the App

    # ------------------------------------------------------------------ enrolment
    def enrol(self) -> None:
        cred_file, cfg_file = f"{self.state_dir}/host-credential", f"{self.etc_dir}/host.json"
        if os.path.exists(cred_file) and os.path.exists(cfg_file):
            self.cred = open(cred_file, encoding="utf-8").read().strip()
            self.cfg = HostConfig.from_json(open(cfg_file, encoding="utf-8").read())
            return
        enrol_file = f"{self.etc_dir}/enrol"
        secret = open(enrol_file, encoding="utf-8").read().strip()
        if not ENROL.fullmatch(secret):
            raise ValueError("the enrolment file is not an fxe1 token")
        r = self.cp.call("/v1/hosts/enrol", secret, {"facts": self.host_facts})
        cred, settings = r.get("credential"), r.get("config")
        if not isinstance(cred, str) or not HOSTCRED.fullmatch(cred) or not isinstance(settings, dict):
            raise ValueError("unexpected enrolment answer")
        # What only the host knows (interfaces, addresses) overrides nothing the App decides.
        merged = {**settings, **{k: v for k, v in self.host_facts.items() if k in ("pub_if", "host_addrs") and k not in settings}}
        cache = dict(merged.get("cache") or {})
        if cache.get("mode") == "dedicated" and not cache.get("iface"):
            # The region's cache server is on the private network: the interface the host routes it through.
            cache["iface"] = self.route_dev(cache["ip"])
            merged["cache"] = cache
        self.cfg = HostConfig.from_json(json.dumps(merged))
        os.makedirs(self.state_dir, mode=0o700, exist_ok=True)
        write_private(cfg_file, self.cfg.to_json())
        write_private(cred_file, cred)
        self.cred = cred
        key = r.get("cachePublicKey")
        if self.cfg.cache.mode == "colocated" and isinstance(key, dict):
            # The PUBLIC half of the cache signing key: the colocated cache verifies per-job tokens, mints none. It is
            # read by fenvix-cache, so its path is traversable and the file world-readable whatever the agent's
            # UMask=0077 (R-014 R3); the rest of /etc/fenvix stays root-only.
            write_public_key(self.etc_dir, {"n": str(key["n"]), "e": int(key["e"])})
        os.remove(enrol_file)  # spent anyway; the App refuses a second use
        log.info("enrolled as %s in %s, %d slots", self.cfg.host_id, self.cfg.region, self.cfg.slots)

    # ------------------------------------------------------------------ the loop
    def free_slots(self) -> list[int]:
        assert self.cfg
        with self.lock:
            busy = {s for s, _ in self.running.values()}
        return [s for s in range(self.cfg.slots) if s not in busy]

    def tick(self) -> dict:
        """One lease round. Returns the App's answer (for the tests)."""
        assert self.cfg and self.cred
        free = [] if self.draining else self.free_slots()
        with self.lock:
            running = sorted(self.running)
            done = list(self.outbox)
        body = {"free": len(free), "running": running, "done": done, "draining": self.draining}
        r = self.cp.call("/v1/hosts/lease", self.cred, body)
        with self.lock:
            accepted = {d["jobId"] for d in done}
            self.outbox = [d for d in self.outbox if d["jobId"] not in accepted]
        new = r.get("credential")
        if isinstance(new, str) and HOSTCRED.fullmatch(new) and new != self.cred:
            write_private(f"{self.state_dir}/host-credential", new)
            self.cred = new
        if r.get("drain"):
            if not self.draining:
                log.info("draining: no new jobs")
            self.draining = True
        jobs = r.get("jobs") or []
        for d in jobs[: len(free)]:
            try:
                spec = JobSpec.from_lease(d)
            except (KeyError, TypeError, ValueError) as e:
                log.error("refused a leased job: %s", e)
                self.report(Outcome(job_id=int(d.get("jobId", 0) or 0), slot=-1, result="error", detail=f"refused: {e}"))
                continue
            slot = free.pop(0)
            th = threading.Thread(target=self._run, args=(slot, spec), name=f"job-{spec.job.job_id}", daemon=True)
            with self.lock:
                self.running[spec.job.job_id] = (slot, th)
            th.start()
        return r

    def _run(self, slot: int, spec: JobSpec) -> None:
        assert self.cfg
        try:
            out = self.runner(self.cfg, slot, spec)
        except Exception as e:  # noqa: BLE001
            out = Outcome(job_id=spec.job.job_id, slot=slot, result="error", detail=str(e)[:300])
        with self.lock:
            self.running.pop(spec.job.job_id, None)
        self.report(out)

    def report(self, out: Outcome) -> None:
        with self.lock:
            self.outbox.append({"jobId": out.job_id, **{k: v for k, v in asdict(out).items() if k != "job_id"}})

    def prepare_host(self) -> None:
        """At every start (idempotent), before the first lease: whatever an earlier run of the agent left (R-014 R4),
        the host's network table, the colocated cache's namespace, the cgroups."""
        assert self.cfg
        from . import netplan

        prepare_cgroups(self.cfg.parent_cgroup)
        sweep_stale(self.cfg)
        subprocess.run(["sysctl", "-q", "-e", "-w", *netplan.HOST_SYSCTLS], check=True)
        subprocess.run(["nft", "-f", "-"], input=netplan.host_ruleset(self.cfg).encode(), check=True)
        if self.cfg.cache.mode == "colocated":
            subprocess.run(["systemctl", "stop", "fenvix-cache.service"], check=False)
            subprocess.run(["ip", "netns", "del", netplan.CACHE_NETNS], check=False, capture_output=True)
            for cmd in netplan.cache_up(self.cfg):
                subprocess.run(cmd, input=netplan.cache_ruleset(self.cfg).encode() if cmd[-2:] == ["-f", "-"] else None, check=True)
            subprocess.run(["systemctl", "start", "fenvix-cache.service"], check=True)

    def ensure_host_table(self, run: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> bool:
        """Every lease round (R-014 note b): the host's table must still be loaded. Anything that runs `nft flush
        ruleset` (an enabled nftables.service with a default /etc/nftables.conf, ufw) would leave forwarding on with
        no rule: microVMs would reach the host and the private network. Reloaded at once; if that fails, forwarding
        is turned off and no job is leased until it is back. Returns whether a new job may be leased."""
        assert self.cfg
        from . import netplan

        if run(["nft", "list", "table", "inet", netplan.TABLE], capture_output=True, check=False).returncode == 0:
            return True
        log.error("the host's nftables table %s was gone: reloading it", netplan.TABLE)
        r = run(["nft", "-f", "-"], input=netplan.host_ruleset(self.cfg).encode(), capture_output=True, check=False)
        if r.returncode == 0:
            return True
        run(["sysctl", "-q", "-w", "net.ipv4.ip_forward=0"], capture_output=True, check=False)
        log.error("could not reload the host's table: forwarding is off, no new job is leased")
        return False

    def run_forever(self) -> None:
        check_host_hygiene()  # before enrolment: a host that shares cores between tenants never takes a job
        self.enrol()
        self.prepare_host()
        backoff = self.poll_s
        while not self.stop.is_set():
            try:
                if not self.ensure_host_table():
                    self.stop.wait(self.poll_s)
                    continue
                self.tick()
                backoff = self.poll_s
            except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
                log.warning("lease failed: %s", e)
                backoff = min(backoff * 2, 60)
            self.stop.wait(backoff)


class UnsafeHost(RuntimeError):
    pass


def check_host_hygiene(sys_root: str = "/sys", proc_root: str = "/proc") -> None:
    """Firecracker's production host setup (prod-host-setup.md), for two tenants on one host (R-014 R2): SMT off (no
    physical core runs two tenants' vCPUs on its sibling threads), KSM off (no page shared across guests), no swap
    (no guest memory on a disk). install-host.sh sets all three; the agent refuses to enrol or lease without them."""
    problems = []
    try:
        smt = open(f"{sys_root}/devices/system/cpu/smt/active", encoding="ascii").read().strip()
    except OSError:
        smt = "0"  # no SMT support at all (the control file is absent)
    if smt != "0":
        problems.append("SMT is active (/sys/devices/system/cpu/smt/active)")
    try:
        if open(f"{sys_root}/kernel/mm/ksm/run", encoding="ascii").read().strip() != "0":
            problems.append("KSM is running (/sys/kernel/mm/ksm/run)")
    except OSError:
        pass
    try:
        swaps = open(f"{proc_root}/swaps", encoding="ascii").read().splitlines()[1:]
    except OSError:
        swaps = []
    if [x for x in swaps if x.strip()]:
        problems.append("swap is on (/proc/swaps)")
    if problems:
        raise UnsafeHost("not safe for two tenants: " + "; ".join(problems))


def sweep_stale(c: HostConfig, *, cgroup_root: str = "/sys/fs/cgroup", staging_base: str = "/run/fenvix",
                run: Callable[..., object] = subprocess.run) -> list[str]:
    """Everything a microVM leaves behind when the agent stops in the middle of a job (a restart, a crash, a reboot;
    R-014 R4): processes of every jail uid, every jail (a customer's root, scratch and input disks) on the data disk,
    every staging and post directory, every microVM cgroup and every slot namespace. Run before the first lease.
    Returns what it removed."""
    from . import netplan
    from .config import slot_uid

    gone: list[str] = []
    for slot in range(c.slots):
        run(["pkill", "-KILL", "-u", str(slot_uid(slot))], check=False, capture_output=True)
    vms = f"{cgroup_root}/{c.parent_cgroup}"
    for cg in sorted(glob.glob(f"{glob.escape(vms)}/*/")):
        remove_cgroup(cg.rstrip("/"))
        gone.append(cg.rstrip("/"))
    for d in sorted(glob.glob(f"{glob.escape(c.chroot_base)}/firecracker/*")) + sorted(
            glob.glob(f"{glob.escape(staging_base)}/staging-*") + glob.glob(f"{glob.escape(staging_base)}/post-*")):
        shutil.rmtree(d, ignore_errors=True)
        gone.append(d)
    listed = run(["ip", "netns", "list"], check=False, capture_output=True, text=True)
    names = [line.split()[0] for line in (getattr(listed, "stdout", "") or "").splitlines() if line.strip()]
    for ns in names:
        if re.fullmatch(r"fxvm[0-9]{1,3}(-guest)?", ns):
            slot = int(re.sub(r"\D", "", ns))
            for cmd in netplan.slot_down(netplan.slot_net(slot)):
                run(cmd, check=False, capture_output=True)
            gone.append(f"netns {ns}")
    if gone:
        log.warning("removed what an interrupted run left: %s", ", ".join(gone))
    return gone


def host_facts() -> dict:
    """The public interface and this host's own addresses (a guest reaches none of them)."""
    route = subprocess.run(["ip", "-j", "route", "show", "default"], capture_output=True, text=True, check=False).stdout
    addrs = subprocess.run(["ip", "-j", "-4", "addr", "show"], capture_output=True, text=True, check=False).stdout
    pub = (json.loads(route or "[]") or [{}])[0].get("dev", "bond0")
    mine = [a["local"] for i in json.loads(addrs or "[]") for a in i.get("addr_info", []) if a.get("local") and not a["local"].startswith("127.")]
    return {"pub_if": pub, "host_addrs": mine}


AGENT_MEMORY_MAX = 2 * 1024**3


def prepare_cgroups(parent: str, root: str = "/sys/fs/cgroup") -> None:
    """cgroup v2, under the agent's own delegated subtree (Delegate=yes): the agent moves itself into a leaf, so the
    service cgroup may enable controllers for its children; every microVM gets its own cgroup under <parent>.
    The agent's leaf has its own memory limit (R-014 R1): whatever happens to the agent and the commands it runs, the
    OOM killer stays inside the leaf and never reaches a tenant's microVM. (A MemoryMax= on the unit would cap the
    microVMs too: they are in the same service subtree.)"""
    if not os.path.exists(f"{root}/cgroup.controllers"):
        raise RuntimeError("cgroup v2 is required")
    svc = os.path.dirname(f"{root}/{parent}")
    os.makedirs(f"{svc}/agent", exist_ok=True)
    with open(f"{svc}/agent/cgroup.procs", "w") as f:
        f.write(str(os.getpid()))
    with open(f"{svc}/cgroup.subtree_control", "w") as f:
        f.write("+cpu +memory +pids")
    with open(f"{svc}/agent/memory.max", "w") as f:
        f.write(str(AGENT_MEMORY_MAX))
    os.makedirs(f"{root}/{parent}", exist_ok=True)
    with open(f"{root}/{parent}/cgroup.subtree_control", "w") as f:
        f.write("+cpu +memory +pids")


def route_dev_of(ip: str) -> str:
    out = subprocess.run(["ip", "-j", "route", "get", ip], capture_output=True, text=True, check=True).stdout
    return json.loads(out)[0]["dev"]


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    url = open("/etc/fenvix/control-url", encoding="utf-8").read().strip()
    agent = Agent(ControlPlane(url), host_facts=host_facts())
    import signal

    signal.signal(signal.SIGTERM, lambda *_: agent.stop.set())
    agent.run_forever()


if __name__ == "__main__":
    main()
