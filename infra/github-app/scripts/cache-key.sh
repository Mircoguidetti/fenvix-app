#!/usr/bin/env bash
# per-job mode: creates the cache signing key pair. The private half goes to SSM (SecureString
# /fenvix/<env>/cache/signing-key; only the worker reads it, to sign one cache token per job for that customer's
# cache organization). It is never printed and the local copy is shredded. Prints the public half, which is not
# secret and goes into cdk.json as "cacheSigningPublicKey" (the cache machine verifies tokens with it).
# Run again to rotate: deploy right after (the cache machine is replaced, and the cache starts empty).
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
umask 077
dir="$(mktemp -d)"
trap 'shred -u "$dir"/* 2>/dev/null || rm -f "$dir"/*; rmdir "$dir"' EXIT
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$dir/key.pem" 2>/dev/null
aws ssm put-parameter --name "/fenvix/$ENVNAME/cache/signing-key" --type SecureString --value "file://$dir/key.pem" --overwrite >/dev/null
pub="$(openssl pkey -in "$dir/key.pem" -pubout -outform DER | base64 | tr -d '\n')"
printf '"cacheSigningPublicKey": "%s",\n' "$pub"
echo "Put this line in cdk.json (context), then deploy (scripts/deploy.sh)."
