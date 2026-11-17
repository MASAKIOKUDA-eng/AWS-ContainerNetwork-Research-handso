# 02. Architecture and IPv6 design practices

[日本語](../ja/02-architecture.md)

## 2.1 The lab

```
 CONSUMER VPC  10.0.0.0/16 + 2600:xxxx:a::/56                 PROVIDER VPC  10.0.0.0/16 + 2600:xxxx:b::/56
 (no IGW / NAT / EIGW)                                          (no IGW / NAT / EIGW)       ▲ same IPv4 CIDR on purpose
┌───────────────────────────────────────────────┐            ┌───────────────────────────────────────────────┐
│ workload subnets (dual-stack | IPv6-only)      │            │ workload subnets (dual-stack | IPv6-only)      │
│  ┌─────────────────────────┐                   │            │   ECS Fargate                                  │
│  │ load generator EC2 (SSM)│                   │            │   ┌────────────┐   ┌────────────────┐          │
│  │  docker: k6 / curl / dig│                   │            │   │ svc-pl x2  │   │ svc-lattice x2 │          │
│  └──┬───────┬────────┬─────┘                   │            │   └─────▲──────┘   └──────▲─────────┘          │
│     │①      │②       │③                        │            │         │ TCP 8080        │ HTTP 8080          │
│ edge subnets (always dual-stack)               │            │ edge subnets (always dual-stack)               │
│  ┌──▼─────────────┐                            │  PrivateLink │  ┌──────┴─────────┐       │                   │
│  │ interface      │═══════════════════════════════════════════▶│ NLB (dual-stack)│       │                   │
│  │ endpoint (PL)  │  ① AcceptanceRequired     │            │  │ + endpoint svc  │       │                   │
│  └────────────────┘                            │            │  └────────────────┘       │                   │
│     │②  VPC association (SG) ─────────────────────▶ VPC Lattice service network ───────┘ (link-local src)  │
│     │                         auth policy: service network (source VPC) + service (anonymous | SigV4)      │
│     │③                                         │            │                                               │
│  ┌──▼───────────────┐   ┌───────────────────┐  │            │  ECR / Logs interface endpoints (dual-stack)  │
│  │ S3 interface ep. │   │ S3 gateway ep.    │  │            │  S3 gateway endpoint (ECR layers only)        │
│  │ (endpoint policy)│   │ (endpoint policy) │  │            └───────────────────────────────────────────────┘
│  └──────────────────┘   └───────────────────┘  │                 ▲
│  SSM / ECR / Logs interface endpoints           │                 │ S-0 baseline: k6 Fargate task → NLB directly
└───────────────────────────────────────────────┘
          S3: data bucket (readable only via ③)  /  outside bucket (blocked by the endpoint policies)
```

| Path | What it is | Client URL |
|------|-----------|------------|
| ① PrivateLink | interface endpoint → endpoint service → dual-stack NLB → `svc-pl` | `http://<vpce DNS>/` |
| ② VPC Lattice | service network VPC association → Lattice service (HTTP 80 / HTTPS 443) → `svc-lattice` | `http(s)://<service>.<id>.vpc-lattice-svcs.<region>.on.aws/` |
| ③ VPC endpoints | S3 gateway endpoint (dual-stack) and S3 interface endpoint (dual-stack) | `https://<bucket>.s3.dualstack.<region>.amazonaws.com/` / `https://bucket.vpce-….s3.<region>.vpce.amazonaws.com/<bucket>/` |
| S-0 baseline | k6 in the provider VPC → NLB (no PrivateLink hop) | `http://<NLB DNS>/` |

### Stacks

| Stack | Template | Contents |
|-------|----------|----------|
| `v6lab-consumer-vpc` | `cfn/01-vpc.yaml` (Role=consumer) | VPC, 4 subnets, SSM / ECR / Logs endpoints, S3 gateway endpoint, Flow Logs |
| `v6lab-provider-vpc` | `cfn/01-vpc.yaml` (Role=provider) | VPC, 4 subnets, ECR / Logs endpoints, S3 gateway endpoint, Flow Logs |
| `v6lab-provider-platform` | `cfn/02-provider-platform.yaml` | ECR, ECS cluster, IAM, NLB + endpoint service, Lattice SN / service / TG / listeners / auth policies / access logs |
| `v6lab-provider-services` | `cfn/03-provider-services.yaml` | Task definition, `svc-pl`, `svc-lattice`, baseline task definition |
| `v6lab-consumer` | `cfn/04-consumer.yaml` | Load generator, PrivateLink endpoint, Lattice association, S3 buckets + S3 interface endpoint |

## 2.2 Design decisions (and why)

