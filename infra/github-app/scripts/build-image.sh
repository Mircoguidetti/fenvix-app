#!/usr/bin/env bash
# Builds the per-job runner image (EC2 Image Builder pipeline of the stack) and waits for it (30-45 minutes: it builds
# the engine). Run it after the first deploy, and again after changing engineCliCommit or lib/runner/files.
# Job machines always start from the newest image tagged fenvix:image=runner; no deploy is needed after a build.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
arn="$(output ImagePipelineArn)"
[ -n "$arn" ] && [ "$arn" != "None" ] || die "no image pipeline in $STACK (runnerMode is always-on, or the stack is not deployed)"
image="$(aws imagebuilder start-image-pipeline-execution --image-pipeline-arn "$arn" --query imageBuildVersionArn --output text)"
echo "building $image"
while :; do
  read -r status ami <<<"$(aws imagebuilder get-image --image-build-version-arn "$image" \
    --query '[image.state.status, image.outputResources.amis[0].image]' --output text)"
  printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$status"
  case "$status" in
    AVAILABLE) echo "runner image ready: $ami"; exit 0 ;;
    FAILED|CANCELLED|DELETED) die "image build $status: aws imagebuilder get-image --image-build-version-arn $image --query image.state.reason" ;;
  esac
  sleep 60
done
