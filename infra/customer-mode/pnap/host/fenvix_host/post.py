"""Sends one job's summary to the App. Runs as fenvix-post: it reads the job's own summary credential (a file only
fenvix-post can read, deleted with the job) and the parsed result on stdin; it never reads a guest's bytes. The ids
and the runner name are arguments from the host's own job record (the App also takes them from the credential and
refuses a body that disagrees, R-012 F1).

  python3 -I -m fenvix_host.post URL CREDENTIAL_FILE REPOSITORY_ID RUN_ID RUN_ATTEMPT RUNNER_NAME < parsed.json
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request


def main(argv: list[str]) -> int:
    url, cred_file, repo, run, attempt, name = argv
    r = json.load(sys.stdin)
    if not isinstance(r.get("summary"), dict):
        print("no summary from the guest:", r.get("error", "none"))
        return 0
    with open(cred_file, encoding="utf-8") as f:
        token = f.read().strip()
    body = {"repositoryId": int(repo), "runId": int(run), "runAttempt": int(attempt), "runnerName": name, "summary": r["summary"]}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print("summary sent:", resp.status)
            return 0
    except urllib.error.HTTPError as e:
        print("summary refused:", e.code)
        return 3 if e.code >= 500 else 4


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
