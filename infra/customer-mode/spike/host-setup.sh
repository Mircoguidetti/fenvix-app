#!/usr/bin/env bash
# Customer-mode spike, step 1: prepare a Nitro Sandboxes parent (c7i.xlarge, Amazon Linux 2023 kernel 6.18, launched
# with --enclave-options Enabled=true). Run as root on that instance. Not for production: no jailer, one host.
#   FIRECRACKER_SHA256=<sha256 of firecracker-v1.18.0-x86_64.tgz, from the release page> bash host-setup.sh
set -euo pipefail
VERSION="${FIRECRACKER_VERSION:-v1.18.0}"   # Nitro Sandboxes backend: v1.18.0 or newer
: "${FIRECRACKER_SHA256:?set FIRECRACKER_SHA256 to the release archive SHA-256 (github.com/firecracker-microvm/firecracker/releases)}"
log() { printf '[host-setup] %s\n' "$*"; }

log "1. the Nitro Enclaves driver with Nitro Sandboxes support"
[ -c /dev/nitro_enclaves ] || { echo "no /dev/nitro_enclaves: launch with --enclave-options Enabled=true, AL2023 kernel6.18 >= 6.18.51-120.162" >&2; exit 1; }
uname -r
ne=/sys/class/misc/nitro_enclaves
log "   CPU pool $(cat "$ne/cpu_pool/total" 2>/dev/null || echo '?') threads; memory pool free $(( $(cat "$ne/mem_pool/free" 2>/dev/null || echo 0) / 1048576 )) MiB"

log "2. Firecracker $VERSION, checked against the SHA-256 you gave"
dir=/opt/firecracker; mkdir -p "$dir"; cd "$dir"
tgz="firecracker-$VERSION-x86_64.tgz"
[ -f "$tgz" ] || curl -fsSLO "https://github.com/firecracker-microvm/firecracker/releases/download/$VERSION/$tgz"
echo "$FIRECRACKER_SHA256  $tgz" | sha256sum -c -
tar -xzf "$tgz"
install -m 0755 "release-$VERSION-x86_64/firecracker-$VERSION-x86_64" /usr/local/bin/firecracker
firecracker --version

log "3. slots: room for 8 sandboxes at once (each increase donates 128 MiB per 8 slots, until reboot)"
[ "$(cat "$ne/pcie_slots")" -ge 8 ] || echo 8 >"$ne/pcie_slots"
log "   pcie_slots $(cat "$ne/pcie_slots") of $(cat "$ne/pcie_slots_total")"
log "   memory: without nitro_enclaves.mempool= on the kernel command line, each start takes contiguous memory from the"
log "   parent; for steady starts add e.g. nitro_enclaves.mempool=10G (grubby --update-kernel=ALL --args=...) and reboot"

log "4. forwarding and NAT for the sandboxes' TAP devices (172.16.0.0/16 → the instance's interface)"
out="$(ip route show default | awk '{print $5; exit}')"
sysctl -q -w net.ipv4.ip_forward=1
rule() { iptables -C "$@" 2>/dev/null || iptables -I "$@"; }
rule FORWARD -s 172.16.0.0/16 -o "$out" -j ACCEPT
rule FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
# A sandbox reaches the internet; never the parent (metadata service, its ports) nor another sandbox.
rule FORWARD -s 172.16.0.0/16 -d 169.254.169.254 -j DROP
rule FORWARD -s 172.16.0.0/16 -d 172.16.0.0/16 -j DROP
rule INPUT -s 172.16.0.0/16 -j DROP
iptables -t nat -C POSTROUTING -s 172.16.0.0/16 -o "$out" -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 172.16.0.0/16 -o "$out" -j MASQUERADE
log "host ready"
