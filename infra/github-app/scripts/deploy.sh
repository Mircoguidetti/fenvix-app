#!/usr/bin/env bash
# The one deploy command (from infra/github-app):  npm run deploy      (add -- --yes to skip the confirmation)
#
# 1. checks: Node 22.18+, AWS CLI, the AWS account, the settings, the SSM parameters (names only, never values);
# 2. installs and tests the service (github-app: typecheck + unit tests) and this folder (template tests);
# 3. per-job mode: keeps the cache machine's AMI (first deploy: the current Ubuntu 24.04 arm64 one), so a deploy never
#    replaces it (runner machines start from the runner image, built by scripts/build-image.sh);
# 4. shows the change (cdk diff), asks, deploys; while CloudFormation waits for the certificate, prints the DNS
#    record to add in Cloudflare; at the end prints the host's record and the next steps (docs/DEPLOY-AWS.md).
set -euo pipefail
cd "$(dirname "$0")/.."
HERE="$PWD"
SERVICE="$HERE/../../github-app"
YES=0; [ "${1:-}" = "--yes" ] && YES=1

ctx() { node -e 'const c=require(process.argv[1]).context; process.stdout.write(String(c[process.argv[2]] ?? ""))' "$HERE/cdk.json" "$1"; }
REGION="${FENVIX_REGION:-$(ctx region)}"
ENVNAME="${FENVIX_ENV:-$(ctx env)}"
ACCOUNT="${FENVIX_ACCOUNT:-$(ctx account)}"
STACK="fenvix-$ENVNAME-github-app"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" FENVIX_REGION="$REGION" FENVIX_ENV="$ENVNAME"
say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }

say "1/5 checks"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' || die "Node.js 22.18 or newer is needed (node --version: $(node --version))"
command -v aws >/dev/null || die "AWS CLI v2 is needed"
who="$(aws sts get-caller-identity --query Account --output text)" || die "not signed in to AWS (aws configure sso / aws configure)"
[ "$who" = "$ACCOUNT" ] || die "signed in to account $who, cdk.json says $ACCOUNT"
missing=()
for p in database-url private-key webhook-secret client-secret state-signing-key runner-token api-database-url; do
  name="/fenvix/$ENVNAME/github-app/$p"
  n="$(aws ssm describe-parameters --parameter-filters "Key=Name,Values=$name" --query 'length(Parameters)' --output text)"
  [ "$n" = "1" ] || missing+=("$name")
done
[ ${#missing[@]} -eq 0 ] || die "create these SSM parameters first (docs/DEPLOY-AWS.md, step 6): ${missing[*]}"
echo "account $ACCOUNT, region $REGION, stack $STACK; SSM parameters present"

say "2/5 install and test"
(cd "$SERVICE" && npm ci --no-audit --no-fund && npm run typecheck && npm run test:unit)
npm ci --no-audit --no-fund
npm test

MODE="${FENVIX_RUNNER_MODE:-$(ctx runnerMode)}"
say "3/5 machine images (runnerMode $MODE)"
# Keeps the AMI a machine was started from, so a deploy never replaces it because Canonical published a new one.
keep_ami() { # $1 output name, $2 SSM parameter of the current Ubuntu 24.04 image
  local id
  id="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text 2>/dev/null || true)"
  if [ -z "$id" ] || [ "$id" = "None" ]; then id="$(aws ssm get-parameter --name "$2" --query Parameter.Value --output text)"; fi
  printf '%s' "$id"
}
if [ "$MODE" = "per-job" ]; then
  if [ -z "${FENVIX_CACHE_AMI_ID:-}" ] && [ -z "$(ctx cacheAmiId)" ]; then
    FENVIX_CACHE_AMI_ID="$(keep_ami CacheAmiId /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id)"
    export FENVIX_CACHE_AMI_ID
    echo "cache machine image: $FENVIX_CACHE_AMI_ID"
  fi
  [ -n "${FENVIX_CACHE_SIGNING_PUBLIC_KEY:-$(ctx cacheSigningPublicKey)}" ] || die "per-job mode needs the cache signing key: bash scripts/cache-key.sh, then put its line in cdk.json"
  n="$(aws ssm describe-parameters --parameter-filters "Key=Name,Values=/fenvix/$ENVNAME/cache/signing-key" --query 'length(Parameters)' --output text)"
  [ "$n" = "1" ] || die "per-job mode needs /fenvix/$ENVNAME/cache/signing-key: bash scripts/cache-key.sh"
fi

say "4/5 the change"
npx cdk diff "$STACK" || true
if [ $YES -ne 1 ]; then
  read -r -p "Deploy $STACK to $ACCOUNT/$REGION? [y/N] " ok
  [ "$ok" = "y" ] || [ "$ok" = "Y" ] || die "not deployed"
fi

say "5/5 deploy (the first one waits for the certificate's DNS record: add it in Cloudflare when it is printed below)"
# While CloudFormation waits for the certificate: print the record to add (once), next to the deploy's output.
(bash "$HERE/scripts/dns-records.sh" --wait 2>/dev/null | sed 's/^/   /') &
dnspid=$!
rc=0
npx cdk deploy "$STACK" --require-approval never --outputs-file "$HERE/cdk-outputs.json" || rc=$?
kill $dnspid 2>/dev/null || true
[ $rc -eq 0 ] || die "cdk deploy failed (see above; docs/DEPLOY-AWS.md, 'When something fails')"

bash "$HERE/scripts/dns-records.sh"
echo
echo "Deployed. Next (docs/DEPLOY-AWS.md):"
echo "  - Cloudflare: both records above, DNS only. Then:  curl -s https://$(ctx domainName)/healthz   ->  {\"ok\":true}"
echo "  - the runner image: bash scripts/build-image.sh   (first deploy, and after changing engineCliCommit or lib/runner/files)"
if [ "$MODE" = "demo" ]; then
  echo "  - a demo: bash scripts/demo-up.sh owner/repo   ...   bash scripts/demo-down.sh"
fi
