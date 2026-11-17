# 01. Overview (for the talk)

[日本語](../ja/01-overview.md)

## Event

| Item | Value |
|------|-------|
| Event | JAWS-UG Yamanashi (connpass event 411061) — https://jaws-ug-yamanashi.connpass.com/event/411061/ |
| Date | 2026-11-21 (Sat) |
| Language | English |
| Slot | **Check the timetable on connpass.** The script in [06-talk-script-en.md](06-talk-script-en.md) is written for 20 minutes and marks what to cut for a 10-minute version. |

## Title

**IPv6-first container network design practices**
— Comparing AWS PrivateLink, VPC endpoints and VPC Lattice for speed and security, with numbers from a hands-on lab

Short title for the slide footer: *IPv6-first container networking on AWS*

## Abstract (for connpass / the first slide)

> IPv4 addresses are now a cost line on the AWS bill, and Amazon ECS can run tasks in IPv6-only subnets since 2025.
> But "turn on IPv6" is the easy part. The hard part is how containers in different VPCs talk to each other and to AWS services.
> In this talk I compare three building blocks — AWS PrivateLink, VPC endpoints for AWS services, and Amazon VPC Lattice —
> on two axes: **speed** (latency, handshake cost, throughput, time to connect a new consumer) and **security**
> (who can call whom, what the provider can see, how to build a data perimeter).
> All numbers come from an open hands-on lab you can deploy in your own account.

## One-sentence message

> **Design for IPv6 at the edges you control, and let the connectivity layer (PrivateLink / Lattice / endpoints) absorb the IPv4 world — then pick the layer by "what you need to know about the caller", not by speed.**

(The last part is a hypothesis. Replace it with what the measurements say — see [result-template.md](result-template.md).)

## What the audience should take home

1. **IPv6-first ≠ IPv6-only everywhere.** Keep edge subnets (NLB, endpoints) dual-stack, make workload subnets IPv6-only when your dependencies allow it.
2. **The three options solve different problems.**
   - PrivateLink = expose *one TCP endpoint* to many VPCs/accounts. L4. The provider does not see the caller.
   - VPC endpoints for AWS services = reach AWS APIs privately, with an *endpoint policy as a data perimeter*.
   - VPC Lattice = service-to-service *application network* with IAM auth, identity headers and L7 routing.
3. **Overlapping IPv4 CIDRs stop mattering** with all three (the lab uses `10.0.0.0/16` on both sides on purpose).
4. **Speed differences exist, but they are small compared to TLS / connection reuse decisions** (hypothesis — to be confirmed by S-1 / S-2).
5. **Security is layered differently**: SG on the endpoint / association, endpoint-service acceptance, auth policies, endpoint policies, bucket policies.

## The comparison at a glance (to be filled with lab results)

| | PrivateLink (endpoint service) | VPC endpoints for AWS services | VPC Lattice |
|---|---|---|---|
| Layer | L4 (TCP/UDP via NLB) | L4 (interface) / route (gateway) | L7 (HTTP/HTTPS/gRPC), TLS passthrough, TCP via resource configs |
| IPv6 in this lab | Dual-stack NLB + `SupportedIpAddressTypes: [ipv4, ipv6]` + dual-stack interface endpoint | Dual-stack interface endpoints, S3 gateway endpoint `IpAddressType: dualstack` (Nov 2025) | IPv6 clients via VPC association, IPv4 or IPv6 target groups |
| Caller identity at the provider | ✗ (source = NLB address; Proxy Protocol v2 is optional) | n/a (AWS service sees `aws:SourceVpce`) | ✓ `x-amzn-source-vpc`, `x-amzn-lattice-identity` (SigV4) |
| Access control | Endpoint SG, allowed principals, acceptance | Endpoint SG, **endpoint policy**, resource policy (`aws:SourceVpce`) | Association SG, **auth policy** (service network + service), SigV4 |
| Overlapping IPv4 | OK | OK | OK |
| Speed: added latency (p50 / p99) | *S-1 result* | *S-1 result* | *S-1 result* |
| Speed: new-connection cost | *S-2 result* | *S-2 result* | *S-2 result* |
| Speed: time to connect a consumer | *S-6 result* | *S-6 result* | *S-6 result* |
| Billing model (check pricing) | per endpoint-AZ hour + per GB, plus NLB | gateway: free / interface: per AZ hour + per GB | per service hour + per GB + per request |

## Hypotheses (before measuring — overwrite with results)

| ID | Hypothesis | Scenario |
|----|------------|----------|
| H1 | PrivateLink adds the least latency (L4 pass-through); Lattice adds a small but visible L7 hop | S-0, S-1 |
| H2 | IPv6 vs IPv4 on the same path makes no meaningful difference in latency | S-3 |
| H3 | HTTPS without connection reuse costs more than the choice of path | S-2 |
| H4 | S3 gateway and interface endpoints have similar latency; the gateway one is free | S-1, S-4 |
| H5 | Connecting a new consumer is fastest with Lattice (association only), PrivateLink needs a provider approval step | S-6 |
| H6 | Only Lattice lets the provider make a per-caller decision (SigV4 identity) | X-3, X-4 |
| H7 | Endpoint policies stop data exfiltration to other buckets even when the bucket itself allows the endpoint | X-5 |

## Numbers to put on slides

| Number | Source | Status |
|--------|--------|--------|
| p50 / p99 latency per path (1 KiB, keep-alive) | `results/k6.csv` → `summarize.py --pivot total_p99_ms` | ☐ |
| Handshake cost (connect + TLS, new connection) | S-2 | ☐ |
| IPv6 vs IPv4 difference | S-3 | ☐ |
| MB/s per path (1 MiB objects) | S-4 | ☐ |
| Seconds until a new consumer can call | S-6 `results/provisioning.csv` | ☐ |
| Security matrix (allowed / denied) | `results/probe.csv` | ☐ |
| What the provider saw (source / identity) | `scripts/source-ip-report.sh` | ☐ |
