#!/usr/bin/env bash
# Inside a fenvix job (a microVM): what it must reach and what it must not. One line per check:
#   FENVIX-PROBE <name> <expected ok|blocked> <got ok|blocked> <PASS|FAIL>
# Exit 1 if any check fails. Used by fenvix-first-test.yml (docs/CUSTOMER-MODE-PNAP.md, the first real test).
set -uo pipefail
fails=0
tcp() { timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null && echo ok || echo blocked; }
check() { # name expected got
  local r=PASS; [ "$2" = "$3" ] || { r=FAIL; fails=$((fails + 1)); }
  echo "FENVIX-PROBE $1 $2 $3 $r"
}
http() { # url [token] -> HTTP status, or 000
  if [ -n "${2:-}" ]; then curl -s -o /dev/null -m 6 -w '%{http_code}' -H "authorization: Bearer $2" "$1"
  else curl -s -o /dev/null -m 6 -w '%{http_code}' "$1"; fi
}

# The internet (packages, git) works; GitHub too.
check internet_https ok "$([ "$(http https://github.com)" != 000 ] && echo ok || echo blocked)"
# Metadata and link-local, the slot's own namespace, the host, other microVMs, private networks: none.
check metadata_169.254.169.254 blocked "$(tcp 169.254.169.254 80)"
check slot_gateway_172.16.0.1 blocked "$(tcp 172.16.0.1 22)"
for a in 10.200.0.1 10.200.0.5 10.200.0.9; do check "host_link_$a" blocked "$(tcp $a 22)"; done
for a in 10.200.0.2 10.200.0.6 10.200.0.10; do check "other_microvm_$a" blocked "$(tcp $a 22)"; done
for a in 10.0.0.1 10.0.0.2 10.0.0.11 192.168.0.1; do check "private_$a" blocked "$(tcp $a 22)"; done
pub="$(curl -s -m 6 https://api.ipify.org || true)"
if [[ "$pub" =~ ^[0-9.]+$ ]]; then
  check host_public_ip_ssh blocked "$(tcp "$pub" 22)"
  echo "FENVIX-INFO host public address $pub (as the internet sees this job)"
fi
# IPv6: no global address, and nothing answers on the link.
check ipv6_global_address none "$(ip -6 addr show scope global 2>/dev/null | grep -q inet6 && echo some || echo none)"
# The region's shared cache: this job's own customer organization only.
envf="$HOME/fenvix/actions-runner/.env"
url="$(grep -E '^FENVIX_CACHE_URL=' "$envf" 2>/dev/null | cut -d= -f2- || true)"
tok="$(cat "$HOME/.fenvix/cache-token" 2>/dev/null || true)"
if [ -n "$url" ] && [ -n "$tok" ]; then
  base="${url%/gh-*}"
  check cache_own_token ok "$([ "$(http "$base/v1/stats" "$tok")" = 200 ] && echo ok || echo blocked)"
  # The same token with another organization in its payload (the signature no longer matches).
  forged="$(python3 -c '
import base64, json, sys
t = sys.argv[1].split(".")
p = json.loads(base64.urlsafe_b64decode(t[1] + "=" * (-len(t[1]) % 4)))
p["org"] = "gh-1"
t[1] = base64.urlsafe_b64encode(json.dumps(p).encode()).decode().rstrip("=")
print(".".join(t))' "$tok")"
  check cache_other_org_forged blocked "$([ "$(http "$base/v1/stats" "$forged")" = 200 ] && echo ok || echo blocked)"
  check cache_no_token blocked "$([ "$(http "$base/v1/stats")" = 200 ] && echo ok || echo blocked)"
  check cache_other_port blocked "$(tcp "$(echo "$base" | sed -E 's#http://([^:/]+).*#\1#')" 22)"
  echo "FENVIX-INFO cache organization $(grep -E '^FENVIX_CACHE_ORG=' "$envf" | cut -d= -f2-) access $(grep -E '^FENVIX_CACHE_ACCESS=' "$envf" | cut -d= -f2-)"
else
  echo "FENVIX-INFO no shared cache configured for this job"
fi
# Docker inside the microVM.
check docker_hello_world ok "$(timeout 120 docker run --rm hello-world >/dev/null 2>&1 && echo ok || echo blocked)"
# What the job's machine is.
echo "FENVIX-INFO cpus $(nproc) memory_mib $(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024 )) kernel $(uname -r)"
echo "FENVIX-TIME probes_done $(date +%s.%N)"
echo "FENVIX-PROBES failed=$fails"
[ "$fails" = 0 ]
