#!/usr/bin/env bash
# The guest image every job boots from (KVM Firecracker), built once per host by install-host.sh, or once and
# downloaded (GUEST_IMAGE_URL). Run as root on Linux with squashfs-tools and e2fsprogs.
#   KERNEL=vmlinux-6.1.155 BASE=ubuntu-24.04.squashfs OUT=/srv/jailer/guest bash build-guest.sh
# KERNEL: Firecracker CI's x86_64 guest kernel (an uncompressed vmlinux; 6.1.155 from firecracker-ci/v1.15 has every
# option Docker needs and CONFIG_IP_PNP, see tests). BASE: Firecracker CI's Ubuntu 24.04 rootfs (squashfs).
# Added: Docker (iptables-legacy: the guest kernel has no nf_tables), the GitHub Actions runner and the fenvix engines
# (detpy wheel, Node LTS + detjs) from fenvix-engine-cli's runner/bootstrap.sh at a pinned commit, and the job
# service. Nothing secret goes into the image.
set -euo pipefail
: "${KERNEL:?vmlinux}" "${BASE:?base rootfs squashfs}" "${OUT:?output directory}"
COMMIT="${FENVIX_ENGINE_CLI_COMMIT:-732f4560bcd1ead3433caac44f8a011d3115e2fc}"
SIZE_GB="${SIZE_GB:-16}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d /var/tmp/fenvix-guest.XXXXXX)"
root="$work/root"
cleanup() { for d in dev/pts dev sys proc; do umount "$root/$d" 2>/dev/null || true; done; rm -rf -- "${work:?}"; }
trap cleanup EXIT
unsquashfs -q -d "$root" "$BASE"
# Jobs resolve through public resolvers (phoenixNAP servers use 8.8.8.8 too); no host resolver is reachable.
rm -f "$root/etc/resolv.conf"; printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' >"$root/etc/resolv.conf"
install -m 0755 "$here/fenvix-guest-job" "$root/usr/local/sbin/fenvix-guest-job"
install -m 0644 "$here/fenvix-guest-job.service" "$root/etc/systemd/system/fenvix-guest-job.service"
for d in proc sys dev dev/pts; do mount --bind "/$d" "$root/$d"; done
chroot "$root" /bin/bash -euo pipefail -c "
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # The runner's libraries by name: its installdependencies.sh is never run as root (R-012 F5).
  apt-get install -y -qq git curl tar strace build-essential python3 python3-venv ca-certificates docker.io iptables \
    e2fsprogs libicu74 libkrb5-3 liblttng-ust1t64 libssl3t64 zlib1g >/dev/null
  # Docker programs iptables; the guest kernel has the legacy tables, not nf_tables.
  update-alternatives --set iptables /usr/sbin/iptables-legacy
  update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy
  mkdir -p /etc/docker && printf '{\"data-root\": \"/mnt/scratch/docker\"}\n' >/etc/docker/daemon.json
  id fenvix >/dev/null 2>&1 || useradd --create-home --shell /bin/bash fenvix
  usermod -aG docker fenvix          # inside its own VM: the job may start containers (services:, testcontainers)
  runuser -u fenvix -- git clone -q https://github.com/Mircoguidetti/fenvix-engine-cli.git /home/fenvix/engine-cli
  runuser -u fenvix -- git -C /home/fenvix/engine-cli -c advice.detachedHead=false checkout -q --detach $COMMIT
  runuser -u fenvix -- env HOME=/home/fenvix FENVIX_HOME=/home/fenvix/fenvix bash /home/fenvix/engine-cli/runner/bootstrap.sh install
  # The runner's work directory and Docker's data live on the per-job scratch disk (/dev/vdd).
  runuser -u fenvix -- ln -sfn /mnt/scratch/work /home/fenvix/fenvix/actions-runner/_work
  printf 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/usr/local/sbin/fenvix-guest-job\n' >>/home/fenvix/fenvix/actions-runner/.env
  systemctl enable fenvix-guest-job.service
  systemctl disable docker.service docker.socket   # started by the job service once the scratch disk is mounted
  apt-get clean
"
for d in dev/pts dev sys proc; do umount "$root/$d"; done
install -d -m 0700 "$OUT"
truncate -s "${SIZE_GB}G" "$OUT/rootfs.ext4.tmp"
mkfs.ext4 -q -F -L fxroot -d "$root" "$OUT/rootfs.ext4.tmp"
mv "$OUT/rootfs.ext4.tmp" "$OUT/rootfs.ext4"
install -m 0444 "$KERNEL" "$OUT/vmlinux"
echo "guest ready: $OUT/rootfs.ext4 ($(du -h "$OUT/rootfs.ext4" | cut -f1) used), $OUT/vmlinux"
