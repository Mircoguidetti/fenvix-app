#!/usr/bin/env bash
# Prints the DNS records to add in Cloudflare (zone fenvix.dev) for the GitHub App's host, read from AWS:
#   1. the ACM certificate's validation CNAME (while the certificate waits for it; it must stay afterwards: renewals);
#   2. the host itself: CNAME github -> the API Gateway regional domain (after the deploy).
# Both "DNS only" (grey cloud): API Gateway serves its own certificate.
#   bash scripts/dns-records.sh            # once
#   bash scripts/dns-records.sh --wait     # waits until the certificate exists, prints its record, returns
set -euo pipefail
REGION="${FENVIX_REGION:-eu-west-1}"
ENVNAME="${FENVIX_ENV:-prod}"
DOMAIN="${FENVIX_GITHUB_APP_DOMAIN:-github.fenvix.dev}"
ZONE="${FENVIX_CLOUDFLARE_ZONE:-fenvix.dev}"
STACK="fenvix-$ENVNAME-github-app"
export AWS_DEFAULT_REGION="$REGION"

# Cloudflare's "Name" field is relative to the zone: _abc.github.fenvix.dev. -> _abc.github
relative() { local n="${1%.}"; [ "$n" = "$ZONE" ] && echo "@" || echo "${n%."$ZONE"}"; }

print_validation() {
  local arn rec name type value status
  arn="$(aws acm list-certificates --certificate-statuses PENDING_VALIDATION ISSUED \
        --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text 2>/dev/null || true)"
  [ -n "$arn" ] && [ "$arn" != "None" ] || return 1
  rec="$(aws acm describe-certificate --certificate-arn "$arn" \
        --query 'Certificate.[Status, DomainValidationOptions[0].ResourceRecord.Name, DomainValidationOptions[0].ResourceRecord.Type, DomainValidationOptions[0].ResourceRecord.Value]' --output text)"
  read -r status name type value <<<"$rec"
  [ -n "${name:-}" ] && [ "$name" != "None" ] || return 1
  echo
  echo "Cloudflare record 1 of 2: certificate validation (certificate status: $status)"
  echo "  Type:    $type"
  echo "  Name:    $(relative "$name")        (full name: ${name%.})"
  echo "  Target:  ${value%.}"
  echo "  Proxy:   DNS only (grey cloud)    TTL: Auto"
  echo "  Keep it after the certificate is issued: ACM renews the certificate through the same record."
  return 0
}

print_host() {
  local target
  target="$(aws cloudformation describe-stacks --stack-name "$STACK" \
            --query "Stacks[0].Outputs[?OutputKey=='DnsTarget'].OutputValue | [0]" --output text 2>/dev/null || true)"
  if [ -z "$target" ] || [ "$target" = "None" ]; then
    echo; echo "Cloudflare record 2 of 2: after the deploy finishes (run this script again)."; return 1
  fi
  echo
  echo "Cloudflare record 2 of 2: the App's host"
  echo "  Type:    CNAME"
  echo "  Name:    $(relative "$DOMAIN")        (full name: $DOMAIN)"
  echo "  Target:  $target"
  echo "  Proxy:   DNS only (grey cloud)    TTL: Auto"
}

if [ "${1:-}" = "--wait" ]; then
  for _ in $(seq 1 120); do print_validation && exit 0; sleep 10; done
  echo "No certificate for $DOMAIN appeared in ACM ($REGION) within 20 minutes." >&2; exit 1
fi
print_validation || echo "No certificate for $DOMAIN in ACM ($REGION) yet: it is created by the deploy."
print_host || true
