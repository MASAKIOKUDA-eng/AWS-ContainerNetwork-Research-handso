# 05. Security scenarios

[日本語](../ja/05-security-scenarios.md)

The question for every path: **who can reach it, who decides, and what does the provider learn about the caller?**

The probe (`lg probe-paths.sh --context <name>`) calls every target over IPv6 and IPv4 and writes one row per target and family to `results/probe.csv`. It only performs GET requests on lab resources.

## Control layers in the lab

| Layer | PrivateLink ① | VPC Lattice ② | VPC endpoints ③ (S3) |
|-------|---------------|---------------|----------------------|
| Network (consumer side) | SG on the interface endpoint (`PrivateLinkEndpointSg`) | SG on the VPC association (`LatticeAssociationSg`) | SG on the interface endpoint; route table for the gateway endpoint |
| Connectivity | Endpoint service: allowed principals + **acceptance** | **Auth policy** on the service network (source VPC) and on the service (anonymous / SigV4) | **Endpoint policy** (which buckets, which actions) |
| Resource | (the app itself) | (the app itself) + identity headers | **Bucket policy** with `aws:SourceVpce` |
| Provider network | NLB SG (`EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic`), task SG from NLB SG | task SG from Lattice link-local ranges | — |
| Logs | Flow Logs, provider access log (`remote` = NLB) | **Lattice access log** (principal, source VPC, auth denial), provider access log | Flow Logs, (CloudTrail data events if enabled) |

## X-1 Untrusted client in the same VPC (network layer)

Same instance, same DNS, same routes — only the security group changes.

```bash
# CloudShell
./scripts/swap-client-sg.sh untrusted
# load generator
lg probe-paths.sh --context untrusted
# CloudShell — always switch back
./scripts/swap-client-sg.sh trusted
```

| target | trusted | untrusted | Why |
|--------|---------|-----------|-----|
| pl-http | 200 | timeout | interface endpoint SG allows only `TrustedClientSg` |
| lattice-http / -https | 200 | timeout | association SG allows only `TrustedClientSg` |
| s3if-data | 200 | timeout | S3 interface endpoint SG |
| s3gw-data | 200 | **200** | the gateway endpoint is a route, not an ENI: **no SG on it**. Control it with the endpoint policy, the bucket policy, or the client SG egress (prefix list) |

> Talking point: "gateway endpoint = route table entry" is why its controls are policies, not SGs.

## X-2 PrivateLink acceptance (connectivity layer)

Run the probe **before** `./scripts/accept-endpoint.sh`:

- `pl-http` → timeout / refused while the endpoint is `pendingAcceptance`
- After acceptance → 200

> **Negative DNS caching.** While the endpoint is `pendingAcceptance`, its DNS name does not exist yet (NXDOMAIN, `A=0 AAAA=0` in the probe).
> The VPC resolver caches that answer, so after acceptance the name kept failing inside the consumer VPC for about 9.7 minutes in the
> 2026-11-19 run, while it already resolved from outside. Wait for `dig +short AAAA $PL_DNS` on the load generator before the speed scenarios.
> Design lesson: a consumer that looks up the name *before* approval waits for the negative-cache TTL as well as for the human approval (S-6).

Also check `aws ec2 describe-vpc-endpoint-service-permissions --service-id <id>`: only this account is allowed. A consumer from another account would not even be able to create the endpoint.

## X-3 Lattice auth policy: anonymous vs SigV4

```bash
# CloudShell: require signed callers of this account
npm run deploy -- -c latticeAuthMode=iam-required
# load generator
lg probe-paths.sh --context iam-required
```

| target | vpc-only | iam-required |
|--------|----------|--------------|
| lattice-http (anonymous) | 200 | **403** |
| lattice-https (anonymous) | 200 | **403** |
| lattice-https-sigv4 (load generator role) | 200 | 200 |

- Check the Lattice access log: `authDeniedReason` for the 403s, `callerPrincipal` for the signed request.
- Run `npm run deploy` (defaults: `vpc-only`) again before the speed scenarios (signing is not part of the k6 test).

## X-4 What does the provider see?

```bash
./scripts/source-ip-report.sh 60
```

| Path | `remote` at the task | Extra information |
|------|----------------------|-------------------|
| PrivateLink | an **NLB address** in the provider VPC (client IP is not preserved through PrivateLink) | none. Proxy Protocol v2 on the target group can carry the endpoint and client address if the app supports it |
| VPC Lattice | a **Lattice link-local address** (`169.254.171.x` / `fd00:ec2:80::…`) | `x-forwarded-for`, `x-amzn-source-vpc`, and with SigV4 `x-amzn-lattice-identity` (principal) |

> Design implication: if the provider must authorise **per caller**, PrivateLink pushes that into the app (mTLS, tokens). Lattice gives you identity at the network layer.

## X-5 Data perimeter with endpoint + bucket policies

| Request | Result | Which control |
|---------|--------|---------------|
| `s3gw-data`, `s3if-data` from the consumer | 200 | endpoint policy allows the data bucket, bucket policy allows the endpoint |
| `s3gw-outside`, `s3if-outside` from the consumer | **403** | the bucket policy **allows** the endpoint, but the **endpoint policy** does not list the bucket |
| data bucket from CloudShell (internet) | **403** | bucket policy: only via `aws:SourceVpce` |

```bash
# CloudShell (internet path)
curl -s -o /dev/null -w '%{http_code}\n' "https://$PREFIX-data-$ACCOUNT_ID.s3.dualstack.$AWS_REGION.amazonaws.com/1k"
```

> Talking point: the endpoint policy controls *where data can go from this VPC* (exfiltration), the bucket policy controls *where data can be read from* (resource perimeter). You want both.

## X-6 Overlapping IPv4

Both VPCs are `10.0.0.0/16`. Peering or Transit Gateway could not connect them; all three paths work because none of them routes between the VPC CIDRs. With IPv6 the address space is globally unique anyway — but the connectivity layer is what makes the *IPv4 leftovers* irrelevant.

## X-7 Exposure review (desk check)

Fill this in with the team, using the templates as evidence:

| Question | PrivateLink | VPC Lattice | VPC endpoints |
|----------|-------------|-------------|---------------|
| What exactly is exposed to the consumer? | one NLB listener (TCP 80) | services in the network, per listener / path | the AWS service API, limited by the endpoint policy |
| Can the consumer reach anything else in the provider VPC? | No | No | n/a |
| Can the provider initiate connections to the consumer? | No (unidirectional) | No (unless the consumer also publishes a service) | n/a |
| Who approves a new consumer? | provider (acceptance) + allowed principals | service network owner (association / RAM share) + auth policy | the consumer itself (endpoint policy) + resource owner (bucket policy) |
| Can you write a rule per caller identity? | No (app level) | Yes (auth policy conditions on principal, tags, org) | Yes for AWS APIs (endpoint policy conditions) |
| Where do you see denials? | Flow Logs (`REJECT`), app logs | Lattice access log | CloudTrail (`AccessDenied`), S3 server access logs |
| IPv6 specifics | NLB dual-stack + `SupportedIpAddressTypes` | SGs must allow `fd00:ec2:80::/64` | dual-stack names (`s3.dualstack…`), endpoint `IpAddressType` |

## Recording results

`results/probe.csv` has one row per context × target × family. For the slide, pivot it to "target × context" with ✓ (2xx), ✗403, ✗timeout — see [result-template.md](result-template.md).
