#!/usr/bin/env bash
# Demo mode: after the demo.   bash scripts/demo-down.sh [owner/repo]
# Terminates the demo machine (its disk is deleted with it), waits until it is gone, then deregisters the demo runner
# from the repository (retrying for a minute while GitHub still marks it busy). Whatever is left, the reaper
# deregisters within the hour. Only demoRepository is accepted.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
repo="${1:-$(ctx demoRepository)}"
fn="$(output DemoFunctionName)"
[ -n "$fn" ] && [ "$fn" != "None" ] || die "no demo function in $STACK (runnerMode is not demo, or the stack is not deployed)"
payload='{"action":"down"}'
[ -n "$repo" ] && payload="{\"action\":\"down\",\"repository\":\"$repo\"}"
out="$(mktemp)"
aws lambda invoke --cli-read-timeout 200 --function-name "$fn" --cli-binary-format raw-in-base64-out --payload "$payload" "$out" --query FunctionError --output text | grep -qv Unhandled \
  || { cat "$out" >&2; rm -f "$out"; die "the demo function failed"; }
cat "$out"; echo
ids="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write((r.terminated||[]).join(" "))' "$out")"
rm -f "$out"
if [ -n "$ids" ]; then
  echo "demo machine(s) terminated: $ids (problems, if any, are listed above)"
else
  echo "no demo machine was running"
fi
