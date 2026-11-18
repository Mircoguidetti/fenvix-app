#!/usr/bin/env bash
# The always-on runner machine's first boot (cloud-init, root): install.sh, then the always-on services:
#   fenvix-runner          registers once with the token from SSM (kept on the disk: a stop/start needs no new
#                          token), then serves jobs; restarts by itself; enabled, so it comes back after a start;
#   fenvix-summary-poster  sends summary.json files to the App.
# Log: /var/log/fenvix-runner-setup.log
set -euo pipefail
exec > >(tee -a /var/log/fenvix-runner-setup.log) 2>&1
log() { printf '[fenvix-setup %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
# shellcheck source=/dev/null
. /etc/fenvix/runner.env
: "${FENVIX_REPO_URL:?}" "${FENVIX_RUNNER_NAME:?}"

bash /opt/fenvix/install.sh

log "services"
systemctl enable fenvix-summary-poster.service fenvix-runner.service
systemctl restart fenvix-summary-poster.service
# Starts at once; registration waits for the token in SSM (see fenvix-register), then the runner serves jobs.
systemctl restart --no-block fenvix-runner.service
log "checks"
if runuser -u fenvix -- strace -f -o /dev/null /bin/true; then log "strace -f as fenvix: ok"; else log "strace -f as fenvix: FAILED"; fi
if runuser -u fenvix -- curl -s -m 3 -o /dev/null http://169.254.169.254/latest/meta-data/; then
  log "instance metadata reachable by fenvix: NOT BLOCKED"; else log "instance metadata blocked for fenvix: ok"; fi
log "fenvix runner setup done"
