#!/usr/bin/env bash
# The first real test of customer mode on phoenixNAP (docs/CUSTOMER-MODE-PNAP.md, "The first real test"):
# rents ONE host in one region for about an hour, runs 3 jobs from 2 test organizations (2 in A, 1 in B) on it, checks
# isolation from inside each job (probe.sh) and the timings, and releases the host. The host is released on every
# exit path (trap), and the script waits until phoenixNAP has it.
#
#   bash first-test.sh --region ASH --repo-a org-a/fenvix-test --installation-a 111 --repo-b org-b/fenvix-test \
#        --installation-b 222 [--minutes 60] [--function fenvix-prod-github-app-scaler] [--yes]
#   bash first-test.sh --print-workflow     # the workflow file to commit in both test repositories
#
# Needs: aws (allowed to invoke the scaler function), gh (logged in; may dispatch workflows in both repositories), jq.
# It holds no phoenixNAP or GitHub App secret: the scaler function orders and releases the server.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
AWS="${FENVIX_AWS:-aws}"; GH="${FENVIX_GH:-gh}"; POLL="${POLL_SECONDS:-30}"
region="" repo_a="" repo_b="" inst_a="" inst_b="" minutes=60 fn="fenvix-prod-github-app-scaler" yes=0
log() { printf '[first-test %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "STOP: $*"; exit 1; }

if [ "${1:-}" = "--print-workflow" ]; then
  # probe.sh goes INTO the workflow (R-014 R11): the test repositories cannot read our private repository.
  grep -q '^FENVIX_PROBE$' "$here/probe.sh" && die "probe.sh may not contain the heredoc delimiter"
  sha="$(sha256sum "$here/probe.sh" | cut -d' ' -f1)"
  awk -v sha="$sha" -v probe="$here/probe.sh" '
    /^__PROBE_SH__$/ { while ((getline line < probe) > 0) print (line == "" ? "" : "          " line); next }
    { gsub(/__PROBE_SHA256__/, sha); print }' "$here/fenvix-first-test.yml"
  exit 0
fi
while [ $# -gt 0 ]; do
  case "$1" in
    --region) region="$2"; shift 2 ;;
    --repo-a) repo_a="$2"; shift 2 ;;
    --repo-b) repo_b="$2"; shift 2 ;;
    --installation-a) inst_a="$2"; shift 2 ;;
    --installation-b) inst_b="$2"; shift 2 ;;
    --minutes) minutes="$2"; shift 2 ;;
    --function) fn="$2"; shift 2 ;;
    --yes) yes=1; shift ;;
    *) die "unknown argument $1 (see the header of this script)" ;;
  esac
