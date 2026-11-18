#!/usr/bin/env bash
# Customer-mode spike, step 3: one job in one fresh Nitro Sandbox (run as root on the parent), with timings.
#   JITCONFIG=<encoded_jit_config> SLOT=1 REPOSITORY_ID=.. RUN_ID=.. RUN_ATTEMPT=1 RUNNER_NAME=fenvix-j<job id> \
#     SUMMARY_TOKEN_FILE=<per-job summary credential> FENVIX_SUMMARIES_URL=https://.../v1/runner/summaries bash run-job.sh
#   SLOT=1 bash run-job.sh --print-config        # only print the Firecracker configuration
# Everything about the job comes from the HOST's own job record (the worker's message: repository, run, attempt,
# runner name, the just-in-time config and the per-job summary credential), never from the guest (R-012 F9).
# Per job: a copy of the guest disk; a small input disk the host writes and the guest reads only (the just-in-time
# config); a raw 16 MiB result disk the guest writes and the host reads in userspace (read-result.py, size-capped,
# as an unprivileged user; never attached to the host's filesystem); a TAP device 172.16.<SLOT>.1/30 with IPv6 off and
# rate limits; Firecracker under the jailer (its own uid, chroot, cgroup; seccomp by Firecracker), not root (R-012
# F17). The summary is sent by `fenvix-post`, which holds the credential and never reads guest bytes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
SLOT="${SLOT:-1}"; VCPUS="${VCPUS:-2}"; MEM_MIB="${MEM_MIB:-2048}"
if ! [[ "$SLOT" =~ ^[0-9]+$ ]] || [ "$SLOT" -lt 1 ] || [ "$SLOT" -gt 250 ]; then echo "SLOT must be 1-250" >&2; exit 2; fi
id="fenvix-sbx-$SLOT"; tap="fctap$SLOT"; uid=$((20000 + SLOT))
jail="/srv/jailer/firecracker/$id/root"
mac="$(printf '06:00:AC:10:%02X:02' "$SLOT")"   # the CI rootfs derives 172.16.<SLOT>.2 from it
# Paths inside the jail (the chroot): the jailer starts Firecracker there.
config() {
  cat <<JSON
{
  "boot-source": { "kernel_image_path": "bzImage" },
  "machine-config": { "vcpu_count": $VCPUS, "mem_size_mib": $MEM_MIB },
  "drives": [
    { "drive_id": "rootfs", "path_on_host": "rootfs.ext4", "is_root_device": true, "is_read_only": false },
    { "drive_id": "input", "path_on_host": "input.ext4", "is_root_device": false, "is_read_only": true },
    { "drive_id": "result", "path_on_host": "result.img", "is_root_device": false, "is_read_only": false }
  ],
  "network-interfaces": [ {
    "iface_id": "eth0", "guest_mac": "$mac", "host_dev_name": "$tap",
    "rx_rate_limiter": { "bandwidth": { "size": 62500000, "refill_time": 1000 }, "ops": { "size": 20000, "refill_time": 1000 } },
    "tx_rate_limiter": { "bandwidth": { "size": 62500000, "refill_time": 1000 }, "ops": { "size": 20000, "refill_time": 1000 } }
  } ],
  "enclave": { "direct_mode": true, "cpu_overcommit": true, "debug_mode": ${DEBUG:-false} }
}
JSON
}
if [ "${1:-}" = "--print-config" ]; then config; exit 0; fi
: "${JITCONFIG:?the just-in-time config of the job}" "${REPOSITORY_ID:?}" "${RUN_ID:?}" "${RUNNER_NAME:?}"
RUN_ATTEMPT="${RUN_ATTEMPT:-1}"
for v in "$REPOSITORY_ID" "$RUN_ID" "$RUN_ATTEMPT"; do [[ "$v" =~ ^[0-9]{1,20}$ ]] || { echo "ids must be numbers" >&2; exit 2; }; done
[[ "$RUNNER_NAME" =~ ^[A-Za-z0-9._-]{1,100}$ ]] || { echo "bad RUNNER_NAME" >&2; exit 2; }
now() { date +%s.%N; }
staging="/var/lib/fenvix-sandboxes/job-$SLOT"
cleanup() {
  pkill -u "$uid" 2>/dev/null || true
  iptables -D FENVIX-SBX -i "$tap" ! -s "172.16.$SLOT.2" -j DROP 2>/dev/null || true
  ip link del "$tap" 2>/dev/null || true
  rm -rf -- "/srv/jailer/firecracker/${id:?}" "${staging:?}"
}
# Whatever happens (a failed curl, a signal, set -e): no disk of this job stays on the host (R-012 test 8).
trap cleanup EXIT
t0="$(now)"
cleanup
install -d -m 0700 "$staging/in" "$jail" "$jail/dev"
# The guest's disks, owned by the jail's uid, inside the chroot.
cp --sparse=always --reflink=auto "$here/guest/rootfs.ext4" "$jail/rootfs.ext4"
cp "$here/guest/bzImage" "$jail/bzImage"
printf '%s' "$JITCONFIG" >"$staging/in/jitconfig"
truncate -s 16M "$jail/input.ext4" && mkfs.ext4 -q -F -d "$staging/in" "$jail/input.ext4"
rm -rf -- "${staging:?}"
truncate -s 16M "$jail/result.img"
# The Nitro Sandboxes device, for the jail's uid only (the jailer creates /dev/kvm and /dev/net/tun itself).
mknod "$jail/dev/nitro_enclaves" c "$((16#$(stat -c '%t' /dev/nitro_enclaves)))" "$((16#$(stat -c '%T' /dev/nitro_enclaves)))"
chown -R "$uid:$uid" "$jail"
config >"$jail/config.json"
# A TAP device the jail's uid may open; no IPv6; this sandbox may only send from its own address.
ip tuntap add "$tap" mode tap user "$uid" group "$uid"
sysctl -q -w "net.ipv6.conf.$tap.disable_ipv6=1"
ip addr replace "172.16.$SLOT.1/30" dev "$tap" && ip link set "$tap" up
iptables -I FENVIX-SBX 1 -i "$tap" ! -s "172.16.$SLOT.2" -j DROP
t1="$(now)"
jailer --id "$id" --exec-file /usr/local/bin/firecracker --uid "$uid" --gid "$uid" --chroot-base-dir /srv/jailer \
  --cgroup-version 2 --cgroup "cpu.max=$((VCPUS * 100000)) 100000" --resource-limit no-file=1024 \
  -- --no-api --config-file config.json >"/var/log/fenvix-sbx-$SLOT.log" 2>&1 || echo "jailer/firecracker exited $?" >&2
