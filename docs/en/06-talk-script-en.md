# 06. Talk script (English, 20 minutes)

[日本語（読み合わせ用の訳）](../ja/06-talk-script.md)

- Slide text is short so it can be read at a glance. Speaker notes use short, plain sentences that are easy to say aloud.
- `[RESULT]` = replace with the number from [result-template.md](result-template.md). Do not present hypotheses as results.
- **10-minute version**: skip the slides marked ✂ and use one result slide (S-1) and one security slide (matrix).
- Timing marks are cumulative.

---

### Slide 1 — Title (0:00–0:30)

**On slide**
- IPv6-first container network design practices
- PrivateLink vs VPC endpoints vs VPC Lattice — speed and security, measured
- Name / role / JAWS-UG Yamanashi, 2026-11-21

**Say**
> Hi, I'm ___. Thank you for having me in Yamanashi.
> Today's talk is in English, so I will speak slowly. The slides have all the keywords.
> The topic is IPv6 for container networks — and how containers in different VPCs should talk to each other.

### Slide 2 — Why now (0:30–1:30)

**On slide**
- Public IPv4 addresses are charged (since Feb 2024)
- ECS supports IPv6-only tasks (Sep 2025)
- S3 gateway endpoints support IPv6 (Nov 2025)
- → "IPv6-first" is now realistic for containers

**Say**
> Three changes made this talk possible.
> First, every public IPv4 address now costs money.
> Second, Amazon ECS can run tasks in IPv6-only subnets since September 2025.
> Third, in November 2025, S3 gateway endpoints started to support IPv6.
> So the question is no longer "can we use IPv6?". It is "how do we design it?".

### Slide 3 — The real problem (1:30–2:30)

**On slide**
- Turning on IPv6 is easy
- Hard part: service-to-service across VPCs and accounts
- Overlapping 10.0.0.0/16 everywhere
- Three building blocks: PrivateLink / VPC endpoints / VPC Lattice

**Say**
> Adding an IPv6 CIDR to a VPC takes one click. That is not the hard part.
> The hard part is connectivity. Many teams, many accounts, and everybody used 10.0.0.0/16.
> AWS gives us three building blocks that do not care about overlapping IPv4.
> PrivateLink, VPC endpoints for AWS services, and VPC Lattice.
> Which one should we use? I built a lab to measure them.

### Slide 4 — The lab (2:30–4:00)

**On slide**
- Diagram from [02-architecture.md](02-architecture.md)
- Two VPCs, both 10.0.0.0/16, no internet at all
- Same ECS task behind PrivateLink and behind Lattice
- k6 load generator, all on GitHub

**Say**
> Here is the lab. Two VPCs. Both use the same IPv4 CIDR — on purpose.
> There is no internet gateway, no NAT, nothing. The only way out is the path I want to measure.
> On the provider side, the same container runs twice. One copy behind a PrivateLink endpoint service. One copy behind VPC Lattice.
> On the consumer side, a load generator with k6 calls each path over IPv6.
> Everything is CloudFormation, and it is on GitHub. You can run it in your own account.

### Slide 5 ✂ — Design practice: subnet tiers (4:00–5:00)

**On slide**
- Edge subnets: dual-stack (NLB, endpoints)
- Workload subnets: dual-stack → IPv6-only
- Dual-stack VPC endpoints for ECR / Logs / SSM / S3
- "IPv6-first" ≠ "IPv6-only everywhere"

**Say**
> My first practice: decide IPv6 per subnet tier, not per VPC.
> The edge tier — load balancers and endpoints — stays dual-stack.
> The workload tier can become IPv6-only, when all dependencies are reachable over IPv6.
> That is why the VPC endpoints for ECR, logs and S3 are dual-stack. Then an IPv6-only task can still pull its image without NAT64.

### Slide 6 — Three options in one picture (5:00–6:30)

**On slide**
| | PrivateLink | VPC endpoints | VPC Lattice |
|---|---|---|---|
| Layer | L4 | L4 / route | L7 |
| Exposes | one NLB port | an AWS API | services / paths |
| Control | acceptance, SG | endpoint policy | auth policy, SigV4 |
| Caller identity | ✗ | (SourceVpce) | ✓ |

