"""python3 -I -m fenvix_host <command>   (run from /opt/fenvix-host)

  agent                          the host agent (fenvix-agent.service)
  net-up [--config FILE]         sysctls, the host's nftables table and, in colocated cache mode, the cache namespace
  render-host-nft --config FILE  print the host's ruleset
  render-vm --config FILE --slot N --job-id ID   print a job's Firecracker configuration and jailer command line
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

from . import netplan, vm
from .config import HostConfig


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="fenvix_host")
    p.add_argument("command", choices=["agent", "net-up", "render-host-nft", "render-vm"])
    p.add_argument("--config", default="/etc/fenvix/host.json")
    p.add_argument("--slot", type=int, default=0)
    p.add_argument("--job-id", type=int, default=1)
    a = p.parse_args(argv)
    if a.command == "agent":
        from .agent import main as agent_main

        agent_main()
        return 0
    c = HostConfig.from_json(open(a.config, encoding="utf-8").read())
    if a.command == "render-host-nft":
        sys.stdout.write(netplan.host_ruleset(c))
    elif a.command == "render-vm":
        n = netplan.slot_net(a.slot)
        job = vm.Job(job_id=a.job_id, runner_name=f"fenvix-j{a.job_id}", repository_id=1, run_id=1, run_attempt=1, vcpus=c.vcpus, mem_mib=c.mem_mib)
        print(json.dumps({"config": vm.firecracker_config(c, n, job), "jailer": vm.jailer_argv(c, n, a.slot, job)}, indent=2))
    elif a.command == "net-up":
        subprocess.run(["sysctl", "-q", "-e", "-w", *netplan.HOST_SYSCTLS], check=True)
        subprocess.run(["nft", "-f", "-"], input=netplan.host_ruleset(c).encode(), check=True)
        if c.cache.mode == "colocated":
            subprocess.run(["ip", "netns", "del", netplan.CACHE_NETNS], check=False, capture_output=True)
            for cmd in netplan.cache_up(c):
                subprocess.run(cmd, input=netplan.cache_ruleset(c).encode() if cmd[-2:] == ["-f", "-"] else None, check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
