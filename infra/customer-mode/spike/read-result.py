#!/usr/bin/env python3
"""Reads one job's result record from the raw result disk a guest wrote, in userspace, with a size cap, and prints it
as canonical JSON. The host never mounts a disk a guest wrote (docs/REVIEW-R-012.md F9): a crafted filesystem would
reach the parent's kernel, and a symlink would be followed on the host.

Record (written by guest/fenvix-guest-job at offset 0 of /dev/vdc): b"FXRES001", a 4-byte big-endian length, then
that many bytes of UTF-8 JSON {"summary": object|null, "t_guest_up": number, "t_job_done": number}. Anything else is
refused. Runs as an unprivileged user (fenvix-parse), with the disk's bytes on stdin; reads at most MAX bytes.

Only the summary and the two timings leave this script. The repository, run and runner name of the summary are the
host's own job record (run-job.sh), never the guest's word.
"""
import json
import sys

MAGIC = b"FXRES001"
MAX = 8 * 1024 * 1024


def main() -> int:
    head = sys.stdin.buffer.read(len(MAGIC) + 4)
    if len(head) != len(MAGIC) + 4 or head[: len(MAGIC)] != MAGIC:
        print(json.dumps({"summary": None, "error": "no result record"}))
        return 0
    n = int.from_bytes(head[len(MAGIC):], "big")
    if n > MAX:
        print(json.dumps({"summary": None, "error": f"record of {n} bytes refused (limit {MAX})"}))
        return 0
    raw = sys.stdin.buffer.read(n)
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        print(json.dumps({"summary": None, "error": "record is not JSON"}))
        return 0
    if not isinstance(doc, dict):
        doc = {}
    out = {"summary": doc.get("summary") if isinstance(doc.get("summary"), dict) else None}
    for k in ("t_guest_up", "t_job_done"):
        if isinstance(doc.get(k), (int, float)) and not isinstance(doc.get(k), bool):
            out[k] = float(doc[k])
    print(json.dumps(out, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
