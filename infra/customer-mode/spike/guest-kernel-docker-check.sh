#!/usr/bin/env bash
# Does a guest kernel config have what Docker (and so GitHub `services:`, testcontainers, docker compose) needs inside
# a job's microVM? Static check of a .config file (or /proc/config.gz inside a running guest). Our own list, from
# Docker's documented kernel requirements; nothing downloaded is run.
#   bash guest-kernel-docker-check.sh path/to/.config        # exit 0: all required options present
set -euo pipefail
cfg="${1:-/proc/config.gz}"
if [[ "$cfg" == *.gz ]]; then text="$(zcat "$cfg")"; else text="$(cat "$cfg")"; fi
required=(
  NAMESPACES UTS_NS IPC_NS PID_NS NET_NS USER_NS          # container isolation
  CGROUPS MEMCG CGROUP_PIDS CGROUP_CPUACCT CGROUP_SCHED CPUSETS CGROUP_DEVICE CGROUP_FREEZER CGROUP_BPF
  KEYS SECCOMP SECCOMP_FILTER POSIX_MQUEUE
  OVERLAY_FS EXT4_FS                                      # image layers (overlay2), the guest's disk
  VETH BRIDGE BRIDGE_NETFILTER                            # the default bridge network
  NETFILTER NETFILTER_ADVANCED NF_NAT NF_CONNTRACK IP_NF_IPTABLES IP_NF_FILTER IP_NF_NAT IP_NF_TARGET_MASQUERADE
  NETFILTER_XT_MATCH_ADDRTYPE NETFILTER_XT_MATCH_CONNTRACK NETFILTER_XT_TARGET_MASQUERADE
)
optional=( NF_TABLES NFT_COMPAT IP_VS VXLAN MACVLAN IPVLAN BLK_DEV_THROTTLING CFS_BANDWIDTH OVERLAY_FS_REDIRECT_DIR )
missing=0
check() { # $1 option, $2 required|optional
  if grep -qE "^CONFIG_$1=(y|m)$" <<<"$text"; then printf '  ok       CONFIG_%s\n' "$1"
  elif [ "$2" = required ]; then printf '  MISSING  CONFIG_%s\n' "$1"; missing=$((missing + 1))
  else printf '  absent   CONFIG_%s\n' "$1"; fi
}
echo "required (Docker engine, default bridge network, overlay2):"
for o in "${required[@]}"; do check "$o" required; done
echo "optional (swarm, overlay networks, limits):"
for o in "${optional[@]}"; do check "$o" optional; done
echo "missing required: $missing"
[ "$missing" -eq 0 ]
