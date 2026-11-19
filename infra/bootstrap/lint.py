#!/usr/bin/env python3
"""cfn-lint on the one-click template (fenvix-bootstrap.json), every finding fatal, with one exact exception.

cfn-lint's list of IAM actions (W3037) lags AWS: it does not know apigateway:TagResource / apigateway:UntagResource,
which API Gateway now authorizes and CloudFormation's AWS::ApiGatewayV2::Stage handler calls (the second deploy failed
on it: run 44558615825). Those two, in the edge execution policy only, are accepted; any other finding fails.

  python3 infra/bootstrap/lint.py      # needs cfn-lint (pip install cfn-lint==1.60.1)
"""
import json
import os
import subprocess
import sys

TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fenvix-bootstrap.json")
# (resource, action name as cfn-lint quotes it): the only W3037 findings accepted.
ACCEPTED = {("CfnExecEdge", "tagresource"), ("CfnExecEdge", "untagresource")}


def accepted(f):
    if f["Rule"]["Id"] != "W3037":
        return False
    path = f["Location"]["Path"]
    if len(path) < 2 or path[0] != "Resources":
        return False
    name = f["Message"].split("'")[1] if f["Message"].startswith("'") else ""
    if (path[1], name) not in ACCEPTED or not f["Message"].startswith(f"'{name}' is not one of ['addcertificatetodomain'"):
        return False
    # The statement holding it must be the API Gateway one.
    doc = json.load(open(TEMPLATE))["Resources"][path[1]]["Properties"]["PolicyDocument"]
    actions = doc["Statement"][path[5]]["Action"]
    return f"apigateway:{'TagResource' if name == 'tagresource' else 'UntagResource'}" in actions


def main():
    cli = os.path.join(os.path.dirname(sys.executable), "cfn-lint")
    out = subprocess.run([cli if os.path.exists(cli) else "cfn-lint", "--format", "json", TEMPLATE], capture_output=True, text=True)
    findings = json.loads(out.stdout or "[]")
    rest = [f for f in findings if not accepted(f)]
    for f in findings:
        if f not in rest:
            print(f"accepted {f['Rule']['Id']} at {'/'.join(map(str, f['Location']['Path']))}: {f['Message'][:60]}... (cfn-lint's IAM list lags AWS)")
    for f in rest:
        print(f"{f['Rule']['Id']} {'/'.join(map(str, f['Location']['Path']))}: {f['Message'][:300]}")
    if rest or (out.returncode not in (0, 4) and not findings):
        print(out.stderr, file=sys.stderr)
        return 1
    print(f"cfn-lint: {os.path.basename(TEMPLATE)} clean ({len(findings) - len(rest)} accepted)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