t2="$(now)"
# The result: raw bytes, parsed in userspace by an unprivileged user that sees only stdin.
result="$(runuser -u fenvix-parse -- python3 -I "$here/read-result.py" <"$jail/result.img")"
if [ -n "${FENVIX_SUMMARIES_URL:-}" ] && [ -n "${SUMMARY_TOKEN_FILE:-}" ]; then
  # fenvix-post reads the per-job credential (0400, its own) and gets the parsed summary on stdin; the ids and the
  # runner name are this host's, from the job record above.
  printf '%s' "$result" | runuser -u fenvix-post -- python3 -I -c '
import json, sys, urllib.request
url, tok, repo, run, attempt, name = sys.argv[1:]
r = json.load(sys.stdin)
if not isinstance(r.get("summary"), dict):
    print("no summary from the guest:", r.get("error", "none")); sys.exit(0)
body = {"repositoryId": int(repo), "runId": int(run), "runAttempt": int(attempt), "runnerName": name, "summary": r["summary"]}
req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
    headers={"content-type": "application/json", "authorization": "Bearer " + open(tok).read().strip()})
print("summary sent:", urllib.request.urlopen(req, timeout=30).status)
' "$FENVIX_SUMMARIES_URL" "$SUMMARY_TOKEN_FILE" "$REPOSITORY_ID" "$RUN_ID" "$RUN_ATTEMPT" "$RUNNER_NAME" || echo "summary not sent" >&2
fi
cleanup
t3="$(now)"
python3 -I - "$t0" "$t1" "$t2" "$t3" "$result" <<'PY'
import json, sys
t0, t1, t2, t3 = map(float, sys.argv[1:5]); r = json.loads(sys.argv[5] or "{}")
up, dn = r.get("t_guest_up"), r.get("t_job_done")
print(f"prepare disks and network: {t1 - t0:6.1f} s")
if up: print(f"sandbox start -> guest up:  {up - t1:6.1f} s   (guest clock; compare with the job log's 'Set up job')")
if dn: print(f"guest up -> job done:       {dn - (up or t1):6.1f} s")
print(f"sandbox lifetime:           {t2 - t1:6.1f} s")
print(f"clean up:                   {t3 - t2:6.1f} s")
PY
