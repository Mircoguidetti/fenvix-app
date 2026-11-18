#!/usr/bin/env bash
# Customer-mode spike, step 2: the guest image every job boots from (run as root on the parent, once).
#   KERNEL=bzImage-6.18-...  BASE=ubuntu-24.04.squashfs  bash build-guest.sh   → guest/rootfs.ext4, guest/bzImage
# KERNEL: an EFI-stub bzImage (Firecracker CI x86_64 6.18 guest kernel, "bzImage-" artifact; see Firecracker
# docs/nitro-sandboxes/getting-started.md, "Getting a guest kernel for testing"). BASE: the CI Ubuntu rootfs
# (squashfs). The rootfs gets: tools, strace, Docker, the GitHub runner and the fenvix engine (runner/bootstrap.sh
# install, pinned commit), and the job service (guest/fenvix-guest-job). Nothing secret goes into it.
set -euo pipefail
: "${KERNEL:?EFI bzImage}" "${BASE:?base rootfs squashfs}"
COMMIT="${FENVIX_ENGINE_CLI_COMMIT:-a20b93d7f840b23f71c73c03efdaee3d6a233252}"
SIZE_GB="${SIZE_GB:-12}"
here="$(cd "$(dirname "$0")" && pwd)"
out="${here:?}/guest"
root="${out:?}/root"
command -v unsquashfs >/dev/null || dnf install -y -q squashfs-tools
[ -d "$root" ] && rm -rf -- "${root:?}"
unsquashfs -q -d "$root" "$BASE"
# The guest resolves through the VPC's resolver (reached through the parent's NAT), not the parent's local stub.
if [ -f /run/systemd/resolve/resolv.conf ]; then cp /run/systemd/resolve/resolv.conf "$root/etc/resolv.conf"; else cp /etc/resolv.conf "$root/etc/resolv.conf"; fi
install -m 0755 "$here/guest/fenvix-guest-job" "$root/usr/local/sbin/fenvix-guest-job"
install -m 0644 "$here/guest/fenvix-guest-job.service" "$root/etc/systemd/system/fenvix-guest-job.service"
for d in proc sys dev; do mount --bind "/$d" "$root/$d"; done
trap 'for d in dev sys proc; do umount "$root/$d" 2>/dev/null || true; done' EXIT
chroot "$root" /bin/bash -euo pipefail -c "
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq git curl tar strace build-essential python3 ca-certificates docker.io iptables e2fsprogs >/dev/null
  id fenvix >/dev/null 2>&1 || useradd --create-home --shell /bin/bash fenvix
  usermod -aG docker fenvix          # the job may start containers (services:, testcontainers), inside its own VM
  runuser -u fenvix -- git clone -q https://github.com/Mircoguidetti/fenvix-engine-cli.git /home/fenvix/engine-cli
  runuser -u fenvix -- git -C /home/fenvix/engine-cli -c advice.detachedHead=false checkout -q --detach $COMMIT
  runuser -u fenvix -- env HOME=/home/fenvix FENVIX_HOME=/home/fenvix/fenvix bash /home/fenvix/engine-cli/runner/bootstrap.sh install
  /home/fenvix/fenvix/actions-runner/bin/installdependencies.sh >/dev/null || true
  printf 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/usr/local/sbin/fenvix-guest-job\n' >>/home/fenvix/fenvix/actions-runner/.env
  systemctl enable fenvix-guest-job.service docker.service
"
truncate -s "${SIZE_GB}G" "$out/rootfs.ext4"
mkfs.ext4 -q -F -d "$root" "$out/rootfs.ext4"
cp "$KERNEL" "$out/bzImage"
echo "guest ready: $out/rootfs.ext4 ($(du -h --apparent-size "$out/rootfs.ext4" | cut -f1)), $out/bzImage"