| # | Decision | Why |
|---|----------|-----|
| D1 | **No internet path at all** (no IGW, NAT, EIGW) | The only way out is the three paths under test, so a result cannot come from an unexpected route. Also the safest default for a lab. |
| D2 | **Same IPv4 CIDR in both VPCs** | Shows that none of the three needs routable, unique IPv4 — the real blocker of VPC peering / TGW in large orgs. |
| D3 | **Edge subnets always dual-stack, workload subnets switchable** (`WorkloadIpMode`) | NLBs and many endpoints still need IPv4 addresses in their subnet; workloads do not. This is the "IPv6-first, not IPv6-only everywhere" pattern. |
| D4 | **Two ECS services from one task definition** | Same image, size and AZs → the only difference between ① and ② is the network path. |
| D5 | **HTTP listeners on both paths + an extra HTTPS listener on Lattice** | Apples-to-apples (HTTP vs HTTP), and a separate measurement of what TLS costs. |
| D6 | **Load generator on EC2, reached by SSM only** | Repeatable, large enough not to be the bottleneck, no inbound port. |
| D7 | **Untrusted SG on the same instance** | Security tests change only one thing (the SG) — DNS, routes and the instance stay the same. |
| D8 | **Anonymous S3 reads allowed only via `aws:SourceVpce`** | k6 can test S3 without SigV4, and it demonstrates a resource perimeter; Block Public Access stays on. |
| D9 | **Flow Logs with `traffic-path`, `pkt-srcaddr`, `pkt-dstaddr`, `flow-direction`** | You can prove which address family and which path a flow used. |
| D10 | **Images pinned by digest, non-root, read-only root FS, all capabilities dropped, no ECS Exec** | Same container hardening as the ECS network-mode lab. |

## 2.3 Where does IPv6 stop? (an important slide)

| Hop | `WorkloadIpMode=dualstack` | `WorkloadIpMode=ipv6only` |
|-----|-----------------------------|---------------------------|
| Client → interface endpoint (PL) | IPv6 (k6 `onlyIPv6`) or IPv4 | IPv6 |
| Endpoint → NLB (inside PrivateLink) | AWS-managed, family follows the consumer | AWS-managed |
| NLB → task | **IPv4** (target group `ipv4`, ECS registers the IPv4 address) | **IPv6** (target group `ipv6`) |
| Client → Lattice | IPv6 (`fd00:ec2:80::/64`) or IPv4 (`169.254.171.0/24`) | IPv6 |
| Lattice → task | **IPv4** (target group `IPV4`) | **IPv6** (target group `IPV6`) |
| Client → S3 gateway endpoint | IPv6 if the endpoint is `dualstack` and you use the dual-stack S3 name | IPv6 |

> In dual-stack mode the front door is IPv6 but the back end is still IPv4. That is often fine — the
> connectivity layer translates for you — but say it explicitly in a design review.
> Check in the lab: the `remote` field in the provider access log and `targetIpPort` in the Lattice access log.

## 2.4 IPv6-first container network design practices (talk content)

These are the practices the lab is built on. Each one points to the scenario that shows it.

1. **Start from the subnet, not the VPC.** Give every VPC an IPv6 /56, but decide *per subnet tier* whether it is dual-stack or IPv6-only. Edge tier = dual-stack, workload tier = IPv6-only when dependencies allow. (`cfn/01-vpc.yaml`)
2. **Make dependencies reachable over IPv6 first.** Dual-stack interface endpoints (`IpAddressType: dualstack`, `DnsRecordIpType: dualstack`) and a dual-stack S3 gateway endpoint mean IPv6-only tasks can pull images and ship logs without NAT64. (S-3, `WorkloadIpMode=ipv6only`)
3. **If you need the internet: EIGW for IPv6 egress, NAT gateway only for NAT64 (DNS64 on the subnet).** Inspect with Network Firewall or GWLB on both families. (Not deployed in this lab on purpose; see the AWS blog on IPv6 internet inspection in [references.md](references.md).)
4. **Use the connectivity layer to bridge IP families and overlapping IPv4.** PrivateLink and Lattice both let an IPv6 client reach a service that still runs on IPv4, without peering. (2.3, X-6)
5. **Choose by what the provider must know about the caller.**
   - Only "this account/VPC may connect" → PrivateLink (acceptance + allowed principals + endpoint SG).
   - "Which workload is calling, and may it call this path?" → Lattice auth policies with SigV4.
   - "Which AWS resources may be reached from here?" → endpoint policies (data perimeter).
6. **Layer the controls**: network (SG on endpoint / association) → connectivity (acceptance, auth policy, endpoint policy) → resource (bucket policy with `aws:SourceVpce`). One misconfiguration should not open everything. (X-1 … X-5)
7. **Security groups speak IPv6 too.** Every rule written for `0.0.0.0/0` or a VPC CIDR needs its `::/0` / IPv6 CIDR twin, and Lattice targets must allow both `169.254.171.0/24` and `fd00:ec2:80::/64` (or the managed prefix lists). (`TaskSg`)
8. **Log the family.** Flow Logs `pkt-srcaddr` / `traffic-path`, provider access logs and Lattice access logs are how you prove the traffic is really IPv6. (X-4)
9. **Measure with the same offered load and connection policy.** Connection reuse and TLS often matter more than the path. (S-1 vs S-2)
10. **Make onboarding time part of "speed".** A path that takes a ticket and an approval is slower for a team than one with an extra 0.3 ms. (S-6)

## 2.5 Things deliberately not in the lab

- Transit Gateway / VPC peering (they need unique routable IPv4 or IPv6; the lab focuses on service-level connectivity)
- Lattice resource configurations / service network endpoints (TCP resources such as databases) — good next step
- Cross-account sharing with AWS RAM (everything is in one account to keep it simple; the policies are written so that the same design works cross-account)
- Internet egress / inspection (see practice 3)
