#!/bin/bash
# fenvix-tls: makes sure /etc/fenvix/tls holds a valid Let's Encrypt certificate for the names in /etc/fenvix/tls.env,
# in the files the engine (engine.pem: chain + key) and the TLS terminator (fullchain.pem, key.pem) load.
#   1. installed certificate valid for 30 days more, right names, right ACME server: nothing to do (no network);
#   2. else the copy kept in Secrets Manager, if it passes the same test (a replaced server does not request again);
#   3. else a new certificate from Let's Encrypt (certbot, DNS-01 in Route 53), then kept in Secrets Manager.
# Run before the engine and the terminator start (they do not start if it fails) and twice a day by fenvix-tls.timer
# with --restart-on-change: the engine and the terminator are restarted only when the certificate changed.
# Never prints a key or the content of the secret.
set -euo pipefail
umask 077
CONF="${FENVIX_TLS_CONF:-/etc/fenvix/tls.env}"
TLS="${FENVIX_TLS_DIR:-/etc/fenvix/tls}"
STATE="${FENVIX_ACME_STATE:-/var/lib/fenvix-acme}"
OWNER="${FENVIX_TLS_OWNER:-fenvix}"
CERTBOT="${FENVIX_CERTBOT:-/opt/fenvix/certbot/bin/certbot}"
HOOK="${FENVIX_ACME_HOOK:-/usr/local/bin/fenvix-acme-dns-hook}"
RENEW_BEFORE=2592000 # 30 days
RETRY_AFTER=1200     # 20 minutes between attempts: Let's Encrypt allows 5 failed validations per name per hour
. "$CONF"
say() { echo "fenvix-tls: $*"; }
die() { echo "fenvix-tls: $*" >&2; exit 1; }
restart=no
if [ "${1:-}" = "--restart-on-change" ]; then restart=yes; fi

install -d -m 0700 "$STATE"
install -d -m 0700 -o "$OWNER" -g "$OWNER" "$TLS"
exec 9>"$STATE/lock"
flock 9 # the engine and the terminator may run this at the same moment
w="$(mktemp -d "${TMPDIR:-/run}/fenvix-tls.XXXXXX")"
trap 'rm -rf "$w"' EXIT

read -ra DOMAINS <<< "$ACME_DOMAINS"
want="$(printf '%s\n' "${DOMAINS[@]}" | sort | tr '\n' ' ')"
end() { openssl x509 -in "$1/fullchain.pem" -noout -enddate | cut -d= -f2; }
fp() { openssl x509 -in "$1/fullchain.pem" -noout -fingerprint -sha256 | cut -d= -f2; }

# usable <dir> <seconds it must still be valid>: fullchain.pem, key.pem and server in <dir> make a certificate we can serve.
usable() {
  local d="$1" have
  [ -s "$d/fullchain.pem" ] && [ -s "$d/key.pem" ] && [ -s "$d/server" ] || return 1
  [ "$(cat "$d/server")" = "$ACME_SERVER" ] || return 1
  openssl x509 -in "$d/fullchain.pem" -noout -checkend "$2" > /dev/null 2>&1 || return 1
  have="$(openssl x509 -in "$d/fullchain.pem" -noout -ext subjectAltName 2> /dev/null | tr ',' '\n' | sed -n 's/^ *DNS://p' | sort | tr '\n' ' ')"
  [ "$have" = "$want" ] || return 1
  [ "$(openssl x509 -in "$d/fullchain.pem" -noout -pubkey | openssl sha256)" = "$(openssl pkey -in "$d/key.pem" -pubout 2> /dev/null | openssl sha256)" ] || return 1
  case "$ACME_SERVER" in
    *staging*) ;;
    *) if openssl x509 -in "$d/fullchain.pem" -noout -issuer | grep -q STAGING; then return 1; fi ;;
  esac
}

# Something failed: serve on with the installed certificate while it has not expired, else stop the service from starting.
fallback() {
  if usable "$TLS" 0; then
    echo "fenvix-tls: WARNING: $1; keeping the installed certificate (valid until $(end "$TLS"))" >&2
    exit 0
  fi
  die "$1; no valid certificate installed, the services that need TLS do not start"
}

# read_stored <dir>: 0 = a copy was written to <dir>; 1 = nothing usable kept yet; 2 = Secrets Manager could not be read.
read_stored() {
  if ! aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$TLS_SECRET_ID" --query SecretString --output text > "$w/stored.json" 2> "$w/err"; then
    echo "fenvix-tls: cannot read $TLS_SECRET_ID: $(head -c 300 "$w/err")" >&2
    return 2
  fi
  python3 -I - "$w/stored.json" "$1" << 'PY'
import json, os, sys
try:
    d = json.load(open(sys.argv[1]))
    parts = {"fullchain.pem": d["fullchain"], "key.pem": d["key"], "server": d["server"]}
except Exception:
    sys.exit(1)
os.makedirs(sys.argv[2], mode=0o700, exist_ok=True)
for name, value in parts.items():
    with open(os.path.join(sys.argv[2], name), "w") as f:
        f.write(value)
PY
}

