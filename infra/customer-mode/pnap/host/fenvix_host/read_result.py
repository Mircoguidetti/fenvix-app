"""Reads one job's result record from the raw result disk a guest wrote, in userspace, with a size cap, and prints it
as canonical JSON. Runs as fenvix-parse with the disk's bytes on stdin (the agent opened the file safely, result.py)
and nothing else readable. Same record as the spike (infra/customer-mode/spike/read-result.py):

  b"FXRES001", a 4-byte big-endian length, then that many bytes of UTF-8 JSON
  {"summary": object|null, "t_guest_up": number, "t_job_done": number, "receipts_url": string|null}

Only the summary and the timings leave this script; the repository, run and runner name are the host's own job
record, never the guest's word.
"""

from __future__ import annotations

import json
import sys

MAGIC = b"FXRES001"
MAX = 8 * 1024 * 1024


def parse(stream) -> dict:
    head = stream.read(len(MAGIC) + 4)
    if len(head) != len(MAGIC) + 4 or head[: len(MAGIC)] != MAGIC:
        return {"summary": None, "error": "no result record"}
    n = int.from_bytes(head[len(MAGIC):], "big")
    if n > MAX:
        return {"summary": None, "error": f"record of {n} bytes refused (limit {MAX})"}
    raw = stream.read(n)
    if len(raw) != n:
        return {"summary": None, "error": "record shorter than its length"}
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return {"summary": None, "error": "record is not JSON"}
    if not isinstance(doc, dict):
        doc = {}
    out: dict = {"summary": doc.get("summary") if isinstance(doc.get("summary"), dict) else None}
    for k in ("t_guest_up", "t_job_done"):
        v = doc.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = float(v)
    return out


def main() -> int:
    print(json.dumps(parse(sys.stdin.buffer), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