**Say**
> Before the numbers, the mental model.
> PrivateLink is layer four. You expose one port of one load balancer.
> VPC endpoints are the same technology for AWS services. The important part is the endpoint policy.
> VPC Lattice is layer seven. It is an application network with IAM authentication.
> Keep the last row in mind: does the provider know who is calling?

### Slide 7 — Speed ①: latency (6:30–8:30)

**On slide**
- Chart: p50 / p99 per path at 100 / 500 / 1000 rps (IPv6, keep-alive)
- Added latency vs baseline: PL `[RESULT]` ms, Lattice HTTP `[RESULT]` ms, Lattice HTTPS `[RESULT]` ms

**Say**
> First result: latency with keep-alive connections, over IPv6.
> The baseline is a client inside the provider VPC, calling the load balancer directly.
> PrivateLink added `[RESULT]` milliseconds at p50. Lattice added `[RESULT]`.
> *(If the gap is small:)* So yes, Lattice is a proxy, and you can see it. But the difference is `[RESULT]` milliseconds.
> *(If the gap is large:)* This is a real difference. For chatty, latency-critical calls, it matters.

### Slide 8 — Speed ②: connections matter more (8:30–10:00)

**On slide**
- New connection per request vs keep-alive
- TCP connect `[RESULT]` ms, TLS handshake `[RESULT]` ms
- IPv6 vs IPv4: `[RESULT]` (no meaningful difference?)

**Say**
> Now the same test, but with a new connection for every request.
> The TLS handshake alone costs `[RESULT]` milliseconds. That is bigger than the difference between the paths.
> So my second practice: fix connection reuse first, then choose the path.
> And IPv6 versus IPv4 on the same path? `[RESULT]`. IPv6 is not the slow option.

### Slide 9 ✂ — Speed ③: throughput and S3 (10:00–11:00)

**On slide**
- MB/s with 1 MiB objects per path
- S3 gateway vs interface endpoint: `[RESULT]`
- Gateway endpoint: free and now IPv6

**Say**
> For big objects, all paths delivered `[RESULT]`.
> For S3, the gateway endpoint and the interface endpoint were `[RESULT]`.
> The gateway endpoint is free, and since last year it works over IPv6. Use it as your default.

### Slide 10 — Speed ④: time to connect (11:00–12:00)

**On slide**
- New consumer → first successful call
- PrivateLink: endpoint `[RESULT]` s + **provider approval**
- Lattice: VPC association `[RESULT]` s
- "Speed" includes onboarding

**Say**
> Speed is not only milliseconds. How long does a new team wait before the first call?
> With PrivateLink, they create an endpoint, and then the provider must accept it. In my lab, `[RESULT]` seconds plus a human.
> With Lattice, they associate their VPC with the service network. `[RESULT]` seconds.
> The approval step is slower, but it is also a security feature. Which brings us to security.

### Slide 11 — Security ①: layers (12:00–13:00)

**On slide**
- Network: SG on endpoint / association
- Connectivity: acceptance / auth policy / endpoint policy
- Resource: bucket policy (`aws:SourceVpce`)
- One mistake should not open everything

**Say**
> I tested security as layers.
> The network layer is security groups — on the endpoint, or on the Lattice association.
> The connectivity layer is acceptance for PrivateLink, auth policies for Lattice, and endpoint policies for AWS services.
> The resource layer is, for example, a bucket policy.

### Slide 12 — Security ②: the matrix (13:00–15:00)

**On slide**
- Table from `results/probe.csv`: trusted / untrusted SG / not accepted / iam-required
- ✓ 200, ✗ 403, ✗ timeout
- Surprise: the S3 gateway endpoint has no SG

**Say**
> Here is the matrix. Same instance, same DNS. I only changed one thing per column.
> With an untrusted security group, PrivateLink and Lattice simply time out.
> Before the provider accepted the endpoint, PrivateLink did not work at all.
> With the Lattice policy set to "IAM required", anonymous calls got 403, and signed calls got 200.
> One surprise for many people: the S3 gateway endpoint is a route, not an ENI. There is no security group on it. You protect it with policies.

