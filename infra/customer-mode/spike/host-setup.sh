#!/usr/bin/env bash
# Customer-mode spike, step 1: prepare a Nitro Sandboxes parent (c7i.xlarge, Amazon Linux 2023 kernel 6.18, launched
# with --enclave-options Enabled=true and IMDS hop limit 1). Run as root on that instance. Not for production (one
# host), but with the isolation the design requires (docs/REVIEW-R-012.md F10, F11, F17):
#   - the Nitro Sandboxes memory pool must be on the kernel command line (without it the parent has 0 slots);
#   - Firecracker runs under the jailer (own uid, chroot, cgroup, seccomp), never as root;
#   - the sandboxes' firewall is keyed on their TAP interfaces (fctap+), FORWARD defaults to DROP, IPv6 is off on the
#     TAPs and dropped, and each sandbox has a connection and new-connection-rate limit.
#   FIRECRACKER_SHA256=<sha256 of firecracker-v1.18.0-x86_64.tgz, from the release page> bash host-setup.sh
set -euo pipefail
VERSION="${FIRECRACKER_VERSION:-v1.18.0}"   # Nitro Sandboxes backend: v1.18.0 or newer
: "${FIRECRACKER_SHA256:?set FIRECRACKER_SHA256 to the release archive SHA-256 (github.com/firecracker-microvm/firecracker/releases)}"
log() { printf '[host-setup] %s\n' "$*"; }
die() { printf '[host-setup] STOP: %s\n' "$*" >&2; exit 1; }

log "1. the Nitro Enclaves driver with Nitro Sandboxes support, and its memory pool"
[ -c /dev/nitro_enclaves ] || die "no /dev/nitro_enclaves: launch with --enclave-options Enabled=true, AL2023 kernel6.18 >= 6.18.51-120.162"
uname -r
ne=/sys/class/misc/nitro_enclaves
# AWS: "With a memory pool, the parent instance has 4 slots. Without a pool, it has 0." Sizing: per sandbox its memory
# plus 2 MiB, plus 128 MiB per 8 PCIe slots; 3 sandboxes of 2 GiB with 12 slots: 3 x 2050 + 256 = 6406 MiB -> 7G.
if ! grep -qE '(^| )nitro_enclaves\.mempool=[0-9]+[KMG]?(@[0-9]+)?( |$)' /proc/cmdline; then
  die "no nitro_enclaves.mempool= on the kernel command line (/proc/cmdline). Run:
    grubby --update-kernel=ALL --args='nitro_enclaves.mempool=7G@0'
    reboot
  then run this script again (README.md, step 0)"
fi
pool="$(cat "$ne/mem_pool/total" 2>/dev/null || echo 0)"
[ "$pool" -gt 0 ] || die "the kernel command line names a memory pool but $ne/mem_pool/total is 0: reboot after grubby"
log "   CPU pool $(cat "$ne/cpu_pool/total" 2>/dev/null || echo '?') threads; memory pool $(( pool / 1048576 )) MiB, free $(( $(cat "$ne/mem_pool/free" 2>/dev/null || echo 0) / 1048576 )) MiB"

log "2. Firecracker and its jailer $VERSION, checked against the SHA-256 you gave"
dir=/opt/firecracker; mkdir -p "$dir"; cd "$dir"
tgz="firecracker-$VERSION-x86_64.tgz"
[ -f "$tgz" ] || curl -fsSLO "https://github.com/firecracker-microvm/firecracker/releases/download/$VERSION/$tgz"
echo "$FIRECRACKER_SHA256  $tgz" | sha256sum -c -
tar -xzf "$tgz"
install -m 0755 "release-$VERSION-x86_64/firecracker-$VERSION-x86_64" /usr/local/bin/firecracker
install -m 0755 "release-$VERSION-x86_64/jailer-$VERSION-x86_64" /usr/local/bin/jailer
firecracker --version; jailer --version
# The user that sends results: it holds the per-job summary credentials and never reads a guest's disk.
id fenvix-post >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin fenvix-post
# The parser of guest results runs as this user, with nothing readable but the bytes it is given on stdin.
id fenvix-parse >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin fenvix-parse
install -d -m 0711 /srv/jailer

