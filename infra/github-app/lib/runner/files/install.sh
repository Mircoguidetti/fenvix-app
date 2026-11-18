#!/usr/bin/env bash
# fenvix runner machine: install everything a runner needs, start nothing (root; safe to run again). Used twice:
#   - by EC2 Image Builder, to bake the per-job runner image (lib/runner-image.ts);
#   - by setup.sh, on the always-on machine's first boot.
#   1. tools (git, curl, strace, build tools, python3, iptables, AWS CLI);
#   2. users: `fenvix` runs the GitHub runner and the customers' jobs; `fenvix-post` holds RUNNER_TOKEN and sends
#      run summaries, so job code can never read the token;
#   3. instance metadata (and so the machine's AWS role) blocked for both users;
#   4. runner/bootstrap.sh install (fenvix-engine-cli at a pinned commit) as `fenvix`;
#   5. the job hooks (summary.json to the spool when a job ends; a marker when a job starts).
# The services (always-on: setup.sh; one machine per job: fenvix-job.target) start elsewhere.
# Log: /var/log/fenvix-runner-setup.log
set -euo pipefail
exec > >(tee -a /var/log/fenvix-runner-setup.log) 2>&1
log() { printf '[fenvix-setup %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

# shellcheck source=/dev/null
. /etc/fenvix/runner.env
: "${FENVIX_ENGINE_CLI_COMMIT:?}" "${AWS_DEFAULT_REGION:?}"
RUNNER_HOME=/home/fenvix
ENGINE_DIR=$RUNNER_HOME/engine-cli
FENVIX_HOME=$RUNNER_HOME/fenvix
SPOOL=/var/spool/fenvix-summaries

log "1/5 tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl tar strace build-essential python3 iptables ca-certificates >/dev/null
command -v aws >/dev/null || [ -x /snap/bin/aws ] || snap install aws-cli --classic

log "2/5 users"
id fenvix >/dev/null 2>&1 || useradd --create-home --home-dir "$RUNNER_HOME" --shell /bin/bash fenvix
id fenvix-post >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin fenvix-post
install -d -m 0730 -o fenvix-post -g fenvix "$SPOOL"
install -d -m 0700 -o fenvix -g fenvix "$RUNNER_HOME/.fenvix"

log "3/5 instance metadata blocked for the job user; ptrace of a process's own children allowed (strace -f)"
systemctl daemon-reload
systemctl enable --now fenvix-imds-block.service
printf 'kernel.yama.ptrace_scope = 1\n' >/etc/sysctl.d/60-fenvix-ptrace.conf
sysctl -q --system

log "4/5 fenvix-engine-cli at $FENVIX_ENGINE_CLI_COMMIT, runner/bootstrap.sh install (builds the engine: several minutes)"
if [ ! -d "$ENGINE_DIR/.git" ]; then
  runuser -u fenvix -- git clone -q https://github.com/Mircoguidetti/fenvix-engine-cli.git "$ENGINE_DIR"
fi
runuser -u fenvix -- git -C "$ENGINE_DIR" fetch -q origin "$FENVIX_ENGINE_CLI_COMMIT" || true
runuser -u fenvix -- git -C "$ENGINE_DIR" -c advice.detachedHead=false checkout -q --detach "$FENVIX_ENGINE_CLI_COMMIT"
runuser -u fenvix -- env HOME="$RUNNER_HOME" FENVIX_HOME="$FENVIX_HOME" bash "$ENGINE_DIR/runner/bootstrap.sh" install
# The runner's own libraries (bootstrap.sh tries with sudo, which the fenvix user does not have).
"$FENVIX_HOME/actions-runner/bin/installdependencies.sh" >/dev/null || log "installdependencies.sh failed (continuing)"

log "5/5 job hooks: summary.json to the spool when a job ends (the poster sends it); a marker when a job starts"
env_file="$FENVIX_HOME/actions-runner/.env"
grep -q '^ACTIONS_RUNNER_HOOK_JOB_COMPLETED=' "$env_file" 2>/dev/null \
  || printf 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/opt/fenvix/bin/fenvix-job-completed\nACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/fenvix/bin/fenvix-job-started\nFENVIX_SPOOL=%s\n' "$SPOOL" >>"$env_file"
chown fenvix:fenvix "$env_file"
systemctl daemon-reload
log "fenvix runner install done"

