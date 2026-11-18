#!/usr/bin/env bash
# Stops the always-on runner machine (runnerMode "always-on"). Its disk stays (the registration, the engine, the local
# cache); only the disk is billed while it is stopped. Queued fenvix jobs wait on GitHub; the App neither fails nor
# bills them (GitHub cancels a job queued for 24 hours: not billable).
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
id="$(output RunnerInstanceId)"
[ -n "$id" ] && [ "$id" != "None" ] || die "no always-on runner in $STACK (runnerMode is per-job, or the stack is not deployed)"
aws ec2 stop-instances --instance-ids "$id" --query 'StoppingInstances[0].CurrentState.Name' --output text
aws ec2 wait instance-stopped --instance-ids "$id"
echo "runner $id stopped"
