#!/usr/bin/env bash
# Customer-mode spike, step 3: one job in one fresh Nitro Sandbox (run as root on the parent), with timings.
#   JITCONFIG=<GitHub encoded_jit_config> SLOT=1 bash run-job.sh      # a real job
#   SLOT=1 bash run-job.sh --print-config                              # only print the Firecracker configuration
# Per job: a copy of the guest disk, a small job disk (the just-in-time config in; summary.json out), a TAP device
# 172.16.<SLOT>.1/30, a sandbox (2 vCPUs, 2 GiB, direct mode, CPU overcommit). The guest powers off after its one
# job; the host then reads summary.json, posts it with RUNNER_TOKEN (the host's, never in the guest), deletes
# everything. Timings: sandbox start → guest up → job done → sandbox gone.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
SLOT="${SLOT:-1}"; VCPUS="${VCPUS:-2}"; MEM_MIB="${MEM_MIB:-2048}"
[[ "$SLOT" =~ ^[0-9]+$ ]] && [ "$SLOT" -ge 1 ] && [ "$SLOT" -le 250 ] || { echo "SLOT must be 1-250" >&2; exit 2; }
work="/var/lib/fenvix-sandboxes/job-$SLOT"; tap="fctap$SLOT"
mac="$(printf '06:00:AC:10:%02X:02' "$SLOT")"   # the CI rootfs derives 172.16.<SLOT>.2 from it

config() {
  cat <<JSON
{
  "boot-source": { "kernel_image_path": "$here/guest/bzImage" },
  "machine-config": { "vcpu_count": $VCPUS, "mem_size_mib": $MEM_MIB },
  "drives": [
    { "drive_id": "rootfs", "path_on_host": "$work/rootfs.ext4", "is_root_device": true, "is_read_only": false },
    { "drive_id": "job", "path_on_host": "$work/job.ext4", "is_root_device": false, "is_read_only": false }
  ],
  "network-interfaces": [ { "iface_id": "eth0", "guest_mac": "$mac", "host_dev_name": "$tap" } ],
  "enclave": { "direct_mode": true, "cpu_overcommit": true, "debug_mode": ${DEBUG:-false} }
}
JSON
}
if [ "${1:-}" = "--print-config" ]; then config; exit 0; fi
: "${JITCONFIG:?set JITCONFIG to the encoded_jit_config of the job (generate-jitconfig)}"
now() { date +%s.%N; }
cleanup() { umount "${work:?}/job" 2>/dev/null || true; ip link del "$tap" 2>/dev/null || true; rm -rf -- "/var/lib/fenvix-sandboxes/job-${SLOT:?}"; }
t0="$(now)"
cleanup
mkdir -p "$work/in"
cp --sparse=always --reflink=auto "$here/guest/rootfs.ext4" "$work/rootfs.ext4"
printf '%s' "$JITCONFIG" >"$work/in/jitconfig"
truncate -s 64M "$work/job.ext4" && mkfs.ext4 -q -F -d "$work/in" "$work/job.ext4" && rm -f -- "$work/in/jitconfig" && rmdir "$work/in"
ip tuntap add "$tap" mode tap 2>/dev/null || true
ip addr replace "172.16.$SLOT.1/30" dev "$tap" && ip link set "$tap" up
config >"$work/config.json"
t1="$(now)"
firecracker --no-api --config-file "$work/config.json" >"$work/console.log" 2>&1 || echo "firecracker exited $?" >&2
t2="$(now)"
mnt="$work/job"; mkdir -p "$mnt" && mount -o ro "$work/job.ext4" "$mnt"
up="$(cat "$mnt/t-guest-up" 2>/dev/null || echo "")"; done_="$(cat "$mnt/t-job-done" 2>/dev/null || echo "")"
if [ -f "$mnt/summary.json" ] && [ -n "${FENVIX_SUMMARIES_URL:-}" ] && [ -n "${RUNNER_TOKEN_FILE:-}" ]; then
  read -r repo run attempt <"$mnt/ids"
  python3 -I - "$mnt/summary.json" "$repo" "$run" "$attempt" "fenvix-sandbox-$SLOT" <<'PY' | curl -fsS -X POST -H "content-type: application/json" -H @<(printf 'authorization: Bearer %s\n' "$(cat "$RUNNER_TOKEN_FILE")") --data-binary @- "$FENVIX_SUMMARIES_URL"
import json, sys
s, repo, run, attempt, name = sys.argv[1:]
print(json.dumps({"repositoryId": int(repo), "runId": int(run), "runAttempt": int(attempt), "runnerName": name, "summary": json.load(open(s))}))
PY
fi
cp "$work/console.log" "/var/log/fenvix-sandbox-$SLOT.log" 2>/dev/null || true
cleanup
t3="$(now)"
python3 -I - "$t0" "$t1" "$t2" "$t3" "$up" "$done_" <<'PY'
import sys
t0, t1, t2, t3 = map(float, sys.argv[1:5]); up = float(sys.argv[5]) if sys.argv[5] else None; dn = float(sys.argv[6]) if sys.argv[6] else None
print(f"prepare disks and network: {t1 - t0:6.1f} s")
if up: print(f"sandbox start -> guest up:  {up - t1:6.1f} s   (guest clock; compare with the job log's 'Set up job')")
if dn: print(f"guest up -> job done:       {dn - (up or t1):6.1f} s")
print(f"sandbox lifetime:           {t2 - t1:6.1f} s")
print(f"clean up:                   {t3 - t2:6.1f} s")
PY
