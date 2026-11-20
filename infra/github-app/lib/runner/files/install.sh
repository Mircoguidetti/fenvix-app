#!/usr/bin/env bash
# fenvix machine image (our machines, the design of 2026-11-20): install everything, start nothing (root; safe to run
# again). Run by EC2 Image Builder (lib/runner-fleet.ts). The build machine cannot read any of our SSM parameters.
#   1. tools (git, curl, strace, build tools, python3 and venv, iptables, iproute2, util-linux; the GitHub runner's
#      libraries by name); no AWS CLI;
#   2. the slot users fenvix-s1..s16 (uid 20001..20016): each job of the machine's one customer runs as one of them,
#      in its own sandbox (fenvix-slot);
#   3. the instance metadata service for root only (fenvix-imds-block);
#   4. the GitHub runner, pinned by version and sha256, as a root-owned template copied into each slot per job;
#   5. the engine: the fenvix-engine-cli TRUNK artifact, fetched by version and checked by sha256 (fail closed: no pin,
#      a download error or another checksum stops the image build; audit G-0186), installed into /opt/fenvix; its
#      version is written to /opt/fenvix/ENGINE (the agent reports it at hello, every job prints it in its log);
#   6. the agent (fenvix-agent.service, enabled): it starts at every boot and reads the machine's settings itself.
# Log: /var/log/fenvix-machine-setup.log
set -euo pipefail
exec > >(tee -a /var/log/fenvix-machine-setup.log) 2>&1
log() { printf '[fenvix-setup %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

# shellcheck source=/dev/null
. "${FENVIX_IMAGE_ENV:-/etc/fenvix/runner.env}"
: "${FENVIX_RUNNER_VERSION:?}" "${FENVIX_RUNNER_SHA256:?}"
die() { log "STOP: $*"; exit 1; }

log "1/6 tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# The GitHub runner's own libraries, by name (its installdependencies.sh is never run as root).
apt-get install -y -qq git curl tar strace build-essential python3 python3-venv python3-pip iptables iproute2 util-linux \
  procps ca-certificates libicu74 libkrb5-3 liblttng-ust1t64 libssl3t64 zlib1g >/dev/null

log "2/6 slot users"
for n in $(seq 1 16); do
  u="fenvix-s$n"; uid=$((20000 + n))
  id "$u" >/dev/null 2>&1 || useradd --uid "$uid" --user-group --no-create-home --home-dir "/srv/fenvix/slot/$n" --shell /bin/bash "$u"
done
install -d -m 0755 -o root -g root /srv/fenvix /srv/fenvix/slot
# ptrace of a process's own children only (strace -f inside a job works; nothing across slots).
printf 'kernel.yama.ptrace_scope = 1\n' >/etc/sysctl.d/60-fenvix-ptrace.conf

log "3/6 instance metadata for root only"
systemctl daemon-reload
systemctl enable fenvix-imds-block.service

log "4/6 GitHub runner ${FENVIX_RUNNER_VERSION} (pinned sha256)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL --proto '=https' --retry 3 -o "$tmp/runner.tgz" \
  "https://github.com/actions/runner/releases/download/v${FENVIX_RUNNER_VERSION}/actions-runner-linux-x64-${FENVIX_RUNNER_VERSION}.tar.gz" \
  || die "the GitHub runner download failed"
[ "$(sha256sum "$tmp/runner.tgz" | cut -d' ' -f1)" = "$FENVIX_RUNNER_SHA256" ] || die "the GitHub runner's sha256 is not the pinned one"
rm -rf /opt/fenvix/actions-runner && install -d -m 0755 /opt/fenvix/actions-runner
tar -xzf "$tmp/runner.tgz" -C /opt/fenvix/actions-runner
chown -R root:root /opt/fenvix/actions-runner && chmod -R go-w /opt/fenvix/actions-runner

log "5/6 the engine (trunk artifact, pinned)"
if [ -z "${FENVIX_ENGINE_URL:-}" ] || [ -z "${FENVIX_ENGINE_SHA256:-}" ] || [ -z "${FENVIX_ENGINE_VERSION:-}" ]; then
  die "no engine pinned (settings engineVersion, engineUrl, engineSha256): no image without the trunk engine"
fi
[[ "$FENVIX_ENGINE_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "engineSha256 is not a sha256"
case "$FENVIX_ENGINE_URL" in https://*) ;; *) die "engineUrl must be https://" ;; esac
curl -fsSL --proto '=https' --retry 3 -o "$tmp/engine.tgz" "$FENVIX_ENGINE_URL" || die "engine download failed: $FENVIX_ENGINE_URL"
got="$(sha256sum "$tmp/engine.tgz" | cut -d' ' -f1)"
[ "$got" = "$FENVIX_ENGINE_SHA256" ] || die "engine checksum mismatch: expected $FENVIX_ENGINE_SHA256, got $got (nothing installed)"
top="$(tar -tzf "$tmp/engine.tgz" | cut -d/ -f1 | sort -u)"
if [ "$(printf '%s\n' "$top" | wc -l)" -ne 1 ] || [[ "$top" != "fenvix-engine-${FENVIX_ENGINE_VERSION}"* ]]; then die "unexpected engine archive layout: $top"; fi
if tar -tzf "$tmp/engine.tgz" | grep -qE '(^/|(^|/)\.\.(/|$))'; then die "engine archive has absolute or parent paths"; fi
tar -xzf "$tmp/engine.tgz" -C "$tmp"
# Its own Python environment (Ubuntu's python3 is externally managed): the pytest plugin, the runners, `fenvix`.
python3 -m venv /opt/fenvix/venv
PYTHON=/opt/fenvix/venv/bin/python bash "$tmp/$top/install.sh" /opt/fenvix || die "the engine's install.sh failed"
ln -sf /opt/fenvix/venv/bin/fenvix /usr/local/bin/fenvix 2>/dev/null || true
# The engine's wheels stay on the image: a replay installs them into the project's own Python (fenvix-replay).
install -d -m 0755 /opt/fenvix/wheels
cp "$tmp/$top"/wheels/*.whl /opt/fenvix/wheels/ 2>/dev/null || true
printf '%s sha256=%s\n' "$FENVIX_ENGINE_VERSION" "$FENVIX_ENGINE_SHA256" >/opt/fenvix/ENGINE
chmod 0644 /opt/fenvix/ENGINE
log "engine: $(cat /opt/fenvix/ENGINE)"

log "6/6 the agent"
systemctl daemon-reload
systemctl enable fenvix-agent.service
log "fenvix machine install done"