store() {
  python3 -I -c 'import json, sys; json.dump({"server": open(sys.argv[1]).read(), "fullchain": open(sys.argv[2]).read(), "key": open(sys.argv[3]).read()}, open(sys.argv[4], "w"))' \
    "$1/server" "$1/fullchain.pem" "$1/key.pem" "$w/secret.json"
  aws secretsmanager put-secret-value --region "$AWS_REGION" --secret-id "$TLS_SECRET_ID" --secret-string "file://$w/secret.json" > /dev/null 2> "$w/err"
}

issue() {
  local args=()
  for d in "${DOMAINS[@]}"; do args+=(-d "$d"); done
  touch "$STATE/attempt" # stays if the attempt fails or is killed: the next one waits RETRY_AFTER
  if ! "$CERTBOT" certonly --non-interactive --agree-tos --no-eff-email -m "$ACME_EMAIL" --server "$ACME_SERVER" \
    --config-dir "$STATE/certbot" --work-dir "$STATE/work" --logs-dir "$STATE/logs" \
    --cert-name fenvix --key-type rsa --rsa-key-size 2048 --force-renewal \
    --manual --preferred-challenges dns --manual-auth-hook "$HOOK present" --manual-cleanup-hook "$HOOK cleanup" \
    "${args[@]}" > "$w/certbot.out" 2>&1; then
    grep -v -e '-----' "$w/certbot.out" | tail -n 15 >&2
    return 1
  fi
  mkdir -p "$w/new"
  cp "$STATE/certbot/live/fenvix/fullchain.pem" "$w/new/fullchain.pem"
  cp "$STATE/certbot/live/fenvix/privkey.pem" "$w/new/key.pem"
  printf '%s' "$ACME_SERVER" > "$w/new/server"
  rm -f "$STATE/attempt"
}

install_cert() {
  openssl pkey -in "$1/key.pem" -out "$w/key.pkcs8" # PKCS#8, as the engine loads it
  cat "$1/fullchain.pem" "$w/key.pkcs8" > "$w/engine.pem"
  install -m 0600 -o "$OWNER" -g "$OWNER" "$1/fullchain.pem" "$TLS/fullchain.pem.new"
  install -m 0600 -o "$OWNER" -g "$OWNER" "$w/key.pkcs8" "$TLS/key.pem.new"
  install -m 0600 -o "$OWNER" -g "$OWNER" "$w/engine.pem" "$TLS/engine.pem.new"
  install -m 0600 -o "$OWNER" -g "$OWNER" "$1/server" "$TLS/server.new"
  for f in fullchain.pem key.pem engine.pem server; do mv -f "$TLS/$f.new" "$TLS/$f"; done
}

old=none
if [ -s "$TLS/fullchain.pem" ]; then old="$(fp "$TLS")"; fi
if usable "$TLS" "$RENEW_BEFORE"; then
  if [ ! -s "$TLS/engine.pem" ]; then install_cert "$TLS"; fi
  say "certificate valid until $(end "$TLS"), nothing to do"
  exit 0
fi

src=""
rc=0
read_stored "$w/stored" || rc=$?
if [ "$rc" = 2 ]; then fallback "the stored certificate cannot be read"; fi
if [ "$rc" = 0 ] && usable "$w/stored" "$RENEW_BEFORE"; then
  src="$w/stored"
  say "using the certificate kept in Secrets Manager (valid until $(end "$src"))"
fi

if [ -z "$src" ]; then
  if [ -e "$STATE/attempt" ]; then
    age=$(($(date +%s) - $(stat -c %Y "$STATE/attempt")))
    if [ "$age" -lt "$RETRY_AFTER" ]; then
      fallback "the last certificate request failed ${age}s ago, next attempt in $((RETRY_AFTER - age))s"
    fi
  fi
  say "requesting a certificate for $ACME_DOMAINS from $ACME_SERVER"
  issue || fallback "the certificate request failed (certbot output above)"
  usable "$w/new" 86400 || fallback "the issued certificate does not cover $ACME_DOMAINS"
  if store "$w/new"; then
    say "certificate kept in Secrets Manager"
  else
    echo "fenvix-tls: WARNING: cannot keep the certificate in $TLS_SECRET_ID ($(head -c 300 "$w/err")); a replaced server will request a new one" >&2
  fi
  src="$w/new"
fi

install_cert "$src"
new="$(fp "$TLS")"
say "certificate installed ($old -> $new), valid until $(end "$TLS")"
exec 9>&- # release the lock: the restarted services run this script again
if [ "$restart" = yes ] && [ "$new" != "$old" ]; then
  systemctl try-restart $RESTART_UNITS
  say "restarted $RESTART_UNITS"
fi
