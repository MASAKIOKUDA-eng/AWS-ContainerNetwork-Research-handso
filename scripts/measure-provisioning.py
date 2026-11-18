#!/usr/bin/env python3
"""Scenario S-6: how long does it take to connect a NEW consumer through each path?

Reads cdkd's deployment events (`cdkd events <stack> --json`, the DescribeStackEvents equivalent)
and prints the create time of the resources a consumer team has to wait for.
Run in CloudShell after `npm run deploy`:

  python3 scripts/measure-provisioning.py                 # prefix v6lab
  python3 scripts/measure-provisioning.py --prefix v6lab --csv results/provisioning.csv
"""
import argparse
import datetime as dt
import json
import re
import subprocess

# (stack suffix, logical ID, path, what)
RESOURCES = [
    ("consumer", "PrivateLinkEndpoint", "privatelink", "interface endpoint (to pendingAcceptance)"),
    ("consumer", "LatticeAssociation", "lattice", "service network VPC association"),
    ("consumer", "S3InterfaceEndpoint", "s3-interface", "S3 interface endpoint"),
    ("consumer-vpc", "S3GatewayEndpoint", "s3-gateway", "S3 gateway endpoint"),
    ("provider", "Nlb", "privatelink", "provider: NLB"),
    ("provider", "EndpointService", "privatelink", "provider: endpoint service"),
    ("provider", "LatticeService", "lattice", "provider: Lattice service"),
    ("provider", "ServiceNetworkServiceAssociation", "lattice", "provider: service association"),
    ("provider", "SvcPrivateLink", "privatelink", "provider: ECS service behind the NLB"),
    ("provider", "SvcLattice", "lattice", "provider: ECS service with Lattice"),
]
STACK_RE = re.compile(r"^[a-z0-9-]{3,40}$")


def cdkd_json(*args):
    out = subprocess.run(["npx", "cdkd", *args, "--json"], check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def create_durations(stack):
    """logicalId -> seconds, taken from the newest deploy run that created the resource."""
    if not STACK_RE.match(stack):
        raise ValueError(f"invalid stack name: {stack}")
    try:
        runs = cdkd_json("events", stack).get("runs", [])
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        return {}
    found = {}
    for run in sorted(runs, key=lambda r: r.get("startedAt", ""), reverse=True):
        if run.get("command") != "deploy" or not re.match(r"^[A-Za-z0-9._:-]+$", str(run.get("runId", ""))):
            continue
        try:
            events = cdkd_json("events", stack, "--run", run["runId"])
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            continue
        for e in events if isinstance(events, list) else events.get("events", []):
            if e.get("eventType") == "RESOURCE_SUCCEEDED" and str(e.get("operation", "")).upper() == "CREATE":
                lid = e.get("logicalId")
                if lid and lid not in found and isinstance(e.get("durationMs"), (int, float)):
                    found[lid] = e["durationMs"] / 1000
    return found


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--prefix", default="v6lab")
    p.add_argument("--csv", default="")
    a = p.parse_args()
    cache = {}
    rows = []
    for suffix, logical, path, what in RESOURCES:
        stack = f"{a.prefix}-{suffix}"
        if stack not in cache:
            cache[stack] = create_durations(stack)
        rows.append((path, what, cache[stack].get(logical)))

    print("| path | resource | create time (s) |")
    print("|---|---|---|")
    for path, what, sec in rows:
        print(f"| {path} | {what} | {'-' if sec is None else f'{sec:.0f}'} |")
    if a.csv:
        now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(a.csv, "a") as f:
            for path, what, sec in rows:
                if sec is not None:
                    f.write(f"{path},{what.replace(',', ' ')},{sec:.0f},s,{now}\n")


if __name__ == "__main__":
    main()
