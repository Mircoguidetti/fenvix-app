#!/bin/bash
# certbot --manual hook (DNS-01): `present` writes the TXT record of $CERTBOT_DOMAIN in the stack's Route 53 zone and
# waits until Route 53 serves it; `cleanup` removes it. Only the records listed in ACME_RECORDS (/etc/fenvix/tls.env)
# are touched, and the instance role allows those names, type TXT, in that zone only. Every name gets one value, so
# UPSERT is enough (no name of ours carries two challenges at once).
set -euo pipefail
set -f
. "${FENVIX_TLS_CONF:-/etc/fenvix/tls.env}"
name=""
for r in $ACME_RECORDS; do
  if [ "${r%%=*}" = "${CERTBOT_DOMAIN:-}" ]; then name="${r#*=}"; fi
done
[ -n "$name" ] || { echo "fenvix-acme-dns-hook: no challenge record configured for '${CERTBOT_DOMAIN:-}'" >&2; exit 1; }
[[ "${CERTBOT_VALIDATION:-}" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "fenvix-acme-dns-hook: unexpected validation value" >&2; exit 1; }
case "${1:-}" in
  present) action=UPSERT ;;
  cleanup) action=DELETE ;;
  *) echo "fenvix-acme-dns-hook: usage: present|cleanup" >&2; exit 2 ;;
esac
batch="$(mktemp)"
trap 'rm -f "$batch"' EXIT
printf '{"Changes":[{"Action":"%s","ResourceRecordSet":{"Name":"%s","Type":"TXT","TTL":60,"ResourceRecords":[{"Value":"\\"%s\\""}]}}]}\n' \
  "$action" "$name" "$CERTBOT_VALIDATION" > "$batch"
if ! id="$(aws route53 change-resource-record-sets --hosted-zone-id "$ACME_ZONE_ID" --change-batch "file://$batch" --query ChangeInfo.Id --output text)"; then
  if [ "$action" = DELETE ]; then
    echo "fenvix-acme-dns-hook: could not remove the TXT record $name (harmless, it is replaced next time)" >&2
    exit 0
  fi
  exit 1
fi
if [ "$action" = DELETE ]; then exit 0; fi
aws route53 wait resource-record-sets-changed --id "$id"
echo "fenvix-acme-dns-hook: TXT $name published"
