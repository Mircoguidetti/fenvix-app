"""fenvix shared cache: the vendored cache_service.py (unchanged, see PROVENANCE.md) with per-job signed tokens.

The worker mints one token per job (github-app/src/runners/credentials.ts), signed with the cache signing key (RSA,
an SSM parameter only the worker reads). This machine holds only the public key, so nothing on it can mint a token:

    fxs1.<base64url(JSON payload)>.<base64url(RSASSA-PKCS1-v1_5 SHA-256 signature over "fxs1." + payload part)>
    payload: {"org": "gh-<installation id>-r<repository id>", "w": true|false, "exp": <unix seconds>, "job": <job id>}
             (a warm-up machine's token names its warm-up instead: "warm": <warm-up id>; it always writes, since a
             warm-up runs the default branch only. Neither "job" nor "warm" is read here: they are for the logs.)

The organization of every request is the token's ("one cache organization per customer repository"): a token of
one customer never reads or writes another's entries, file facts or runs (docs/REVIEW-R-012.md F3). Pull requests and
forks get "w": false (read only, within their own organization). Static tokens (tokens.json) are not accepted.

    python3 -I fenvix_cache_auth.py serve --data DIR --key FILE [--host H] [--port P] [--quiet]

FILE is JSON {"n": "<modulus, hex>", "e": <exponent>} (written by the user data; public, not secret).

Limits (audit G-2320), so that one job cannot take the shared cache away from every other customer: each cache
organization (one customer repository) gets a request rate and a byte rate (token buckets; over them: 429 with
Retry-After), at most PER_ORG_INFLIGHT requests at once, and the machine at most INFLIGHT requests at once (each may
hold up to 64 MB unpacked: 4 x 64 MB fits the machine's memory; over it: 503 with Retry-After). How the trunk
engine's cache client reacts to 429 and 503 is UNKNOWN until it is checked against this service (G-1742).
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
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cache_service  # noqa: E402  (vendored, byte for byte)

PREFIX = "fxs1."
# One organization per customer repository (audit G-0192/G-0193): gh-<installation id>-r<repository id>. The older
# per-installation form (gh-<id>) spanned every repository of an account and is refused.
ORG = re.compile(r"^gh-[0-9]{1,20}-r[0-9]{1,20}$")
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


RATE = 30.0                       # requests per second per organization (sustained) ...
BURST = 120.0                     # ... and in a burst
BYTE_RATE = 32 * 1024 * 1024      # request bytes per second per organization (Content-Length, as sent) ...
BYTE_BURST = 192 * 1024 * 1024    # ... and in a burst (above one MAX_BODY request)
PER_ORG_INFLIGHT = 2
INFLIGHT = 4


class Limits:
    """Per-organization token buckets and in-flight counts, and one machine-wide in-flight count."""

    def __init__(self, now=time.monotonic, rate=RATE, burst=BURST, byte_rate=BYTE_RATE, byte_burst=BYTE_BURST,
                 per_org_inflight=PER_ORG_INFLIGHT, inflight=INFLIGHT):
        self.now, self.rate, self.burst, self.byte_rate, self.byte_burst = now, rate, burst, byte_rate, byte_burst
        self.per_org_inflight, self.inflight = per_org_inflight, inflight
        self.lock = threading.Lock()
        self.buckets: dict[str, list[float]] = {}   # org -> [requests left, bytes left, at]
        self.busy: dict[str, int] = {}
        self.total = 0

    def admit(self, org: str, nbytes: int) -> tuple[int, str] | None:
        """None (admitted: call done(org) after), or (status, why) to refuse with."""
        with self.lock:
            t = self.now()
            b = self.buckets.get(org) or [self.burst, self.byte_burst, t]
            dt = max(0.0, t - b[2])
            b[0] = min(self.burst, b[0] + dt * self.rate)
            b[1] = min(self.byte_burst, b[1] + dt * self.byte_rate)
            b[2] = t
            self.buckets[org] = b
            if len(self.buckets) > 10_000:  # forget idle organizations (a full bucket is the same as none)
                for k in [k for k, v in self.buckets.items() if v[0] >= self.burst and k not in self.busy][:5_000]:
                    del self.buckets[k]
            if b[0] < 1 or b[1] < nbytes:
                return 429, "rate limit of this repository's cache"
            if self.busy.get(org, 0) >= self.per_org_inflight:
                return 429, "too many requests at once for this repository's cache"
            if self.total >= self.inflight:
                return 503, "the cache is busy"
            b[0] -= 1
            b[1] -= nbytes
            self.busy[org] = self.busy.get(org, 0) + 1
            self.total += 1
            return None

    def done(self, org: str) -> None:
        with self.lock:
            self.total -= 1
            n = self.busy.get(org, 0) - 1
            if n > 0:
                self.busy[org] = n
            else:
                self.busy.pop(org, None)


class LimitedHandler(cache_service.Handler):
    """The vendored handler, admitted per organization after the token is checked and before the body is read."""

    def _auth(self, write: bool):
        tok = super()._auth(write)
        if tok is None:
            return None
        try:
            n = max(0, int(self.headers.get("Content-Length") or 0))
        except ValueError:
            n = 0
        refused = self.server.limits.admit(tok["org"], n)  # type: ignore[attr-defined]
        if refused:
            code, why = refused
            self.close_connection = True
            body = json.dumps({"error": why}).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Retry-After", "1")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return None
        self._admitted = tok["org"]
        return tok

    def handle_one_request(self):
        self._admitted = None
        try:
            super().handle_one_request()
        finally:
            if self._admitted is not None:
                self.server.limits.done(self._admitted)  # type: ignore[attr-defined]
                self._admitted = None


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
    svc.httpd.RequestHandlerClass = LimitedHandler
    svc.httpd.limits = Limits()  # type: ignore[attr-defined]
    print(f"fenvix cache service on {svc.url} (data {args.data}; per-job signed tokens only)", flush=True)
    try:
        svc.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