### Slide 13 — Security ③: what the provider sees (15:00–16:30)

**On slide**
- PrivateLink: `remote = NLB address`, nothing else
- Lattice: link-local source + `x-amzn-source-vpc` + `x-amzn-lattice-identity`
- → per-caller authorisation needs Lattice (or your own mTLS / tokens)

**Say**
> This is my favourite slide. What does the provider actually see?
> Behind PrivateLink, the container sees the load balancer's address. It does not know who called.
> Behind Lattice, it sees the source VPC, and with SigV4, the caller's IAM identity.
> So if your provider must decide per caller, PrivateLink pushes that work into your application. Lattice gives it to you in the network.

### Slide 14 ✂ — Security ④: data perimeter (16:30–17:30)

**On slide**
- Bucket allows the endpoint ✓ but endpoint policy does not list it → 403
- From the internet → 403
- Endpoint policy = where data can go; bucket policy = where data can come from

**Say**
> For AWS services, the endpoint policy is your exfiltration control.
> The "outside" bucket allowed my endpoint. But the endpoint policy did not list the bucket. Result: 403.
> And from the internet, the data bucket returns 403, because it only accepts requests through my endpoints.

### Slide 15 — How to choose (17:30–19:00)

**On slide**
- Need AWS APIs privately? → VPC endpoints (+ policies). Gateway for S3/DynamoDB.
- Expose one TCP service to many accounts, no caller identity needed? → PrivateLink
- Many services, many teams, per-caller auth, L7 routing? → VPC Lattice
- All of them: dual-stack edge, IPv6-only workloads, SG rules for both families, log the family

**Say**
> So how do I choose?
> For AWS APIs, use VPC endpoints, and write endpoint policies.
> To publish one TCP service to many consumers, PrivateLink is simple and fast.
> For many services between many teams, where you need to know the caller, use VPC Lattice.
> And for all of them: dual-stack at the edge, IPv6-only workloads when you can, security group rules for both families, and logs that show the address family.

### Slide 16 — Takeaways and repo (19:00–20:00)

**On slide**
- IPv6-first: subnet tiers, dual-stack endpoints
- Pick the path by "what you must know about the caller"
- Fix connection reuse before arguing about milliseconds
- Lab: github.com/MASAKIOKUDA-eng/AWS-ContainerNetwork-Research-handso (QR code)

**Say**
> Three takeaways.
> One: IPv6-first means designing per subnet tier, and making your dependencies reachable over IPv6.
> Two: choose the path by what you must know about the caller, not only by speed.
> Three: connection reuse matters more than the path.
> The lab is on GitHub. Please try it, break it, and tell me what you find. Thank you!

---

## Q&A preparation

| Likely question | Short answer |
|-----------------|--------------|
| Why not Transit Gateway? | TGW connects networks, not services. It needs unique routable addresses, and then you still need service-level controls. Good for broad connectivity, not the focus here. |
| Does Lattice support TCP? | Yes for VPC resources through resource configurations (e.g. databases), and TLS passthrough listeners. This lab measured HTTP/HTTPS services. |
| Lattice cost vs PrivateLink? | Different models: Lattice charges per service-hour, per GB and per request; PrivateLink per endpoint-AZ-hour and per GB plus the NLB. Calculate with your request profile. |
| Can PrivateLink pass the client IP? | With Proxy Protocol v2 on the target group, if the application parses it. |
| Is IPv6-only production ready on ECS? | Supported since Sep 2025. Check every dependency (ECR, logs, secrets, your own APIs) for IPv6 or dual-stack endpoints; ECS Exec is not supported in IPv6-only. |
| What about internet egress in IPv6? | Egress-only internet gateway for IPv6, NAT gateway for NAT64 with DNS64, and inspection with Network Firewall / GWLB — see the AWS blog on IPv6 inspection architectures. |

## Rehearsal checklist

- [ ] Every `[RESULT]` replaced, with the number of runs written in the footer
- [ ] Charts readable from the back row (font ≥ 24 pt, max 3 colours)
- [ ] Backup screenshots for every demo (no live demo dependency)
- [ ] QR code tested
- [ ] Speaking time: 18–19 min at a calm pace
