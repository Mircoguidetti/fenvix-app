#!/usr/bin/env bash
# Shared by the scripts here: region, env, stack name, and reading one stack output.
# shellcheck disable=SC2034
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ctx() { node -e 'const c=require(process.argv[1]).context; process.stdout.write(String(c[process.argv[2]] ?? ""))' "$HERE/cdk.json" "$1"; }
REGION="${FENVIX_REGION:-$(ctx region)}"
ENVNAME="${FENVIX_ENV:-$(ctx env)}"
STACK="fenvix-$ENVNAME-github-app"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text 2>/dev/null || true
}
die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
