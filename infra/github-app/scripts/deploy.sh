#!/usr/bin/env bash
# The one deploy command (from infra/github-app):  npm run deploy      (add -- --yes to skip the confirmation)
#
# 1. checks: Node 22.18+, AWS CLI, the AWS account, the settings, the SSM parameters (names only, never values);
# 2. installs and tests the service (github-app: typecheck + unit tests) and this folder (template tests);
# 3. keeps the runner's AMI (first deploy: the current Ubuntu 24.04 one), so a deploy never replaces the machine;
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
for p in database-url private-key webhook-secret client-secret state-signing-key runner-token; do
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

say "3/5 runner AMI"
if [ -z "${FENVIX_RUNNER_AMI_ID:-}" ] && [ -z "$(ctx runnerAmiId)" ]; then
  FENVIX_RUNNER_AMI_ID="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='RunnerAmiId'].OutputValue | [0]" --output text 2>/dev/null || true)"
  if [ -z "$FENVIX_RUNNER_AMI_ID" ] || [ "$FENVIX_RUNNER_AMI_ID" = "None" ]; then
    FENVIX_RUNNER_AMI_ID="$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)"
    echo "first deploy: current Ubuntu 24.04 AMI $FENVIX_RUNNER_AMI_ID (kept from now on)"
  else
    echo "keeping the runner's AMI $FENVIX_RUNNER_AMI_ID"
  fi
  export FENVIX_RUNNER_AMI_ID
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
cat <<NEXT

Deployed. Next (docs/DEPLOY-AWS.md):
  - Cloudflare: both records above, DNS only. Then:  curl -s https://$(ctx domainName)/healthz   ->  {"ok":true}
  - the runner machine is building the engine (about 15 minutes), then waits for its registration token:
      step 11 puts it in SSM: /fenvix/$ENVNAME/runner/registration-token
NEXT
