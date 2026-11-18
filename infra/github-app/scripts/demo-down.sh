#!/usr/bin/env bash
# Demo mode: after the demo.   bash scripts/demo-down.sh [owner/repo]
# Deregisters the demo runner from the repository and terminates the demo machine (its disk is deleted with it).
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
repo="${1:-$(ctx demoRepository)}"
fn="$(output DemoFunctionName)"
[ -n "$fn" ] && [ "$fn" != "None" ] || die "no demo function in $STACK (runnerMode is not demo, or the stack is not deployed)"
payload='{"action":"down"}'
[ -n "$repo" ] && payload="{\"action\":\"down\",\"repository\":\"$repo\"}"
out="$(mktemp)"
aws lambda invoke --function-name "$fn" --cli-binary-format raw-in-base64-out --payload "$payload" "$out" --query FunctionError --output text | grep -qv Unhandled \
  || { cat "$out" >&2; rm -f "$out"; die "the demo function failed"; }
cat "$out"; echo
ids="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write((r.terminated||[]).join(" "))' "$out")"
rm -f "$out"
if [ -n "$ids" ]; then
  # shellcheck disable=SC2086
  aws ec2 wait instance-terminated --instance-ids $ids
  echo "demo machine(s) terminated: $ids"
else
  echo "no demo machine was running"
fi
