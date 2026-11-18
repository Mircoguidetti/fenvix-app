#!/usr/bin/env bash
# Demo mode: one fresh runner machine for a demo.   bash scripts/demo-up.sh [owner/repo]
#   1. the runner image: reused if one exists, else built (scripts/build-image.sh, 30-45 minutes, once);
#   2. the demo function registers a runner (labels self-hosted, fenvix) on the repository through the App, and starts
#      one machine from the image (a new disk: nothing from an earlier demo);
#   3. waits until GitHub shows the runner online (about 1-2 minutes).
# The repository: the argument, else demoRepository in cdk.json. The App must be installed on it.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
repo="${1:-$(ctx demoRepository)}"
[[ "$repo" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || die "give the repository: bash scripts/demo-up.sh owner/repo"
fn="$(output DemoFunctionName)"
[ -n "$fn" ] && [ "$fn" != "None" ] || die "no demo function in $STACK (runnerMode is not demo, or the stack is not deployed)"

images="$(aws ec2 describe-images --owners self --filters Name=tag:fenvix:image,Values=runner Name=state,Values=available --query 'length(Images)' --output text)"
if [ "$images" = "0" ]; then
  echo "no runner image yet: building it once (30-45 minutes)"
  bash "$(dirname "$0")/build-image.sh"
fi

invoke() { # $1 JSON payload; prints the function's answer, fails on a function error
  local out; out="$(mktemp)"
  aws lambda invoke --function-name "$fn" --cli-binary-format raw-in-base64-out --payload "$1" "$out" \
    --query FunctionError --output text | grep -qv Unhandled || { cat "$out" >&2; rm -f "$out"; die "the demo function failed"; }
  cat "$out"; rm -f "$out"
}
echo "demo up: $repo"
invoke "{\"action\":\"up\",\"repository\":\"$repo\"}"; echo
for _ in $(seq 1 40); do
  if invoke "{\"action\":\"status\",\"repository\":\"$repo\"}" | grep -q '"status":"online"'; then
    echo "runner online on $repo: jobs with runs-on: fenvix run on it now. Take it down after the demo: bash scripts/demo-down.sh"
    exit 0
  fi
  sleep 15
done
die "the runner did not come online within 10 minutes: aws logs tail /aws/lambda/fenvix-$ENVNAME-github-app-demo; EC2 console → the instance → Get system log"
