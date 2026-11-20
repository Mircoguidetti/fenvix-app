#!/usr/bin/env bash
# ok and bad always succeed, so "check && ok || bad" is a plain if-else here.
# shellcheck disable=SC2015
# The isolation test of our machines, on THIS host, as root (the CI runner uses sudo). It runs the real fenvix-slot
# and fenvix-imds-block with a stand-in GitHub runner (probe-runner.sh) and checks, with real processes, mounts and
# packets:
#   I1  a job of a later lease (customer B's, the worst case) finds NOTHING a wiped earlier job (customer A's) left:
#       no file in its home, /tmp, /var/tmp, /dev/shm, no process, no System V shared memory;
#   I2  two concurrent slots: neither sees the other's files, processes or runner configuration (jitconfig);
#   I3  no uid but root reaches the instance metadata service (a stand-in on 169.254.169.254:80);
#   I4  a slot cannot read the agent's state or the machine's settings (they hold every lease's credentials);
#   I5  root reads a slot's output only as the slot user: a symlink planted by the job to a root-only file gives nothing.
# Prints one line per check: "ok I1 ..." or "FAIL I1 ...", and exits non-zero if any failed.
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "isolation.sh must run as root"; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
files="$(cd "$here/../../lib/runner/files" && pwd)"
# Not under /tmp: a slot mounts its own private /tmp over the host's.
mkdir -p /srv; work="$(mktemp -d /srv/fenvix-iso.XXXXXX)"; chmod 0755 "$work"
command -v ip >/dev/null || { echo "isolation.sh needs ip (iproute2)"; exit 2; }
fails=0
ok() { echo "ok $*"; }
# A check whose job wrote nothing proves nothing: it fails.
ran() { [ -s "$work/out/$1" ] || { bad "$2: the job in the slot did not run (no output)"; return 1; }; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }
# shellcheck disable=SC2317 # called by the EXIT trap
cleanup() {
  for n in 1 2; do FENVIX_SLOT_BASE="$work/slot" "$files/fenvix-slot" wipe "$n" >/dev/null 2>&1 || true; done
  [ -n "${imds_pid:-}" ] && kill "$imds_pid" 2>/dev/null
  ip addr del 169.254.169.254/32 dev lo 2>/dev/null || true
  iptables -D OUTPUT -d 169.254.169.254 -m owner ! --uid-owner 0 -j REJECT 2>/dev/null || true
  ip6tables -D OUTPUT -d fd00:ec2::254 -m owner ! --uid-owner 0 -j REJECT 2>/dev/null || true
  rm -rf "$work" /var/lib/fenvix-agent/iso-secret /etc/fenvix/iso-secret
}
trap cleanup EXIT

for n in 1 2; do
  id "fenvix-s$n" >/dev/null 2>&1 || useradd --system --uid $((20000 + n)) --user-group --no-create-home --shell /usr/sbin/nologin "fenvix-s$n"
done
# The runner template: a stand-in for GitHub's run.sh that does what its --jitconfig word says.
mkdir -p "$work/template"; cp "$here/probe-runner.sh" "$work/template/run.sh"; chmod 0755 "$work/template/run.sh" "$work/template"
export FENVIX_SLOT_BASE="$work/slot" FENVIX_RUNNER_TEMPLATE="$work/template"
mkdir -p "$work/out"; chmod 0777 "$work/out"
leasefile() { printf '{"kind":"job","jitConfig":"%s","env":{"FENVIX_MODE":"enforce","PROBE_OUT":"%s"}}' "$1" "$work/out/$2" >"$work/lease-$2.json"; echo "$work/lease-$2.json"; }
slot() { "$files/fenvix-slot" "$@"; }

# ---- I1: customer A's job leaves traces everywhere it can; the slot is wiped; customer B's job looks for them.
slot prepare 1 "$(leasefile plant a)" && slot run 1 >/dev/null 2>&1
grep -q planted "$work/out/a" || bad "I1 setup: the planting job did not run ($(cat "$work/out/a" 2>/dev/null))"
pgrep -u 20001 >/dev/null && echo "  (a process of slot 1 is still alive before the wipe, as planned)"
slot wipe 1
pgrep -u 20001 >/dev/null && bad "I1 a process of the wiped slot is still alive" || ok "I1 no process of the wiped job survives"
ipcs -m | awk '{print $3}' | grep -qx fenvix-s1 && bad "I1 shared memory of the wiped job survives" || ok "I1 no System V shared memory survives"
slot prepare 1 "$(leasefile probe b)" && slot run 1 >/dev/null 2>&1
ran b I1 && if grep -q '^FOUND' "$work/out/b"; then bad "I1 the next job found: $(grep '^FOUND' "$work/out/b" | tr '\n' ' ')"; else ok "I1 the next job finds no file, process or memory of the earlier one ($(grep -c '^checked' "$work/out/b") places checked)"; fi
slot wipe 1

