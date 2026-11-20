#!/usr/bin/env bash
# The stubs and the inner bash expand their own variables (single quotes on purpose).
# shellcheck disable=SC2016
# The image install (lib/runner/files/install.sh) against stand-ins for the network and the system tools, as root in a
# private mount namespace (/opt/fenvix, /srv, /etc/sysctl.d are tmpfs: the host is not touched). Cases:
#   ok        the pinned engine and runner: installed, /opt/fenvix/ENGINE names the version and sha256
#   nopin     no engine pin: the install stops, nothing installed
#   badsum    an engine whose sha256 is not the pin: stops, nothing installed
#   badlayout an archive with a path outside its one top directory: stops
#   badrunner a GitHub runner whose sha256 is not the pin: stops
# Prints "ok <case>" or "FAIL <case>: ...".
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "image-install.sh must run as root"; exit 2; }
here="$(cd "$(dirname "$0")" && pwd)"
install_sh="$(cd "$here/../../lib/runner/files" && pwd)/install.sh"
work="$(mktemp -d /var/tmp/fenvix-img.XXXXXX)"; trap 'rm -rf "$work"' EXIT
fails=0
mkdir -p "$work/stubs" "$work/assets"
for c in apt-get useradd systemctl sysctl; do printf '#!/bin/sh\nexit 0\n' >"$work/stubs/$c"; chmod +x "$work/stubs/$c"; done
# curl: serves the assets by the URL's file name (the test's "network").
cat >"$work/stubs/curl" <<STUB
#!/usr/bin/env bash
out=""; url=""
while [ \$# -gt 0 ]; do case "\$1" in -o) out="\$2"; shift 2 ;; -*) [ "\$1" = --proto ] || [ "\$1" = --retry ] && shift; shift ;; *) url="\$1"; shift ;; esac; done
f="$work/assets/\$(basename "\$url")"
[ -f "\$f" ] || exit 22
cp "\$f" "\$out"
STUB
chmod +x "$work/stubs/curl"
# A GitHub runner archive and an engine artifact (its install.sh only records that it ran).
mkdir -p "$work/r" && printf '#!/bin/sh\n' >"$work/r/run.sh" && chmod +x "$work/r/run.sh"
tar -czf "$work/assets/actions-runner-linux-x64-9.9.9.tar.gz" -C "$work/r" .
v="0.4.0-r17.abc1234"
mkdir -p "$work/e/fenvix-engine-$v"
printf '#!/bin/sh\nmkdir -p "$1/bin" && echo installed >"$1/engine-installed"\n' >"$work/e/fenvix-engine-$v/install.sh"
tar -czf "$work/assets/fenvix-engine-$v-linux-x86_64.tar.gz" -C "$work/e" "fenvix-engine-$v"
mkdir -p "$work/evil/fenvix-engine-$v" && echo x >"$work/evil/escape"
tar -czf "$work/assets/evil.tar.gz" -C "$work/evil" "fenvix-engine-$v" escape
rsha="$(sha256sum "$work/assets/actions-runner-linux-x64-9.9.9.tar.gz" | cut -d' ' -f1)"
esha="$(sha256sum "$work/assets/fenvix-engine-$v-linux-x86_64.tar.gz" | cut -d' ' -f1)"
url="https://github.com/Mircoguidetti/fenvix-engine-cli/releases/download/engine-$v/fenvix-engine-$v-linux-x86_64.tar.gz"

run() { # run CASE ENGINE_URL ENGINE_SHA RUNNER_SHA ENGINE_VERSION -> exit code; ENGINE file printed
  printf 'FENVIX_RUNNER_VERSION=9.9.9\nFENVIX_RUNNER_SHA256=%s\nFENVIX_ENGINE_VERSION=%s\nFENVIX_ENGINE_URL=%s\nFENVIX_ENGINE_SHA256=%s\n' "$4" "$5" "$2" "$3" >"$work/env-$1"
  unshare --mount --propagation private -- bash -c '
    for d in /opt/fenvix /srv /etc/sysctl.d /var/log; do mkdir -p "$d"; mount -t tmpfs tmpfs "$d"; done
    PATH="$1:$PATH" FENVIX_IMAGE_ENV="$2" bash "$3" >"$4/log-$5" 2>&1; rc=$?
    cat /opt/fenvix/ENGINE 2>/dev/null >"$4/engine-$5"; ls /opt/fenvix >"$4/ls-$5" 2>/dev/null; exit $rc' _ "$work/stubs" "$work/env-$1" "$install_sh" "$work" "$1"
}
check_stop() { # CASE PATTERN
  if [ "$2" -eq 0 ]; then echo "FAIL $1: the install went on"; fails=$((fails + 1));
  elif ! grep -q "$3" "$work/log-$1"; then echo "FAIL $1: stopped without saying why: $(tail -2 "$work/log-$1")"; fails=$((fails + 1));
  elif grep -q engine-installed "$work/ls-$1" || [ -s "$work/engine-$1" ]; then echo "FAIL $1: an engine was installed"; fails=$((fails + 1));
  else echo "ok $1 ($(grep -o 'STOP: .*' "$work/log-$1" | head -1))"; fi
}
run ok "$url" "$esha" "$rsha" "$v"; rc=$?
if [ $rc -eq 0 ] && [ "$(cat "$work/engine-ok")" = "$v sha256=$esha" ] && grep -q engine-installed "$work/ls-ok"; then echo "ok ok (ENGINE: $(cat "$work/engine-ok"))"
else echo "FAIL ok: rc $rc, ENGINE '$(cat "$work/engine-ok" 2>/dev/null)': $(tail -3 "$work/log-ok")"; fails=$((fails + 1)); fi
run nopin "" "" "$rsha" ""; check_stop nopin $? "no engine pinned"
run badsum "$url" "$(printf 'a%.0s' $(seq 1 64))" "$rsha" "$v"; check_stop badsum $? "checksum mismatch"
cp "$work/assets/evil.tar.gz" "$work/assets/fenvix-engine-$v-linux-x86_64.tar.gz"
run badlayout "$url" "$(sha256sum "$work/assets/evil.tar.gz" | cut -d' ' -f1)" "$rsha" "$v"; check_stop badlayout $? "unexpected engine archive layout"
run badrunner "$url" "$esha" "$(printf 'b%.0s' $(seq 1 64))" "$v"; check_stop badrunner $? "runner's sha256 is not the pinned one"
echo "image-install: $fails failed"
exit $((fails > 0))
