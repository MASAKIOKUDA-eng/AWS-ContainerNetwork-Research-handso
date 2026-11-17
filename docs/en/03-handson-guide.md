# 03. Hands-on guide: IPv6-first container networking — PrivateLink vs VPC endpoints vs VPC Lattice

[日本語](../ja/03-handson-guide.md)

> Prices and service behaviour change. Check the official pages in [references.md](references.md) on the day you run this.
> "Hypothesis" in these docs means a guess made before measuring, not a result.

## Contents

- [0. Rules for a fair comparison](#0-rules-for-a-fair-comparison)
- [1. Preparation](#1-preparation)
- [2. Build the environment](#2-build-the-environment)
- [3. Speed scenarios](#3-speed-scenarios)
- [4. Security scenarios](#4-security-scenarios)
- [5. Optional: IPv6-only workloads](#5-optional-ipv6-only-workloads)
- [6. Clean up](#6-clean-up)
- [Appendix A. Security checklist](#appendix-a-security-checklist)
- [Appendix B. Troubleshooting](#appendix-b-troubleshooting)

Architecture and design reasons: [02-architecture.md](02-architecture.md).

---

## 0. Rules for a fair comparison

- Same image, task size (0.5 vCPU / 1 GiB), task count (2) and subnets for `svc-pl` and `svc-lattice`
- Same load generator, same k6 script, **same offered load** (constant arrival rate) for every path
- Default address family for measurements: **IPv6 only** (`--ip onlyIPv6`); IPv4 is measured separately in S-3
- Repeat each measurement **at least 3 times** (5 for the numbers on slides) and use the median
- Record date/time, region, AZs of the load generator and of the tasks, instance type and image digests
- Run the paths in a **different order** in each repetition (avoid "the first run is always slower" bias)

## 1. Preparation

### 1.1 What you need

| Item | Detail |
|------|--------|
| AWS account | **A dedicated sandbox account** |
| Shell | **AWS CloudShell recommended** (no long-lived access keys on your laptop; bash, AWS CLI v2, jq, Docker and Python 3 are available) |
| Region | e.g. `ap-northeast-1`. Check that VPC Lattice, dual-stack endpoints for ECR / Logs / SSM, and S3 gateway endpoint IPv6 are available there |
| Permissions | Create IAM roles via CloudFormation. Remove them after the lab |
| Cost | Roughly a few USD per hour while everything runs (interface endpoints × AZs × 2 VPCs, NLB, Fargate, Lattice, EC2). **Delete everything the same day** |

### 1.2 Environment variables

```bash
export AWS_REGION=ap-northeast-1
export PREFIX=v6lab
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
git clone https://github.com/MASAKIOKUDA-eng/AWS-ContainerNetwork-Research-handso.git
cd AWS-ContainerNetwork-Research-handso
```

> The scripts assume `PREFIX=v6lab`-style names (3–16 lowercase letters, digits, `-`).

### 1.3 Budget alert

```bash
aws budgets create-budget --account-id "$ACCOUNT_ID" \
  --budget '{"BudgetName":"'"$PREFIX"'","BudgetLimit":{"Amount":"30","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"<your-mail>"}]}]'
```

All resources carry the tag `Project=<prefix>`. Activate it as a cost allocation tag if you want per-lab cost in Cost Explorer.

---

## 2. Build the environment

### 2.1 VPCs (consumer and provider)

```bash
for role in consumer provider; do
  aws cloudformation deploy --stack-name "$PREFIX-$role-vpc" \
    --template-file cfn/01-vpc.yaml \
    --parameter-overrides Prefix="$PREFIX" Role="$role" WorkloadIpMode=dualstack \
    --capabilities CAPABILITY_IAM
done
```

| Resource | Point |
|----------|-------|
| VPC `10.0.0.0/16` **in both** + Amazon-provided IPv6 /56 | Overlapping IPv4 on purpose (X-6) |
| Edge subnets ×2 (dual-stack) | NLB and VPC endpoints live here |
| Workload subnets ×2 (`dualstack` or `ipv6only`) | ECS tasks and the load generator |
| Route table with local routes only | No IGW / NAT / EIGW: nothing can leave except via the paths under test |
| Dual-stack interface endpoints | ECR API / ECR DKR / Logs (+ SSM ×3 in the consumer) |
| S3 gateway endpoint (`IpAddressType: dualstack`) | **Endpoint policy**: ECR layer bucket, AL2023 repos, and (consumer) the lab data bucket only |
| Flow Logs | Custom format with `pkt-srcaddr`, `pkt-dstaddr`, `flow-direction`, `traffic-path` |

> If the stack fails on `IpAddressType` of the S3 gateway endpoint or an interface endpoint, the region does not support IPv6 for it yet.
> Re-deploy with `S3GatewayIpAddressType=ipv4` / `EndpointIpAddressType=ipv4` and note it in the results (IPv6-only mode will not work then).

### 2.2 Provider platform

```bash
aws cloudformation deploy --stack-name "$PREFIX-provider-platform" \
  --template-file cfn/02-provider-platform.yaml \
  --parameter-overrides Prefix="$PREFIX" ProviderWorkloadIpMode=dualstack LatticeAuthMode=vpc-only \
  --capabilities CAPABILITY_IAM
```

| Resource | Point |
|----------|-------|
| Internal NLB `IpAddressType: dualstack` + TCP 80 → TG (ip, 8080) | Target group family = IPv4 in dual-stack mode, IPv6 in IPv6-only mode |
| VPC endpoint service | `AcceptanceRequired: true`, `SupportedIpAddressTypes: [ipv4, ipv6]`, allowed principal = this account only |
| Lattice service network (`AWS_IAM`) | Auth policy: **only from the consumer VPC** |
| Lattice service (`AWS_IAM`) + HTTP 80 / HTTPS 443 listeners | Auth policy switch `LatticeAuthMode`: `vpc-only` or `iam-required` |
| Lattice target group (IP, HTTP 8080) | ECS registers the tasks (no load balancer) |
| Lattice access logs → CloudWatch Logs | Auth decisions, caller principal, source VPC, target address |
| ECR ×2 (immutable tags, scan on push, KMS), ECS cluster (Container Insights enhanced) | |
| IAM: task execution role, task role **without permissions**, ECS infrastructure role for Lattice | |

### 2.3 Container images

Build in CloudShell (or any place with Docker).

```bash
out() { aws cloudformation describe-stacks --stack-name "$PREFIX-$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
REPO_NB=$(out provider-platform NetbenchRepoUri)
REPO_LG=$(out provider-platform LoadgenRepoUri)
aws ecr get-login-password | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

# Pin the base images by digest for the numbers you publish (--build-arg BASE=...@sha256:...)
docker build --platform linux/amd64 -t "$REPO_NB:v1" docker/netbench
docker build --platform linux/amd64 -t "$REPO_LG:v1" -f docker/loadgen/Dockerfile .
docker push "$REPO_NB:v1"
docker push "$REPO_LG:v1"

NB_DIGEST=$(aws ecr describe-images --repository-name "$PREFIX/netbench" --image-ids imageTag=v1 --query 'imageDetails[0].imageDigest' --output text)
LG_DIGEST=$(aws ecr describe-images --repository-name "$PREFIX/loadgen"  --image-ids imageTag=v1 --query 'imageDetails[0].imageDigest' --output text)
export NETBENCH_IMAGE="$REPO_NB@$NB_DIGEST"
export LOADGEN_IMAGE="$REPO_LG@$LG_DIGEST"
```

Check the scan results and fix Critical / High findings before you continue.

```bash
for r in netbench loadgen; do
  aws ecr describe-image-scan-findings --repository-name "$PREFIX/$r" --image-id imageTag=v1 \
    --query 'imageScanFindings.findingSeverityCounts'
done
```

### 2.4 Provider services

```bash
aws cloudformation deploy --stack-name "$PREFIX-provider-services" \
  --template-file cfn/03-provider-services.yaml \
  --parameter-overrides Prefix="$PREFIX" NetbenchImage="$NETBENCH_IMAGE" LoadgenImage="$LOADGEN_IMAGE"
```

- `svc-pl` registers its tasks in the NLB target group (`LoadBalancers`)
- `svc-lattice` registers its tasks in the Lattice target group (`VpcLatticeConfigurations`, port name `http`)

```bash
aws ecs describe-services --cluster "$PREFIX" --services svc-pl svc-lattice \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount}' --output table
aws vpc-lattice list-targets --target-group-identifier "$(out provider-platform LatticeTgArn)" \
  --query 'items[].{ip:id,port:port,status:status}' --output table
```

### 2.5 Consumer side

```bash
aws cloudformation deploy --stack-name "$PREFIX-consumer" \
  --template-file cfn/04-consumer.yaml \
  --parameter-overrides Prefix="$PREFIX" \
  --capabilities CAPABILITY_IAM
```

Then, as the **provider**, approve the PrivateLink connection (security control + S-6 timing), and upload the S3 test objects:

```bash
./scripts/accept-endpoint.sh
./scripts/upload-test-objects.sh
python3 scripts/measure-provisioning.py --prefix "$PREFIX" --csv results/provisioning.csv
```

> Before you accept, run the probe in 2.7 once: the PrivateLink path must **not** work (`pendingAcceptance`).
> That is security test X-2.

### 2.6 Get into the load generator

In CloudShell, print the values the load generator needs (it cannot call the CloudFormation API — there is no route):

```bash
./scripts/get-endpoints.sh
LOADGEN_ID=$(out consumer LoadgenInstanceId)
aws ssm start-session --target "$LOADGEN_ID"
```

On the load generator:

```bash
sudo usermod -aG docker ssm-user && exec sudo -iu ssm-user   # first time only
# paste the "export ..." lines printed by get-endpoints.sh here (including LOADGEN_IMAGE)
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${LOADGEN_IMAGE%%/*}"
docker pull "$LOADGEN_IMAGE"
mkdir -p ~/results
lg() { docker run --rm --network host --read-only --tmpfs /tmp --cap-drop ALL \
         --user "$(id -u):$(id -g)" -v "$HOME/results:/work/results" \
         -e AWS_REGION -e PL_DNS -e LATTICE_DNS -e S3IF_DNS -e DATA_BUCKET -e OUTSIDE_BUCKET \
         "$LOADGEN_IMAGE" "$@"; }
lg k6 version
```

### 2.7 Smoke test (all paths, IPv6 and IPv4)

```bash
lg probe-paths.sh --context trusted
```

Expected (dual-stack mode, `LatticeAuthMode=vpc-only`):

| target | IPv6 | IPv4 | provider saw |
|--------|------|------|--------------|
| pl-http | 200 | 200 | `remote` = an NLB address, no Lattice headers |
| lattice-http / lattice-https | 200 | 200 | `remote` = Lattice link-local, `src_vpc` = consumer VPC ID |
| lattice-https-sigv4 | 200 | 200 | `identity` = the load generator role |
| s3gw-data / s3if-data | 200 | 200 | — |
| s3gw-outside / s3if-outside | **403** | **403** | — (blocked by the endpoint policy) |

> If the IPv4 column shows `timeout/refused` for S3 or Lattice in IPv6-only mode, that is the expected behaviour of an IPv6-only subnet.

---

## 3. Speed scenarios

Details, hypotheses and what to look at: [04-speed-scenarios.md](04-speed-scenarios.md). Quick reference:

```bash
# S-1 latency, keep-alive, IPv6 (repeat x3-5, change the order each time)
lg run-k6.sh --label privatelink   --url "http://$PL_DNS/1k"
lg run-k6.sh --label lattice-http  --url "http://$LATTICE_DNS/1k"
lg run-k6.sh --label lattice-https --url "https://$LATTICE_DNS/1k"
lg run-k6.sh --label s3-gateway    --url "https://$DATA_BUCKET.s3.dualstack.$AWS_REGION.amazonaws.com/1k" --rates "100 500"
lg run-k6.sh --label s3-interface  --url "https://bucket.${S3IF_DNS#\*.}/$DATA_BUCKET/1k" --rates "100 500"

# S-2 new connection per request
lg run-k6.sh --label privatelink   --url "http://$PL_DNS/1k"         --reuse no --rates "100 300"
lg run-k6.sh --label lattice-https --url "https://$LATTICE_DNS/1k"   --reuse no --rates "100 300"

# S-3 IPv4 vs IPv6 on the same path
lg run-k6.sh --label privatelink   --url "http://$PL_DNS/1k" --ip onlyIPv4
lg run-k6.sh --label lattice-http  --url "http://$LATTICE_DNS/1k" --ip onlyIPv4

# S-4 throughput (1 MiB)
lg run-k6.sh --label privatelink   --url "http://$PL_DNS/1m"        --mode throughput --vus 32
lg run-k6.sh --label lattice-http  --url "http://$LATTICE_DNS/1m"   --mode throughput --vus 32
lg run-k6.sh --label s3-gateway    --url "https://$DATA_BUCKET.s3.dualstack.$AWS_REGION.amazonaws.com/1m" --mode throughput --vus 32
lg run-k6.sh --label s3-interface  --url "https://bucket.${S3IF_DNS#\*.}/$DATA_BUCKET/1m" --mode throughput --vus 32
```

S-0 (baseline in the provider VPC) and S-6 (time to connect) run from CloudShell:

```bash
./scripts/run-baseline.sh "100 500 1000" onlyIPv6
python3 scripts/measure-provisioning.py --prefix "$PREFIX"
```

Copy `~/results/k6.csv` from the load generator to CloudShell (it is small: `cat` it in the session and paste), append the baseline lines, then:

```bash
python3 scripts/summarize.py results/k6.csv --pivot total_p50_ms
python3 scripts/summarize.py results/k6.csv --pivot total_p99_ms
python3 scripts/summarize.py results/k6.csv --pivot throughput_MBps
```

---

## 4. Security scenarios

Details and the expected matrix: [05-security-scenarios.md](05-security-scenarios.md). Quick reference:

| ID | What | How |
|----|------|-----|
| X-1 | Network layer: an untrusted client in the same VPC | `./scripts/swap-client-sg.sh untrusted` → `lg probe-paths.sh --context untrusted` → `./scripts/swap-client-sg.sh trusted` |
| X-2 | PrivateLink acceptance | probe before `accept-endpoint.sh` |
| X-3 | Lattice auth policy: anonymous vs SigV4 | redeploy 02 with `LatticeAuthMode=iam-required` → `lg probe-paths.sh --context iam-required` |
| X-4 | What the provider sees | `./scripts/source-ip-report.sh 60` |
| X-5 | Data perimeter with endpoint + bucket policies | `s3*-outside` rows in the probe, and `curl` from CloudShell (internet) |
| X-6 | Overlapping IPv4 | both VPCs are `10.0.0.0/16` — and everything above worked |
| X-7 | Exposure review | [05-security-scenarios.md](05-security-scenarios.md#x-7-exposure-review-desk-check) |

---

## 5. Optional: IPv6-only workloads

Switch the workload subnets to IPv6-only. Subnets cannot change type in place, so **delete in reverse order and redeploy** with `WorkloadIpMode=ipv6only` (and `ProviderWorkloadIpMode=ipv6only` for stack 02):

```bash
# after section 6 (clean up) for stacks 04, 03, 02 and both VPC stacks:
for role in consumer provider; do
  aws cloudformation deploy --stack-name "$PREFIX-$role-vpc" --template-file cfn/01-vpc.yaml \
    --parameter-overrides Prefix="$PREFIX" Role="$role" WorkloadIpMode=ipv6only --capabilities CAPABILITY_IAM
done
# then 2.2 with ProviderWorkloadIpMode=ipv6only, 2.4, 2.5 as before (images stay in ECR only if you keep stack 02)
```

What changes:

- Tasks get only an IPv6 address; NLB / Lattice target groups become `ipv6` / `IPV6` → **end-to-end IPv6**
- ECR, Logs and SSM must be reachable over IPv6 → that is why the endpoints are dual-stack (practice 2)
- The load generator EC2 is IPv6-only: `--ip onlyIPv4` measurements fail by design
- Compare S-1 between dual-stack and IPv6-only (does IPv6 to the target change anything?)

> ECS Exec is not supported for IPv6-only tasks — another reason this lab does not use it.

---

## 6. Clean up

```bash
aws cloudformation delete-stack --stack-name "$PREFIX-consumer"
aws cloudformation wait stack-delete-complete --stack-name "$PREFIX-consumer"
aws cloudformation delete-stack --stack-name "$PREFIX-provider-services"
aws cloudformation wait stack-delete-complete --stack-name "$PREFIX-provider-services"
aws cloudformation delete-stack --stack-name "$PREFIX-provider-platform"
aws cloudformation wait stack-delete-complete --stack-name "$PREFIX-provider-platform"
for role in consumer provider; do aws cloudformation delete-stack --stack-name "$PREFIX-$role-vpc"; done
```

- The S3 buckets must be **empty** before stack 04 can delete them:
  `aws s3 rm "s3://$PREFIX-data-$ACCOUNT_ID" --recursive && aws s3 rm "s3://$PREFIX-outside-$ACCOUNT_ID" --recursive`
- ECR repositories are deleted with their images (`EmptyOnDelete`)
- Check that nothing is left: `aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=$PREFIX --query 'ResourceTagMappingList[].ResourceARN'`
- Delete the budget if you created it only for this lab

---

## Appendix A. Security checklist

- [ ] A dedicated sandbox account is used
- [ ] No IGW / NAT / EIGW in either VPC, no public IPs anywhere
- [ ] NLB is internal; the endpoint service requires acceptance and allows only this account
- [ ] Interface endpoint / Lattice association / S3 interface endpoint SGs allow only `TrustedClientSg`
- [ ] Lattice service network and service have auth policies (`AWS_IAM`), access logs are on
- [ ] S3 gateway and interface endpoint policies list only the buckets that are needed, read-only
- [ ] Bucket policies allow reads only via `aws:SourceVpce`, deny non-TLS; Block Public Access is on
- [ ] EC2: IMDSv2 required, hop limit 1, SSM only (no SSH, no inbound rules), encrypted EBS
- [ ] Containers: non-root, read-only root FS, all capabilities dropped, no ECS Exec, task role without permissions
- [ ] Images scanned in ECR and referenced by digest (base images pinned by digest too)
- [ ] Credentials for the SigV4 test are read from IMDS inside the container and passed to curl via stdin
- [ ] Log retention set (7 days by default)
- [ ] Budget alert set, everything deleted on the same day

## Appendix B. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `01-vpc` fails on `IpAddressType` | No IPv6 support for that endpoint in the region | Use `EndpointIpAddressType=ipv4` / `S3GatewayIpAddressType=ipv4` (dual-stack mode only) |
| Tasks stuck in `PROVISIONING` / image pull fails | ECR / S3 endpoint missing, endpoint policy too strict | Check the ECR endpoints and the `EcrImageLayers` statement of the S3 gateway endpoint policy |
| `dnf` fails in the load generator user data | S3 gateway endpoint policy | The `al2023-repos-<region>-*` statement must be there |
| PrivateLink returns `timeout/refused` | Connection not accepted yet, or the client SG is untrusted | `./scripts/accept-endpoint.sh`, check the SG |
| Lattice returns 403 | Auth policy: source VPC or `iam-required` | Check `LatticeAuthMode`, the access log `authDeniedReason` |
| Lattice targets `UNHEALTHY` | Task SG misses the Lattice ranges | `169.254.171.0/24` and `fd00:ec2:80::/64` on 8080 |
| S3 returns 403 for the data bucket | Request did not go through a consumer endpoint, or the object is missing | Use the dual-stack S3 name / the vpce name; run `upload-test-objects.sh` |
| k6 `dropped_iterations` > 0 | Load generator limit | Use a larger instance or lower rates |
| `run-baseline.sh` prints nothing | The task failed before k6 ran | `aws ecs describe-tasks ... --query 'tasks[0].stoppedReason'` |
