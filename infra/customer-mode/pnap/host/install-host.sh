#!/usr/bin/env bash
# Turns a fresh phoenixNAP Bare Metal Cloud server (Ubuntu 24.04, ubuntu/noble; d3.c1.large by default) into a fenvix
# customer-mode host. Run once, as root, by the cloud-init user data the App's scaler generated
# (github-app/src/pnap/userdata.ts), from /opt/fenvix-host. Needs no secret: the enrolment secret is already in
# /etc/fenvix/enrol (single use); the agent exchanges it once this script is done.
#
# Inputs (environment, set by the user data; every download is checked against its SHA-256):
#   FIRECRACKER_VERSION, FIRECRACKER_SHA256      the release archive of Firecracker and its jailer
#   GUEST_KERNEL_URL, GUEST_KERNEL_SHA256        Firecracker CI's x86_64 vmlinux
#   GUEST_BASE_URL, GUEST_BASE_SHA256            Firecracker CI's Ubuntu 24.04 rootfs (squashfs), to build the guest
#   GUEST_IMAGE_URL, GUEST_IMAGE_SHA256          optional: a prebuilt rootfs.ext4.zst instead of building one here
#   FENVIX_ENGINE_CLI_COMMIT                     the engines and runner baked into the guest
# Any failure stops here and leaves /var/lib/fenvix/install-failed: the agent never enrols, and the scaler releases
# the server once its enrolment deadline passes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
log() { printf '[fenvix-install] %s\n' "$*"; }
fail() { printf '[fenvix-install] STOP: %s\n' "$*" >&2; mkdir -p /var/lib/fenvix; echo "$*" >/var/lib/fenvix/install-failed; exit 1; }
trap 'fail "line $LINENO: $BASH_COMMAND"' ERR
: "${FIRECRACKER_VERSION:?}" "${FIRECRACKER_SHA256:?}" "${GUEST_KERNEL_URL:?}" "${GUEST_KERNEL_SHA256:?}"
fetch() { # url sha256 dest
  curl -fsSL --retry 5 --retry-delay 3 -o "$3.part" "$1"
  echo "$2  $3.part" | sha256sum -c --quiet - || { rm -f "$3.part"; fail "SHA-256 mismatch for $1"; }
  mv "$3.part" "$3"
}

log "1. KVM"
grep -Eqw 'vmx|svm' /proc/cpuinfo || fail "the CPU offers no hardware virtualization (vmx/svm)"
modprobe kvm_intel 2>/dev/null || modprobe kvm_amd 2>/dev/null || true
[ -c /dev/kvm ] || fail "no /dev/kvm (virtualization disabled in firmware?)"
[ -f /sys/fs/cgroup/cgroup.controllers ] || fail "cgroup v2 is required"

log "2. packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nftables iproute2 conntrack e2fsprogs xfsprogs squashfs-tools curl python3 util-linux zstd >/dev/null
modprobe nf_conntrack

log "3. users: fenvix-parse (reads guest results), fenvix-post (sends summaries), fenvix-cache; jail uids 900000-900249 free"
for u in fenvix-parse fenvix-post fenvix-cache; do
  id "$u" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$u"
done
if getent passwd | awk -F: '$3 >= 900000 && $3 < 900250 { found = 1 } END { exit !found }'; then
  fail "an account already uses a uid in 900000-900249 (the jail uids)"
fi

log "4. the data disk: an unused NVMe drive as XFS with reflink (each job's root disk is a reflink copy)"
install -d -m 0711 /srv/jailer
if ! mountpoint -q /srv/jailer; then
  disk=""
  for d in $(lsblk -dpno NAME,TYPE | awk '$2 == "disk" && $1 ~ /nvme/ { print $1 }'); do
    # unused: no partitions, no filesystem signature, not mounted, not part of the root device
    if [ "$(lsblk -no NAME "$d" | wc -l)" = 1 ] && ! blkid -p "$d" >/dev/null 2>&1 && ! grep -q "^$d" /proc/mounts; then disk="$d"; break; fi
  done
  if [ -n "$disk" ]; then
    mkfs.xfs -q -f -m reflink=1 -L fenvix-data "$disk"
    echo "LABEL=fenvix-data /srv/jailer xfs defaults,noatime 0 2" >>/etc/fstab
    mount /srv/jailer
    log "   $disk -> /srv/jailer (XFS, reflink)"
  else
    log "   no unused NVMe drive: jobs' disks are full copies on the root filesystem (slower start)"
  fi
fi
chmod 0711 /srv/jailer
install -d -m 0700 /srv/jailer/guest /var/lib/fenvix
ln -sfn /srv/jailer/guest /var/lib/fenvix/guest

log "5. Firecracker and its jailer $FIRECRACKER_VERSION"
tgz="/var/tmp/firecracker-$FIRECRACKER_VERSION-x86_64.tgz"
fetch "https://github.com/firecracker-microvm/firecracker/releases/download/$FIRECRACKER_VERSION/firecracker-$FIRECRACKER_VERSION-x86_64.tgz" "$FIRECRACKER_SHA256" "$tgz"
tar -xzf "$tgz" -C /var/tmp
install -m 0755 "/var/tmp/release-$FIRECRACKER_VERSION-x86_64/firecracker-$FIRECRACKER_VERSION-x86_64" /usr/local/bin/firecracker
install -m 0755 "/var/tmp/release-$FIRECRACKER_VERSION-x86_64/jailer-$FIRECRACKER_VERSION-x86_64" /usr/local/bin/jailer
firecracker --version | head -1; jailer --version | head -1

log "6. the guest kernel and root disk"
fetch "$GUEST_KERNEL_URL" "$GUEST_KERNEL_SHA256" /var/tmp/vmlinux
if [ -n "${GUEST_IMAGE_URL:-}" ]; then
  fetch "$GUEST_IMAGE_URL" "${GUEST_IMAGE_SHA256:?}" /var/tmp/rootfs.ext4.zst
  zstd -q -d -f /var/tmp/rootfs.ext4.zst -o /srv/jailer/guest/rootfs.ext4
  install -m 0444 /var/tmp/vmlinux /srv/jailer/guest/vmlinux
else
  : "${GUEST_BASE_URL:?}" "${GUEST_BASE_SHA256:?}"
  fetch "$GUEST_BASE_URL" "$GUEST_BASE_SHA256" /var/tmp/base.squashfs
  KERNEL=/var/tmp/vmlinux BASE=/var/tmp/base.squashfs OUT=/srv/jailer/guest bash "$here/guest/build-guest.sh"
fi
chmod 0400 /srv/jailer/guest/rootfs.ext4

log "7. kernel settings"
cat >/etc/sysctl.d/90-fenvix.conf <<'SYSCTL'
net.ipv4.ip_forward = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv6.conf.default.disable_ipv6 = 1
net.netfilter.nf_conntrack_max = 1048576
kernel.unprivileged_bpf_disabled = 1
SYSCTL
echo nf_conntrack >/etc/modules-load.d/fenvix.conf
sysctl -q -e --system
# SSH: keys only (phoenixNAP installs the account's keys); the agent needs no inbound port.
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh || true

log "8. the agent"
install -m 0644 "$here/systemd/fenvix-agent.service" "$here/systemd/fenvix-cache.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now fenvix-agent.service
log "done: the agent enrols with the App and starts leasing jobs"