done
[[ "$region" =~ ^(ASH|PHX|CHI|SEA|NLD)$ ]] || die "--region ASH, PHX, CHI, SEA or NLD"
for r in "$repo_a" "$repo_b"; do [[ "$r" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || die "--repo-a and --repo-b: owner/name"; done
[ "${repo_a%%/*}" != "${repo_b%%/*}" ] || die "the two test repositories must belong to two different organizations"
for i in "$inst_a" "$inst_b"; do [[ "$i" =~ ^[0-9]+$ ]] || die "--installation-a and --installation-b: the App's installation ids"; done
if ! [[ "$minutes" =~ ^[0-9]+$ ]] || [ "$minutes" -lt 30 ] || [ "$minutes" -gt 180 ]; then die "--minutes 30 to 180"; fi
command -v jq >/dev/null || die "jq is required"

work="$(mktemp -d)"
try_invoke() { # payload-json -> response json on stdout; returns 1 (never exits) when the call failed
  "$AWS" lambda invoke --function-name "$fn" --cli-binary-format raw-in-base64-out --payload "$1" "$work/out.json" >"$work/meta.json" \
    || { log "   could not invoke $fn"; return 1; }
  if jq -e '.FunctionError' "$work/meta.json" >/dev/null 2>&1; then log "   $fn failed: $(jq -c . "$work/out.json")"; return 1; fi
  cat "$work/out.json"
}
invoke() { try_invoke "$1" || die "could not invoke $fn with $1"; }
# The release path (also run by the EXIT trap) must never exit half-way (R-014 R8): every call is retried with a
# growing pause (throttling: the scaler has reserved concurrency 1 and also runs every minute), and nothing in it dies.
retry_invoke() {
  local i pause=5
  for i in 1 2 3 4 5 6; do
    try_invoke "$1" && return 0
    log "   attempt $i failed; again in ${pause} s"
    sleep "$(( POLL > 0 ? pause : 0 ))"; pause=$(( pause * 2 ))
  done
  return 1
}
live_of() { jq --arg r "$region" '[.hosts[] | select(.region == $r and .role == "runner" and (.state | IN("released", "failed") | not))]'; }
live_hosts() { invoke '{"action":"status"}' | live_of; }

cat >&2 <<INFO
This rents ONE phoenixNAP server in $region for about $minutes minutes (d3.c1.large, hourly: \$1.27 per started hour,
DECLARED 2026-11-18; see docs/CUSTOMER-MODE-PNAP.md for the full estimate), runs 3 jobs ($repo_a x2, $repo_b x1) and
releases the server on every exit path. Likely cost: \$1.27 to \$2.54 plus the IP; at most about \$3.90 by this
script's own deadlines (90 + 40 + 20 minutes: 3 started hours).
INFO
if [ "$yes" != 1 ]; then read -r -p "Go? [y/N] " ok; [ "$ok" = y ] || die "not confirmed"; fi

released=0
release() {
  [ "$released" = 1 ] && return 0
  released=1
  log "releasing every host of $region"
  local asked=0 n st end=$(( $(date +%s) + 20 * 60 ))
  for _ in $(seq 1 40); do
    [ "$(date +%s)" -lt "$end" ] || break  # 20 minutes at most, whatever the retries took
    # Asked again until it went through once: a release call that failed (throttled, expired credentials) is retried.
    if [ "$asked" = 0 ]; then retry_invoke "{\"action\":\"release\",\"region\":\"$region\"}" >/dev/null && asked=1; fi
    if st="$(retry_invoke '{"action":"status"}')"; then
      n="$(live_of <<<"$st" | jq length)"
      [ "$asked" = 1 ] && [ "$n" = 0 ] && { log "released: no host of $region left"; return 0; }
    fi
    retry_invoke '{"action":"scale"}' >/dev/null || true
    sleep "$POLL"
  done
  log "WARNING: a host of $region may still be live (\$1.27/h): run this script's release again, or check the"
  log "WARNING: scaler log and the BMC portal (servers named fx-*). The hold still ends after --minutes, then the scaler"
  log "WARNING: drains the idle host at the end of its paid hour."
  return 1
}
trap 'release; rm -rf -- "$work"' EXIT
trap 'exit 130' INT TERM

log "1. both test installations run in $region"
invoke "{\"action\":\"set-region\",\"installationId\":$inst_a,\"region\":\"$region\"}" >/dev/null
invoke "{\"action\":\"set-region\",\"installationId\":$inst_b,\"region\":\"$region\"}" >/dev/null

log "2. one host in $region for $minutes minutes"
t_order=$(date +%s)
invoke "{\"action\":\"hold\",\"region\":\"$region\",\"hosts\":1,\"minutes\":$minutes}" | jq -c '.actions' >&2
host=""
deadline=$(( $(date +%s) + 90 * 60 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  h="$(live_hosts | jq -c '.[0] // empty')"
  state="$(jq -r '.state // "none"' <<<"${h:-{\}}")"
  [ "$state" = ready ] && { host="$(jq -r .host_id <<<"$h")"; break; }
  log "   host: $state"
  sleep "$POLL"
done
[ -n "$host" ] || die "no host became ready within 90 minutes (scaler log: /aws/lambda/$fn)"
t_ready=$(date +%s)
log "   $host ready after $(( t_ready - t_order )) s (order, phoenixNAP provisioning, our install, enrolment)"

log "3. 3 jobs: $repo_a x2, $repo_b x1"
nonce="ft-$(date +%s)"
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
for r in "$repo_a" "$repo_a" "$repo_b"; do
  "$GH" workflow run fenvix-first-test.yml -R "$r" -f nonce="$nonce" >/dev/null || die "could not dispatch the workflow in $r (is fenvix-first-test.yml committed? see --print-workflow)"
done

log "4. waiting for the 3 runs"
runs() { # repo -> the runs dispatched since $since, as JSON
  "$GH" run list -R "$1" -w fenvix-first-test.yml -e workflow_dispatch -L 20 --json databaseId,status,conclusion,createdAt \
    | jq --arg s "$since" '[.[] | select(.createdAt >= $s)]'
}
deadline=$(( $(date +%s) + 40 * 60 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  a="$(runs "$repo_a")"; b="$(runs "$repo_b")"
  done_n=$(jq -s '[.[][] | select(.status == "completed")] | length' <<<"$a$b")
  [ "$(jq length <<<"$a")" -ge 2 ] && [ "$(jq length <<<"$b")" -ge 1 ] && [ "$done_n" -ge 3 ] && break
  log "   $done_n of 3 completed"
  sleep "$POLL"
done

log "5. results"
report="fenvix-first-test-$(date -u +%Y%m%dT%H%MZ).md"
{
  echo "# fenvix first real test on phoenixNAP, $(date -u +%Y-%m-%dT%H:%MZ)"
  echo
  echo "Region $region, host $host, ready $(( t_ready - t_order )) s after the order."
  echo
  echo "| repository | run | conclusion | probes | cache organization | job id | queued -> leased | leased -> microVM up | microVM lifetime |"
  echo "|---|---|---|---|---|---|---|---|---|"
} >"$report"
status="$(invoke '{"action":"status"}')"
fail=0
for r in "$repo_a" "$repo_b"; do
  for id in $(runs "$r" | jq -r '.[].databaseId'); do
    concl="$("$GH" run view "$id" -R "$r" --json conclusion -q .conclusion)"
    logtext="$("$GH" run view "$id" -R "$r" --log 2>/dev/null || true)"
    probes="$(grep -o 'FENVIX-PROBE .*' <<<"$logtext" || true)"
    np=$(grep -c ' PASS$' <<<"$probes" || true); nf=$(grep -c ' FAIL$' <<<"$probes" || true)
    org="$(grep -o 'FENVIX-INFO cache organization [^ ]*' <<<"$logtext" | awk '{print $4}' | head -1)"
    job="$("$GH" run view "$id" -R "$r" --json jobs -q '.jobs[0].databaseId')"
    t="$(jq -c --argjson j "${job:-0}" '.jobs[] | select(.job_id == $j)' <<<"$status")"
    q2l="$(jq -r 'if .leased_at then (((.leased_at | sub("\\.[0-9]+"; "") | fromdateiso8601) - (.queued_at | sub("\\.[0-9]+"; "") | fromdateiso8601)) | tostring) + " s" else "-" end' <<<"${t:-{\}}" 2>/dev/null || echo -)"
    up="$(jq -r 'if .timings.prepared and .timings.start then ((.timings.prepared - .timings.start) * 10 | round / 10 | tostring) + " s" else "-" end' <<<"${t:-{\}}" 2>/dev/null || echo -)"
    life="$(jq -r 'if .timings.vm_exit and .timings.prepared then ((.timings.vm_exit - .timings.prepared) | round | tostring) + " s" else "-" end' <<<"${t:-{\}}" 2>/dev/null || echo -)"
    echo "| $r | $id | $concl | $np pass, $nf fail | ${org:--} | ${job:--} | $q2l | $up | $life |" >>"$report"
    { echo; echo "<details><summary>$r run $id probes</summary>"; echo; echo '```'; echo "$probes"; grep -o 'FENVIX-INFO .*' <<<"$logtext" || true; echo '```'; echo "</details>"; } >>"$report.details"
    [ "$concl" = success ] && [ "$nf" = 0 ] && [ "$np" -gt 0 ] || fail=1
  done
done
orgs="$(grep -o '| gh-[0-9]* |' "$report" | sort -u | wc -l)"
[ "$orgs" -ge 2 ] || { fail=1; echo "- FAIL: the two organizations' jobs did not get two distinct cache organizations" >>"$report"; }
cat "$report.details" >>"$report" 2>/dev/null || true
release
{ echo; echo "Host released: $( [ "$(live_hosts | jq length)" = 0 ] && echo yes || echo NO, check the BMC portal)."; echo; echo "Result: $( [ "$fail" = 0 ] && echo PASS || echo FAIL)"; } >>"$report"
log "report: $report"
cat "$report"
[ "$fail" = 0 ]
