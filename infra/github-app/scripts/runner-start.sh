#!/usr/bin/env bash
# Starts the always-on runner machine again. It comes back by itself: the services are enabled, the registration is
# on its disk, so no new registration token is needed; GitHub shows the runner Idle within about a minute.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
id="$(output RunnerInstanceId)"
[ -n "$id" ] && [ "$id" != "None" ] || die "no always-on runner in $STACK (runnerMode is per-job, or the stack is not deployed)"
aws ec2 start-instances --instance-ids "$id" --query 'StartingInstances[0].CurrentState.Name' --output text
aws ec2 wait instance-running --instance-ids "$id"
echo "runner $id running; online on GitHub within about a minute (repository → Settings → Actions → Runners)"
