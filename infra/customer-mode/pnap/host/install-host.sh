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
apt-get install -y -qq nftables iproute2 conntrack e2fsprogs xfsprogs squashfs-tools curl python3 util-linux zstd cryptsetup-bin >/dev/null
modprobe nf_conntrack

log "3. users: fenvix-parse (reads guest results), fenvix-post (sends summaries), fenvix-cache; jail uids 900000-900249 free"
for u in fenvix-parse fenvix-post fenvix-cache; do
  id "$u" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$u"
done
if getent passwd | awk -F: '$3 >= 900000 && $3 < 900250 { found = 1 } END { exit !found }'; then
  fail "an account already uses a uid in 900000-900249 (the jail uids)"
fi

log "4. the data disk: an unused NVMe drive, encrypted with a key made at each boot and never stored (R-014 R4)"
# Every job's disks (a customer's root, scratch and input disks) live on /srv/jailer. With a random key that exists
# only in memory, whatever an interrupted job left, and whatever is on the drive when phoenixNAP gives the server to
# its next tenant, is unreadable after a reboot or a release. fenvix-data.service (bin/fenvix-data-disk) opens the
# drive, makes an XFS with reflink (each job's root disk is a reflink copy) and copies the guest image onto it, at
# every boot, before the agent starts.
install -d -m 0711 /srv/jailer
install -d -m 0700 /var/lib/fenvix /var/lib/fenvix/guest-image
if [ ! -s /etc/fenvix/data-disk ]; then
  for d in $(lsblk -dpno NAME,TYPE | awk '$2 == "disk" && $1 ~ /nvme/ { print $1 }'); do
    # unused: no partitions, no filesystem signature, not mounted, not part of the root device
    if [ "$(lsblk -no NAME "$d" | wc -l)" = 1 ] && ! blkid -p "$d" >/dev/null 2>&1 && ! grep -q "^$d" /proc/mounts; then
      # A name that survives a reboot (nvme0n1 and nvme1n1 may swap).
      stable="$(find -L /dev/disk/by-id -samefile "$d" -name 'nvme-*' ! -name '*-part*' 2>/dev/null | sort | head -1)"
      printf '%s\n' "${stable:-$d}" >/etc/fenvix/data-disk
      chmod 0600 /etc/fenvix/data-disk
      log "   ${stable:-$d} -> /srv/jailer (dm-crypt with a per-boot key, XFS with reflink)"
      break
    fi
  done
  [ -s /etc/fenvix/data-disk ] || log "   no unused NVMe drive: jobs' disks are full copies on the root filesystem (slower start, not encrypted)"
fi
ln -sfn /srv/jailer/guest /var/lib/fenvix/guest

log "4b. host hygiene for two tenants (Firecracker prod-host-setup.md; R-014 R2): SMT off, KSM off, no swap"
# SMT: no physical core may run two tenants' vCPUs on its sibling threads. Off now, at every boot (tmpfiles), and on
# the kernel command line for the next boot. The agent checks /sys/devices/system/cpu/smt/active before it enrols.
cat >/etc/tmpfiles.d/fenvix-host.conf <<'TMPFILES'
w- /sys/devices/system/cpu/smt/control - - - - off
w- /sys/kernel/mm/ksm/run - - - - 0
TMPFILES
if [ -w /sys/devices/system/cpu/smt/control ]; then
  case "$(cat /sys/devices/system/cpu/smt/control)" in
    on|off) echo off >/sys/devices/system/cpu/smt/control ;;
  esac
fi
if [ -d /etc/default/grub.d ] && command -v update-grub >/dev/null 2>&1; then
  # shellcheck disable=SC2016 # expanded by grub, not here
  echo 'GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT nosmt"' >/etc/default/grub.d/90-fenvix-nosmt.cfg
  update-grub >/dev/null 2>&1 || log "   update-grub failed: nosmt is set at each boot by tmpfiles only"
fi
# KSM: writing 2 unmerges every shared page (the write returns when it is done), then 0 keeps it stopped.
if [ -w /sys/kernel/mm/ksm/run ]; then echo 2 >/sys/kernel/mm/ksm/run; echo 0 >/sys/kernel/mm/ksm/run; fi
# Swap: no guest memory ever written to a disk.
swapoff -a
sed -i -E '/^[^#].*[[:space:]]swap[[:space:]]/s/^/# fenvix: no swap # /' /etc/fstab
systemctl mask --now swap.target >/dev/null 2>&1 || true
[ "$(cat /sys/devices/system/cpu/smt/active 2>/dev/null || echo 0)" = 0 ] || fail "SMT is still active"
[ "$(cat /sys/kernel/mm/ksm/run 2>/dev/null || echo 0)" = 0 ] || fail "KSM is still running"
[ "$(tail -n +2 /proc/swaps | wc -l)" = 0 ] || fail "swap is still on"
log "   CPU vulnerabilities as the kernel reports them (checked on the first real host):"
grep -H . /sys/devices/system/cpu/vulnerabilities/* 2>/dev/null | sed 's/^/   /' || true

log "5. Firecracker and its jailer $FIRECRACKER_VERSION"
tgz="/var/tmp/firecracker-$FIRECRACKER_VERSION-x86_64.tgz"
fetch "https://github.com/firecracker-microvm/firecracker/releases/download/$FIRECRACKER_VERSION/firecracker-$FIRECRACKER_VERSION-x86_64.tgz" "$FIRECRACKER_SHA256" "$tgz"
tar -xzf "$tgz" -C /var/tmp
install -m 0755 "/var/tmp/release-$FIRECRACKER_VERSION-x86_64/firecracker-$FIRECRACKER_VERSION-x86_64" /usr/local/bin/firecracker
install -m 0755 "/var/tmp/release-$FIRECRACKER_VERSION-x86_64/jailer-$FIRECRACKER_VERSION-x86_64" /usr/local/bin/jailer
firecracker --version | head -1; jailer --version | head -1

log "6. the guest kernel and root disk (kept on the root filesystem; copied onto the data disk at each boot)"
img=/var/lib/fenvix/guest-image
fetch "$GUEST_KERNEL_URL" "$GUEST_KERNEL_SHA256" /var/tmp/vmlinux
if [ -n "${GUEST_IMAGE_URL:-}" ]; then
  fetch "$GUEST_IMAGE_URL" "${GUEST_IMAGE_SHA256:?}" /var/tmp/rootfs.ext4.zst
  zstd -q -d -f /var/tmp/rootfs.ext4.zst -o "$img/rootfs.ext4"
  install -m 0444 /var/tmp/vmlinux "$img/vmlinux"
else
  : "${GUEST_BASE_URL:?}" "${GUEST_BASE_SHA256:?}"
  fetch "$GUEST_BASE_URL" "$GUEST_BASE_SHA256" /var/tmp/base.squashfs
  KERNEL=/var/tmp/vmlinux BASE=/var/tmp/base.squashfs OUT="$img" bash "$here/guest/build-guest.sh"
fi
chmod 0400 "$img/rootfs.ext4"
install -m 0644 "$here/systemd/fenvix-data.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable fenvix-data.service
systemctl start fenvix-data.service || fail "the data disk could not be prepared (journalctl -u fenvix-data)"
[ -s /srv/jailer/guest/rootfs.ext4 ] || fail "no guest image on /srv/jailer"

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
