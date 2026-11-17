# AWS Container Network Research — IPv6-first hands-on

[日本語版 README](README.ja.md)

> Talk: **IPv6-first container network design practices** — JAWS-UG Yamanashi, 2026-11-21 (English session)

A hands-on lab that runs the **same ECS service** behind **AWS PrivateLink** and **Amazon VPC Lattice**, plus **VPC endpoints for AWS services (S3 gateway / interface)**, in **IPv6-first** VPCs, and compares them on two axes:

| # | Axis | Questions |
|---|------|-----------|
| 1 | **Speed** | How much latency does each path add (p50 / p99)? What do new connections and TLS cost? Is IPv6 slower than IPv4? How long until a new consumer can call? |
| 2 | **Security** | Who can reach each path and who decides? What does the provider learn about the caller? How do endpoint and bucket policies form a data perimeter? |

## Paths compared

| ID | Path | Client → |
|----|------|----------|
| ① | **PrivateLink** | dual-stack interface endpoint → endpoint service (acceptance required) → dual-stack internal NLB → ECS `svc-pl` |
| ② | **VPC Lattice** | service network VPC association (SG) → Lattice service (HTTP / HTTPS, IAM auth policy) → ECS `svc-lattice` |
| ③ | **VPC endpoints** | S3 gateway endpoint (dual-stack) and S3 interface endpoint (dual-stack), both with endpoint policies |
| S-0 | Baseline | k6 inside the provider VPC → NLB (no PrivateLink hop) |

Both VPCs use **`10.0.0.0/16`** on purpose, and neither has an internet gateway, NAT or egress-only IGW.

## Documents

| | English | 日本語 |
|---|---|---|
| Overview, key messages, hypotheses | [docs/en/01-overview.md](docs/en/01-overview.md) | [docs/ja/01-overview.md](docs/ja/01-overview.md) |
| Architecture & IPv6 design practices | [docs/en/02-architecture.md](docs/en/02-architecture.md) | [docs/ja/02-architecture.md](docs/ja/02-architecture.md) |
| **Hands-on guide** | [docs/en/03-handson-guide.md](docs/en/03-handson-guide.md) | [docs/ja/03-handson-guide.md](docs/ja/03-handson-guide.md) |
| Speed scenarios (S-0 … S-6) | [docs/en/04-speed-scenarios.md](docs/en/04-speed-scenarios.md) | [docs/ja/04-speed-scenarios.md](docs/ja/04-speed-scenarios.md) |
| Security scenarios (X-1 … X-7) | [docs/en/05-security-scenarios.md](docs/en/05-security-scenarios.md) | [docs/ja/05-security-scenarios.md](docs/ja/05-security-scenarios.md) |
| Talk script (20 min, 10-min cut) | [docs/en/06-talk-script-en.md](docs/en/06-talk-script-en.md) | [docs/ja/06-talk-script.md](docs/ja/06-talk-script.md) |
| Event runbook | [docs/en/07-event-runbook.md](docs/en/07-event-runbook.md) | [docs/ja/07-event-runbook.md](docs/ja/07-event-runbook.md) |
| Result template (for slides) | [docs/en/result-template.md](docs/en/result-template.md) | [docs/ja/result-template.md](docs/ja/result-template.md) |
| References | [docs/en/references.md](docs/en/references.md) | [docs/ja/references.md](docs/ja/references.md) |

## Repository layout

