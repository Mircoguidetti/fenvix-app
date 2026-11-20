#!/usr/bin/env bash
# A stand-in for GitHub's runner inside a slot (test only): `run.sh --jitconfig WORD` does what WORD says and writes
# its findings to $PROBE_OUT (the test's world-writable output directory, given in the job settings).
set -u
word="${2:-}"
out="$(grep '^PROBE_OUT=' "$HOME/runner/.env" | cut -d= -f2-)"
say() { echo "$*" >>"$out"; }
look() { # look PATH...: FOUND if any exists or is readable
  for p in "$@"; do
    say "checked $p"
    if [ -e "$p" ] || [ -L "$p" ]; then say "FOUND $p"; fi
  done
}
case "$word" in
  plant)
    echo secret-a >"$HOME/a-secret"; echo secret-a >/tmp/a-secret; echo secret-a >/var/tmp/a-secret; echo secret-a >/dev/shm/a-secret
    python3 -c 'import sysv_ipc' 2>/dev/null || true
    (setsid sleep 300 >/dev/null 2>&1 &)
    say planted ;;
  probe)
    look "$HOME/a-secret" /tmp/a-secret /var/tmp/a-secret /dev/shm/a-secret
    for p in /proc/[0-9]*; do u="$(stat -c %u "$p" 2>/dev/null)"; [ "$u" = 20001 ] && [ "${p#/proc/}" != "$$" ] && ! grep -q "probe" "$p/cmdline" 2>/dev/null && say "checked process $p" ; done
    if pgrep -u 20001 -x sleep >/dev/null 2>&1; then say "FOUND an earlier job's process"; else say "checked processes"; fi ;;
  hold)
    echo secret-c >"$HOME/c-secret"; echo secret-c >/tmp/c-secret
    say holding
    sleep 3 ;;
  peek)
    look "$(dirname "$HOME")/1/c-secret" "$(dirname "$HOME")/1/.fenvix/jitconfig" "$(dirname "$HOME")/1" /tmp/c-secret
    say "checked processes"
    if ps -eo user,args 2>/dev/null | grep -v grep | grep -q "sleep 3"; then say "FOUND slot 1's process"; fi
    say "pids $(ps -e --no-headers | wc -l)" ;;
  imds)
    if curl -s -m 2 http://169.254.169.254/latest/meta-data/ >/dev/null 2>&1; then say "imds REACHED"; else say "imds refused"; fi ;;
  secrets)
    look /var/lib/fenvix-agent/iso-secret /etc/fenvix/iso-secret ;;
esac
exit 0
