#!/usr/bin/env bash
# fenvix runner machine: install everything a runner needs, start nothing (root; safe to run again). Used by EC2 Image
# Builder to bake the runner image (lib/runner-fleet.ts). The build machine cannot read any of our SSM parameters.
#   1. tools (git, curl, strace, build tools, python3, iptables, the GitHub runner's libraries; no AWS CLI);
#   2. users: `fenvix` runs the GitHub runner and the customers' jobs; `fenvix-post` holds the machine's summary
#      credential and sends run summaries, so job code can never read it;
#   3. instance metadata (the user data holds the machine's credentials) blocked for both users;
#   4. runner/bootstrap.sh install (fenvix-engine-cli at a pinned commit) as `fenvix`;
#   5. the job hooks (summary.json to the spool when a job ends; a marker when a job starts).
# The services (demo: fenvix-runner + poster; one machine per job: fenvix-job.target) start from the user data.
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
# The GitHub runner's own libraries are installed here, by name, as root. Its installdependencies.sh is never run:
# by step 4 it is a file the `fenvix` user owns, and code from step 4's downloads could have rewritten it (R-012 F5).
apt-get install -y -qq git curl tar strace build-essential python3 iptables ca-certificates \
  libicu74 libkrb5-3 liblttng-ust1t64 libssl3t64 zlib1g >/dev/null

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
# Nothing below runs, as root, a file the `fenvix` user owns or could have written.

log "5/5 job hooks: summary.json to the spool when a job ends (the poster sends it); a marker when a job starts"
# Written as `fenvix`, never by root: a file in the job user's directory may be a symlink by now (R-012 F5).
runuser -u fenvix -- env SPOOL="$SPOOL" ENV_FILE="$FENVIX_HOME/actions-runner/.env" sh -c '
  grep -q "^ACTIONS_RUNNER_HOOK_JOB_COMPLETED=" "$ENV_FILE" 2>/dev/null || printf "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/opt/fenvix/bin/fenvix-job-completed\nACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/fenvix/bin/fenvix-job-started\nFENVIX_SPOOL=%s\n" "$SPOOL" >>"$ENV_FILE"'
systemctl daemon-reload
log "fenvix runner install done"