log "3. slots: 12 (the value rounds up to a multiple of 4 slots per 8 in the pool; each 8 take 128 MiB of the pool)"
[ "$(cat "$ne/pcie_slots")" -ge 12 ] || echo 12 >"$ne/pcie_slots" || die "could not set 12 slots (pool too small? see step 1)"
log "   pcie_slots $(cat "$ne/pcie_slots") of $(cat "$ne/pcie_slots_total")"

log "4. the sandboxes' network: TAP devices fctap<N>, 172.16.<N>.2 behind 172.16.<N>.1, NAT to $(ip route show default | awk '{print $5; exit}')"
out="$(ip route show default | awk '{print $5; exit}')"
sysctl -q -w net.ipv4.ip_forward=1
# Strict reverse-path filtering: a sandbox cannot send from another sandbox's address.
sysctl -q -w net.ipv4.conf.all.rp_filter=1 net.ipv4.conf.default.rp_filter=1
# New TAP devices get no IPv6 at all (run-job.sh also sets it per device).
sysctl -q -w net.ipv6.conf.default.disable_ipv6=1
# Room in the connection-tracking table that one sandbox cannot exhaust (per-sandbox limit below: 4,096).
sysctl -q -w net.netfilter.nf_conntrack_max=262144 2>/dev/null || true

iptables -P FORWARD DROP
iptables -N FENVIX-SBX 2>/dev/null || iptables -F FENVIX-SBX
# Order matters: drops first, then the one ACCEPT. Everything is keyed on the interface, never on a source address.
iptables -A FENVIX-SBX -o fctap+ -j DROP                                            # sandbox -> another sandbox
iptables -A FENVIX-SBX -d 169.254.169.253 -p udp --dport 53 -o "$out" -j ACCEPT     # the VPC's DNS, nothing else
iptables -A FENVIX-SBX -d 169.254.169.253 -p tcp --dport 53 -o "$out" -j ACCEPT
iptables -A FENVIX-SBX -d 169.254.0.0/16 -j DROP                                    # metadata, time, every link-local
iptables -A FENVIX-SBX -m conntrack --ctstate NEW -m connlimit --connlimit-above 4096 --connlimit-mask 32 --connlimit-saddr -j DROP
iptables -A FENVIX-SBX -m conntrack --ctstate NEW -m hashlimit --hashlimit-above 200/second --hashlimit-burst 400 \
  --hashlimit-mode srcip --hashlimit-name fenvix-sbx-new -j DROP
iptables -A FENVIX-SBX -o "$out" -j ACCEPT
iptables -A FENVIX-SBX -j DROP
iptables -C FORWARD -i fctap+ -j FENVIX-SBX 2>/dev/null || iptables -I FORWARD 1 -i fctap+ -j FENVIX-SBX
iptables -C FORWARD -o fctap+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null \
  || iptables -A FORWARD -o fctap+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
# The parent itself: a sandbox reaches no port of it, the metadata service included.
iptables -C INPUT -i fctap+ -j DROP 2>/dev/null || iptables -I INPUT 1 -i fctap+ -j DROP
iptables -t nat -C POSTROUTING -s 172.16.0.0/16 -o "$out" -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 172.16.0.0/16 -o "$out" -j MASQUERADE
# IPv6: nothing from a sandbox, ever (link-local to the parent's listening services included).
ip6tables -C INPUT -i fctap+ -j DROP 2>/dev/null || ip6tables -I INPUT 1 -i fctap+ -j DROP
ip6tables -C FORWARD -i fctap+ -j DROP 2>/dev/null || ip6tables -I FORWARD 1 -i fctap+ -j DROP
ip6tables -C FORWARD -o fctap+ -j DROP 2>/dev/null || ip6tables -I FORWARD 1 -o fctap+ -j DROP

log "5. the parent's own metadata service: hop limit 1 (a forwarded packet never gets a token)"
log "   check: aws ec2 describe-instances --instance-ids <id> --query 'Reservations[].Instances[].MetadataOptions'"
log "host ready"
