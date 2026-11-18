#!/usr/bin/env bash
# Creates the shared cache's two tokens and stores them in SSM (SecureString): a write token (jobs on trusted refs)
# and a read-only token (pull requests, forks). The tokens are never printed. Prints only their SHA-256, which is not
# secret and goes into cdk.json (cacheTokenSha256Write, cacheTokenSha256Read); the cache machine keeps only those.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
for kind in write read; do
  token="fxc_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
  aws ssm put-parameter --name "/fenvix/$ENVNAME/cache/$kind-token" --type SecureString --value "$token" --overwrite >/dev/null
  sha="$(printf '%s' "$token" | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)"
  unset token
  printf '"cacheTokenSha256%s": "%s",\n' "$( [ "$kind" = write ] && echo Write || echo Read )" "$sha"
done
echo "Put these two lines in cdk.json (context), then deploy."
