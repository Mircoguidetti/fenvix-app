#!/usr/bin/env python3
"""The IAM actions CloudFormation's resource handlers call, per resource type of the fenvix stacks.

Read from the CloudFormation resource-provider schemas that cfn-lint ships (handlers.<op>.permissions, and
tagging.permissions), for eu-west-1, and written to test/cfn-handler-permissions.json, which
test/cfn-permissions.test.ts checks the execution policies (cfn-exec-policy-*.json) against, offline.

  python3 scripts/cfn-handler-permissions.py                     # rewrite the file for the types already in it
  python3 scripts/cfn-handler-permissions.py AWS::X::Y ...       # ... and add these types
  python3 scripts/cfn-handler-permissions.py --check             # fail if the file is not what cfn-lint says (CI)

Needs cfn-lint (pip install cfn-lint==1.60.1), not an AWS account.
"""
import json
import os
import sys

import cfnlint

REGION = "eu-west-1"
OUT = os.path.join(os.path.dirname(__file__), "..", "test", "cfn-handler-permissions.json")
DATA = os.path.join(os.path.dirname(cfnlint.__file__), "data", "schemas")


def schema(type_name):
    index = json.load(open(os.path.join(DATA, "providers", f"{REGION}.json")))
    return json.load(open(os.path.join(DATA, "resources", f"{index[type_name]}.json")))


def iam_actions():
    """Every IAM action name cfn-lint knows (its copy of the IAM service authorization reference), lowercased."""
    spec = json.load(open(os.path.join(os.path.dirname(cfnlint.__file__), "data", "AdditionalSpecs", "Policies.json")))
    return {f"{prefix}:{a}" for prefix, svc in spec.items() for a in svc.get("Actions", {})}


def entry(type_name, known):
    s = schema(type_name)
    h = s.get("handlers", {})
    t = s.get("tagging", {})
    out = {
        **{op: sorted(set(h.get(op, {}).get("permissions", []))) for op in ("create", "update", "delete", "read")},
        "taggable": bool(t.get("taggable", False)),
        "tagOnCreate": bool(t.get("tagOnCreate", False)),
        "tagging": sorted(set(t.get("permissions", []))) if t.get("taggable") else [],
    }
    # Names a schema lists that IAM does not know (e.g. cloudfront:CreateDistributionWithTags, which IAM authorizes as
    # CreateDistribution + TagResource): no policy can grant them, so the test does not ask for them.
    listed = {p for op in ("create", "update", "delete", "read", "tagging") for p in out[op]}
    out["notIamActions"] = sorted(p for p in listed if p.lower() not in known)
    return out


def render(types):
    known = iam_actions()
    from importlib.metadata import version
    doc = {"source": f"cfn-lint {version('cfn-lint')} resource-provider schemas, {REGION}", "types": {t: entry(t, known) for t in sorted(types)}}
    return json.dumps(doc, indent=1) + "\n"


def main(argv):
    check = "--check" in argv
    current = json.load(open(OUT)) if os.path.exists(OUT) else {"types": {}}
    types = set(current["types"]) | {a for a in argv if a.startswith("AWS::")}
    text = render(types)
    if check:
        if open(OUT).read() != text:
            print("test/cfn-handler-permissions.json is stale: run python3 infra/github-app/scripts/cfn-handler-permissions.py", file=sys.stderr)
            return 1
        print("cfn-handler-permissions.json is up to date")
        return 0
    open(OUT, "w").write(text)
    print(f"wrote test/cfn-handler-permissions.json ({len(types)} types)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
