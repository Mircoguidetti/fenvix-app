#!/usr/bin/env bash
# fenvix runner machine: first-boot setup (run by cloud-init as root from the EC2 user data; safe to run again).
#   1. tools (git, curl, strace, build tools, python3, iptables, AWS CLI);
#   2. users: `fenvix` runs the GitHub runner and the customers' jobs; `fenvix-post` holds RUNNER_TOKEN and sends
#      run summaries, so job code can never read the token;
#   3. instance metadata (and so the machine's AWS role) blocked for both users;
#   4. runner/bootstrap.sh install (fenvix-engine-cli at a pinned commit) as `fenvix`;
#   5. systemd: fenvix-runner (registers once with the token from SSM, then serves jobs; restarts),
#      fenvix-summary-poster (sends summary.json files to the App).
# Log: /var/log/fenvix-runner-setup.log
set -euo pipefail
exec > >(tee -a /var/log/fenvix-runner-setup.log) 2>&1
log() { printf '[fenvix-setup %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

# shellcheck source=/dev/null
. /etc/fenvix/runner.env
: "${FENVIX_ENGINE_CLI_COMMIT:?}" "${FENVIX_REPO_URL:?}" "${FENVIX_RUNNER_NAME:?}" "${AWS_DEFAULT_REGION:?}"
RUNNER_HOME=/home/fenvix
ENGINE_DIR=$RUNNER_HOME/engine-cli
FENVIX_HOME=$RUNNER_HOME/fenvix
SPOOL=/var/spool/fenvix-summaries

log "1/6 tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl tar strace build-essential python3 iptables ca-certificates >/dev/null
command -v aws >/dev/null || [ -x /snap/bin/aws ] || snap install aws-cli --classic

log "2/6 users"
id fenvix >/dev/null 2>&1 || useradd --create-home --home-dir "$RUNNER_HOME" --shell /bin/bash fenvix
id fenvix-post >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin fenvix-post
install -d -m 0730 -o fenvix-post -g fenvix "$SPOOL"
install -d -m 0700 -o fenvix -g fenvix "$RUNNER_HOME/.fenvix"

log "3/6 instance metadata blocked for the job user; ptrace of a process's own children allowed (strace -f)"
systemctl daemon-reload
systemctl enable --now fenvix-imds-block.service
printf 'kernel.yama.ptrace_scope = 1\n' >/etc/sysctl.d/60-fenvix-ptrace.conf
sysctl -q --system

log "4/6 fenvix-engine-cli at $FENVIX_ENGINE_CLI_COMMIT, runner/bootstrap.sh install (builds the engine: several minutes)"
if [ ! -d "$ENGINE_DIR/.git" ]; then
  runuser -u fenvix -- git clone -q https://github.com/Mircoguidetti/fenvix-engine-cli.git "$ENGINE_DIR"
fi
runuser -u fenvix -- git -C "$ENGINE_DIR" fetch -q origin "$FENVIX_ENGINE_CLI_COMMIT" || true
runuser -u fenvix -- git -C "$ENGINE_DIR" -c advice.detachedHead=false checkout -q --detach "$FENVIX_ENGINE_CLI_COMMIT"
runuser -u fenvix -- env HOME="$RUNNER_HOME" FENVIX_HOME="$FENVIX_HOME" FENVIX_REPO_URL="$FENVIX_REPO_URL" \
  FENVIX_RUNNER_NAME="$FENVIX_RUNNER_NAME" bash "$ENGINE_DIR/runner/bootstrap.sh" install
# The runner's own libraries (bootstrap.sh tries with sudo, which the fenvix user does not have).
"$FENVIX_HOME/actions-runner/bin/installdependencies.sh" >/dev/null || log "installdependencies.sh failed (continuing)"

log "5/6 job-completed hook: the job's summary.json goes to the spool, the poster sends it"
env_file="$FENVIX_HOME/actions-runner/.env"
grep -q '^ACTIONS_RUNNER_HOOK_JOB_COMPLETED=' "$env_file" 2>/dev/null \
  || printf 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/opt/fenvix/bin/fenvix-job-completed\nFENVIX_SPOOL=%s\n' "$SPOOL" >>"$env_file"
chown fenvix:fenvix "$env_file"

log "6/6 services"
systemctl enable fenvix-summary-poster.service fenvix-runner.service
systemctl restart fenvix-summary-poster.service
# Starts at once; registration waits for the token in SSM (see fenvix-register), then the runner serves jobs.
systemctl restart --no-block fenvix-runner.service

log "checks"
if runuser -u fenvix -- strace -f -o /dev/null /bin/true; then log "strace -f as fenvix: ok"; else log "strace -f as fenvix: FAILED"; fi
if runuser -u fenvix -- curl -s -m 3 -o /dev/null http://169.254.169.254/latest/meta-data/; then
  log "instance metadata reachable by fenvix: NOT BLOCKED"; else log "instance metadata blocked for fenvix: ok"; fi
log "fenvix runner setup done"
