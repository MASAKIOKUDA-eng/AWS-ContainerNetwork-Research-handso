#!/usr/bin/env python3
"""Scenario S-6: how long does it take to connect a NEW consumer through each path?

Reads CloudFormation stack events and prints the create time of the resources that a
consumer team has to wait for (run in CloudShell after deploying the stacks):

  python3 scripts/measure-provisioning.py            # default prefix v6lab
  python3 scripts/measure-provisioning.py --prefix v6lab --csv results/provisioning.csv
"""
import argparse
import datetime as dt
import json
import subprocess

RESOURCES = [
    ("v6lab-consumer", "PrivateLinkEndpoint", "privatelink", "interface endpoint (to pendingAcceptance)"),
    ("v6lab-consumer", "LatticeAssociation", "lattice", "service network VPC association"),
    ("v6lab-consumer", "S3InterfaceEndpoint", "s3-interface", "S3 interface endpoint"),
    ("v6lab-consumer-vpc", "S3GatewayEndpoint", "s3-gateway", "S3 gateway endpoint"),
    ("v6lab-provider-platform", "Nlb", "privatelink", "provider: NLB"),
    ("v6lab-provider-platform", "EndpointService", "privatelink", "provider: endpoint service"),
    ("v6lab-provider-platform", "LatticeService", "lattice", "provider: Lattice service"),
    ("v6lab-provider-platform", "ServiceNetworkServiceAssociation", "lattice", "provider: service association"),
]


def events(stack):
    out = subprocess.run(
        ["aws", "cloudformation", "describe-stack-events", "--stack-name", stack, "--output", "json"],
        check=True, capture_output=True, text=True).stdout
    return json.loads(out)["StackEvents"]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--prefix", default="v6lab")
    p.add_argument("--csv", default="")
    a = p.parse_args()
    cache = {}
    rows = []
    for stack, logical, path, what in RESOURCES:
        stack = stack.replace("v6lab", a.prefix, 1)
        if stack not in cache:
            try:
                cache[stack] = events(stack)
            except subprocess.CalledProcessError:
                cache[stack] = []
        ev = [e for e in cache[stack] if e["LogicalResourceId"] == logical]
        start = [e["Timestamp"] for e in ev if e["ResourceStatus"] == "CREATE_IN_PROGRESS"]
        done = [e["Timestamp"] for e in ev if e["ResourceStatus"] == "CREATE_COMPLETE"]
        if not start or not done:
            rows.append((path, what, None))
            continue
        t0 = dt.datetime.fromisoformat(min(start).replace("Z", "+00:00"))
        t1 = dt.datetime.fromisoformat(max(done).replace("Z", "+00:00"))
        rows.append((path, what, (t1 - t0).total_seconds()))

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
