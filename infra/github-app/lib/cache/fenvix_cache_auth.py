"""fenvix shared cache: the vendored cache_service.py (unchanged, see PROVENANCE.md) with per-job signed tokens.

The worker mints one token per job (github-app/src/runners/credentials.ts), signed with the cache signing key (RSA,
an SSM parameter only the worker reads). This machine holds only the public key, so nothing on it can mint a token:

    fxs1.<base64url(JSON payload)>.<base64url(RSASSA-PKCS1-v1_5 SHA-256 signature over "fxs1." + payload part)>
    payload: {"org": "gh-<installation id>", "w": true|false, "exp": <unix seconds>, "job": <job id>}
             (a warm-up machine's token names its warm-up instead: "warm": <warm-up id>; it always writes, since a
             warm-up runs the default branch only. Neither "job" nor "warm" is read here: they are for the logs.)

The organization of every request is the token's ("one cache organization per customer installation"): a token of
one customer never reads or writes another's entries, file facts or runs (docs/REVIEW-R-012.md F3). Pull requests and
forks get "w": false (read only, within their own organization). Static tokens (tokens.json) are not accepted.

    python3 -I fenvix_cache_auth.py serve --data DIR --key FILE [--host H] [--port P] [--quiet]

FILE is JSON {"n": "<modulus, hex>", "e": <exponent>} (written by the user data; public, not secret).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cache_service  # noqa: E402  (vendored, byte for byte)

PREFIX = "fxs1."
ORG = re.compile(r"^gh-[0-9]{1,20}$")
MAX_TOKEN = 4096
# DER DigestInfo prefix of SHA-256 (RFC 8017, section 9.2, note 1).
SHA256_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


def _b64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def rsa_verify(n: int, e: int, message: bytes, signature: bytes) -> bool:
    """RSASSA-PKCS1-v1_5 with SHA-256. Only public values are involved, so nothing here needs to be constant-time;
    the final comparison is anyway."""
    k = (n.bit_length() + 7) // 8
    if len(signature) != k:
        return False
    s = int.from_bytes(signature, "big")
    if s >= n:
        return False
    em = pow(s, e, n).to_bytes(k, "big")
    t = SHA256_INFO + hashlib.sha256(message).digest()
    if k < len(t) + 11:
        return False
    expected = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    return hmac.compare_digest(em, expected)


class SignedTokens:
    """Drop-in for cache_service.Tokens: check(token) -> {"org", "write"} or None."""

    def __init__(self, key_path: str, now=time.time):
        with open(key_path) as fh:
            k = json.load(fh)
        self.n = int(k["n"], 16)
        self.e = int(k["e"])
        if self.n.bit_length() < 2048 or self.e < 3:
            raise ValueError("the cache signing key must be RSA, 2048 bits or more")
        self.now = now

    def check(self, token: str) -> dict | None:
        if not token.startswith(PREFIX) or len(token) > MAX_TOKEN:
            return None
        parts = token.split(".")
        if len(parts) != 3:
            return None
        try:
            payload_raw, sig = _b64(parts[1]), _b64(parts[2])
        except (ValueError, TypeError):
            return None
        if not rsa_verify(self.n, self.e, (PREFIX + parts[1]).encode(), sig):
            return None
        try:
            p = json.loads(payload_raw)
        except ValueError:
            return None
        if not isinstance(p, dict) or not isinstance(p.get("org"), str) or not ORG.match(p["org"]):
            return None
        if not isinstance(p.get("w"), bool) or not isinstance(p.get("exp"), int) or p["exp"] < self.now():
            return None
        return {"org": p["org"], "write": p["w"]}


def main(argv=None) -> int:
    a = argparse.ArgumentParser(prog="fenvix_cache_auth.py")
    sub = a.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--data", required=True)
    s.add_argument("--key", required=True, help="the public key file ({n, e})")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8787)
    s.add_argument("--quiet", action="store_true")
    args = a.parse_args(argv)
    tokens = SignedTokens(args.key)
    svc = cache_service.Service(args.data, args.host, args.port, args.quiet)
    svc.tokens = tokens
    print(f"fenvix cache service on {svc.url} (data {args.data}; per-job signed tokens only)", flush=True)
    try:
        svc.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