```
.
├── README.md / README.ja.md
├── cfn/
│   ├── 01-vpc.yaml                  VPC (deploy twice: consumer / provider), dual-stack endpoints, Flow Logs
│   ├── 02-provider-platform.yaml    ECR, ECS cluster, IAM, NLB + endpoint service, VPC Lattice
│   ├── 03-provider-services.yaml    task definition, svc-pl, svc-lattice, baseline task
│   └── 04-consumer.yaml             load generator, PrivateLink endpoint, Lattice association, S3 + endpoints
├── docker/
│   ├── netbench/                    target: nginx (non-root, IPv4+IPv6, /whoami shows what the provider sees)
│   └── loadgen/                     k6 + curl + dig + scripts
├── scripts/
│   ├── k6-load.js / run-k6.sh       latency / throughput (IPv6 or IPv4, keep-alive or not)
│   ├── probe-paths.sh               reachability + identity probe for every path and family
│   ├── run-baseline.sh              S-0 baseline as a Fargate task in the provider VPC
│   ├── accept-endpoint.sh           provider-side PrivateLink acceptance (+ timing)
│   ├── measure-provisioning.py      S-6 time to connect a new consumer
│   ├── swap-client-sg.sh            trusted / untrusted client SG (X-1)
│   ├── source-ip-report.sh          what the provider saw (Logs Insights)
│   ├── upload-test-objects.sh       S3 test objects
│   ├── get-endpoints.sh             values to paste into the load generator
│   └── summarize.py                 Markdown tables for the slides
├── docs/en, docs/ja                 scenarios, talk script, runbook (English / Japanese)
└── results/                         measurement output (not committed)
```

## Quick start

```bash
export AWS_REGION=ap-northeast-1 PREFIX=v6lab
for role in consumer provider; do
  aws cloudformation deploy --stack-name "$PREFIX-$role-vpc" --template-file cfn/01-vpc.yaml \
    --parameter-overrides Prefix=$PREFIX Role=$role --capabilities CAPABILITY_IAM
done
aws cloudformation deploy --stack-name "$PREFIX-provider-platform" --template-file cfn/02-provider-platform.yaml \
  --parameter-overrides Prefix=$PREFIX --capabilities CAPABILITY_IAM
# build & push images, then 03 and 04 — see the hands-on guide
```

Full steps: [docs/en/03-handson-guide.md](docs/en/03-handson-guide.md).

## Security policy

- Run in a **dedicated sandbox account**; delete everything the same day
- **No internet path**: no IGW / NAT / EIGW, no public IPs, internal NLB only
- Defence in depth on every path: SG on the endpoint / association → acceptance / auth policy / endpoint policy → bucket policy
- PrivateLink endpoint service: acceptance required, allowed principal = this account only
- VPC Lattice: `AWS_IAM` auth on the service network and on the service, access logs on
- S3: Block Public Access on, reads only via `aws:SourceVpce`, TLS enforced, endpoint policies list only the needed buckets
- EC2: IMDSv2 required (hop limit 1), SSM only (no SSH, no inbound rules), encrypted EBS
- Containers: non-root, read-only root FS, all Linux capabilities dropped, no ECS Exec, task role without permissions
- Images scanned on push (ECR, KMS, immutable tags) and referenced by digest
- The SigV4 test reads instance-role credentials from IMDSv2 inside the container and passes them to curl through stdin
- CI (`.github/workflows/validate.yml`) runs cfn-lint, shellcheck and checkov with a read-only token

Accepted checkov findings (lab scope, short-lived):

| Check | Why it is accepted here | For production |
|-------|-------------------------|----------------|
| CKV_AWS_158 log groups without a KMS key | 7-day retention, no secrets in the logs | Use a customer managed KMS key |
| CKV_AWS_18 / CKV_AWS_21 S3 access logging / versioning | Two buckets with random test data, deleted the same day | Enable both (or CloudTrail data events) |
| CKV_AWS_91 NLB access logs | NLB access logs only cover TLS listeners; this NLB is TCP | Enable with a TLS listener |
| CKV_DOCKER_2 / CKV_DOCKER_7 HEALTHCHECK / base image tag | Health is checked by the NLB / Lattice; the guide pins base images by digest at build time | Pin by digest in the Dockerfile |

## Cost

Interface endpoints (per AZ, two VPCs), the NLB, a Lattice service, four Fargate tasks and one EC2 instance run while the lab is up. Expect a few USD per hour; check current pricing and delete the stacks after measuring.

## License

Apache License 2.0