# ---- I2: two slots at once.
slot prepare 1 "$(leasefile hold c)"; slot prepare 2 "$(leasefile peek d)"
( slot run 1 >/dev/null 2>&1 & echo $! >"$work/hold.pid" )
for _ in $(seq 1 50); do grep -q holding "$work/out/c" 2>/dev/null && break; sleep 0.1; done
slot run 2 >/dev/null 2>&1
ran d I2 && if grep -q '^FOUND' "$work/out/d"; then bad "I2 slot 2 saw slot 1: $(grep '^FOUND' "$work/out/d" | tr '\n' ' ')"; else ok "I2 slot 2 sees none of slot 1's files, processes or jitconfig ($(grep -c '^checked' "$work/out/d") places checked)"; fi
grep -q '^pids ' "$work/out/d" && ok "I2 slot 2 sees only its own processes ($(grep '^pids ' "$work/out/d"))"
slot wipe 1; slot wipe 2

# ---- I3: the metadata service, root only.
ip addr add 169.254.169.254/32 dev lo
python3 -I -c '
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self): self.send_response(200); self.end_headers(); self.wfile.write(b"iam-credentials")
    do_PUT = do_GET
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
socketserver.TCPServer(("169.254.169.254", 80), H).serve_forever()' &
imds_pid=$!
for _ in $(seq 1 30); do curl -s -m 1 http://169.254.169.254/ >/dev/null && break; sleep 0.1; done
bash "$files/fenvix-imds-block"
[ "$(curl -s -m 2 http://169.254.169.254/latest/meta-data/)" = iam-credentials ] && ok "I3 root reaches the metadata service (the agent needs its user data)" || bad "I3 root cannot reach the stand-in metadata service"
for u in fenvix-s1 fenvix-s2 nobody; do
  if setpriv --reuid "$(id -u "$u")" --regid "$(id -g "$u")" --clear-groups -- curl -s -m 2 http://169.254.169.254/latest/meta-data/ >/dev/null 2>&1; then
    bad "I3 $u reaches the metadata service"
  else ok "I3 $u is refused the metadata service"; fi
done
slot prepare 1 "$(leasefile imds e)" && slot run 1 >/dev/null 2>&1
ran e I3 && grep -q '^imds refused' "$work/out/e" && ok "I3 a job inside its slot is refused the metadata service" || bad "I3 a job reached it: $(cat "$work/out/e")"
slot wipe 1

# ---- I4: the agent's state and the machine's settings are not visible to a job.
mkdir -p /var/lib/fenvix-agent /etc/fenvix; chmod 0700 /var/lib/fenvix-agent
echo lease-credentials >/var/lib/fenvix-agent/iso-secret; echo boot-secret >/etc/fenvix/iso-secret
slot prepare 1 "$(leasefile secrets f)" && slot run 1 >/dev/null 2>&1
ran f I4 && if grep -q '^FOUND' "$work/out/f"; then bad "I4 $(grep '^FOUND' "$work/out/f" | tr '\n' ' ')"; else ok "I4 a job reads neither the agent's state nor the machine's settings"; fi

# ---- I5: a symlink planted by the job, read back by root through fenvix-slot read.
echo root-only-secret >"$work/root-secret"; chmod 0600 "$work/root-secret"
setpriv --reuid 20001 --regid 20001 --clear-groups -- ln -sf "$work/root-secret" "$work/slot/1/fenvix-out/summary.json"
got="$(slot read 1 fenvix-out/summary.json 2>/dev/null || true)"
[ -z "$got" ] && ok "I5 root reads a slot's file as the slot user: a planted symlink to a root-only file gives nothing" || bad "I5 read through the symlink: $got"
slot wipe 1

echo "isolation: $fails failed"
exit $((fails > 0))
