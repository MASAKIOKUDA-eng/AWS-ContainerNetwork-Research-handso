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
- Record date/time, region, AZs of the load generator and of the tasks, instance type, image tags and the cdkd version
- Run the paths in a **different order** in each repetition (avoid "the first run is always slower" bias)

## 1. Preparation

### 1.1 What you need

| Item | Detail |
|------|--------|
| AWS account | **A dedicated sandbox account** |
| Shell | **AWS CloudShell recommended** (no long-lived access keys on your laptop; bash, AWS CLI v2, jq, Docker, Python 3 and Node.js are available — Node.js must be **22.12+** for cdkd) |
| Region | e.g. `ap-northeast-1`. Check that VPC Lattice, dual-stack endpoints for ECR / Logs / SSM, and S3 gateway endpoint IPv6 are available there |
| Permissions | Create IAM roles, VPC, ECS, ELB, VPC Lattice, S3, EC2 resources directly (cdkd calls the service APIs, not CloudFormation). Remove them after the lab |
| Cost | Roughly a few USD per hour while everything runs (interface endpoints × AZs × 2 VPCs, NLB, Fargate, Lattice, EC2). **Delete everything the same day** |

### 1.2 Get the code

```bash
export AWS_REGION=ap-northeast-1
export PREFIX=v6lab            # must match the "prefix" context (cdk.json) if you change it
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
git clone https://github.com/MASAKIOKUDA-eng/AWS-ContainerNetwork-Research-handso.git
cd AWS-ContainerNetwork-Research-handso
npm ci
npm test        # security / IPv6 invariants on the synthesized templates (no AWS calls)
```

> The scripts assume `PREFIX=v6lab`-style names (3–16 lowercase letters, digits, `-`).

### 1.3 Budget alert

```bash
aws budgets create-budget --account-id "$ACCOUNT_ID" \
  --budget '{"BudgetName":"'"$PREFIX"'","BudgetLimit":{"Amount":"30","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"<your-mail>"}]}]'
```

All resources carry the tag `Project=<prefix>`. Activate it as a cost allocation tag if you want per-lab cost in Cost Explorer.

### 1.4 Turn on image scanning (once per account / region)

cdkd builds the two images and pushes them to its own ECR repository. Scan every push in the registry:

```bash
aws ecr put-registry-scanning-configuration --scan-type BASIC \
  --rules '[{"scanFrequency":"SCAN_ON_PUSH","repositoryFilters":[{"filter":"*","filterType":"WILDCARD"}]}]'
```

---

## 2. Build the environment

The infrastructure is a CDK app (`bin/app.ts`, `lib/*.ts`) deployed with **cdkd** — no CloudFormation stacks, direct AWS SDK calls.
The same app deploys with the AWS CDK CLI too (`npm run cdk:deploy`, needs `cdk bootstrap`).

### 2.1 Bootstrap and review

```bash
npx cdkd bootstrap     # once per account / region: cdkd state bucket + asset bucket + container-asset ECR repo
npm run synth          # templates in cdk.out/ (also useful as design documentation)
npm run diff           # what will be created
```

Settings are CDK **context** (defaults in `cdk.json`, override with `-c key=value`). Invalid values stop the synth.

| Context | Default | Meaning |
|---------|---------|---------|
| `prefix` | `v6lab` | stack / resource name prefix |
| `workloadIpMode` | `dualstack` | `ipv6only` = IPv6-only workload subnets (section 5) |
| `latticeAuthMode` | `vpc-only` | `iam-required` = only SigV4-signed callers of this account (X-3) |
| `endpointIpAddressType` / `s3GatewayIpAddressType` | `dualstack` | `ipv4` = fallback for regions without IPv6 support |
| `nlbEnforceSgOnPrivateLink` | `off` | evaluate the NLB SG for PrivateLink traffic |
| `desiredCount` / `taskCpu` / `taskMemory` | `2` / `512` / `1024` | size of `svc-pl` and `svc-lattice` |
| `cpuArchitecture` | `X86_64` | `ARM64` builds arm64 images and uses Graviton Fargate |
| `loadgenInstanceType` | `c7i.xlarge` | Nitro type (required in IPv6-only subnets) |

### 2.2 Deploy

```bash
npm run deploy
```

`scripts/deploy.sh` runs `cdkd deploy --all --outputs-file cdk-outputs.json`, writes a log to `deploy-logs/` (account ID masked) and adds a line with the duration to `deploy-logs/HISTORY.md`. The other scripts read their values from `cdk-outputs.json` (kept local, it is in `.gitignore`).

The four stacks, in dependency order:

| Stack | Main resources | Point |
|-------|----------------|-------|
| `v6lab-consumer-vpc` / `v6lab-provider-vpc` | VPC `10.0.0.0/16` **in both** + Amazon-provided IPv6 /56 | Overlapping IPv4 on purpose (X-6) |
| | Edge subnets ×2 (dual-stack) / workload subnets ×2 (`workloadIpMode`) | NLB and endpoints at the edge; tasks and the load generator in the workload tier |
| | Route table with local routes only | No IGW / NAT / EIGW: nothing can leave except via the paths under test |
| | Dual-stack interface endpoints ECR API / ECR DKR / Logs (+ SSM ×3 in the consumer) | IPv6-only tasks can still pull images and ship logs |
| | S3 gateway endpoint (`IpAddressType: dualstack`) | **Endpoint policy**: ECR layer bucket, AL2023 repos, and (consumer) the lab data bucket only |
| | Flow Logs | Custom format with `pkt-srcaddr`, `pkt-dstaddr`, `flow-direction`, `traffic-path` |
| `v6lab-provider` | Images `docker/netbench`, `docker/loadgen` (built by cdkd, content-hash tags) | No manual build / push / digest step |
| | ECS cluster (Container Insights enhanced), task execution role, task role **without permissions** | |
| | Internal NLB `IpAddressType: dualstack` + TCP 80 → TG (ip, 8080) | TG family = IPv4 in dual-stack mode, IPv6 in IPv6-only mode |
| | VPC endpoint service | `AcceptanceRequired: true`, `SupportedIpAddressTypes: [ipv4, ipv6]`, allowed principal = this account only |
| | Lattice service network + service (`AWS_IAM`), HTTP 80 / HTTPS 443, IP target group | Auth policies: **only from the consumer VPC**; service policy switch `latticeAuthMode` |
| | Lattice access logs → CloudWatch Logs | Auth decisions, caller principal, source VPC, target address |
| | `svc-pl` (NLB target group) / `svc-lattice` (`VpcLatticeConfigurations`, port name `http`), baseline task definition | Same task definition behind both paths |
| `v6lab-consumer` | Load generator EC2 (SSM only), trusted / untrusted client SGs | |
| | PrivateLink interface endpoint (dual-stack) | Stays `pendingAcceptance` until the provider accepts (2.3) |
| | Lattice service network VPC association (with SG) | |
| | S3 data / outside buckets, S3 interface endpoint (dual-stack, endpoint policy) | Reads only via `aws:SourceVpce` |

> If the deploy fails on `IpAddressType` of the S3 gateway endpoint or an interface endpoint, the region does not support IPv6 for it yet.
> Re-deploy with `-c s3GatewayIpAddressType=ipv4` / `-c endpointIpAddressType=ipv4` and note it in the results (IPv6-only mode will not work then).

Check the image scan results (fix Critical / High findings before you measure) and the services:

```bash
source scripts/lib.sh
for uri in "$(out provider NetbenchImageUri)" "$(out provider LoadgenImageUri)"; do
  repo="${uri#*/}"; repo="${repo%%:*}"; tag="${uri##*:}"
  aws ecr describe-image-scan-findings --repository-name "$repo" --image-id imageTag="$tag" \
    --query 'imageScanFindings.findingSeverityCounts'
done
aws ecs describe-services --cluster "$PREFIX" --services svc-pl svc-lattice \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount}' --output table
aws vpc-lattice list-targets --target-group-identifier "$(out provider LatticeTgArn)" \
  --query 'items[].{ip:id,port:port,status:status}' --output table
```

### 2.3 Provider approval and test data

As the **provider**, approve the PrivateLink connection (security control + S-6 timing), then upload the S3 test objects:

```bash
./scripts/accept-endpoint.sh
./scripts/upload-test-objects.sh
python3 scripts/measure-provisioning.py --prefix "$PREFIX" --csv results/provisioning.csv
```

> Before you accept, run the probe in 2.6 once: the PrivateLink path must **not** work (`pendingAcceptance`).
> That is security test X-2.

### 2.4 Changing a setting later

Redeploy with the new context; cdkd updates only what changed (`npm run diff -- -c ...` shows it first):

```bash
npm run deploy -- -c latticeAuthMode=iam-required    # X-3
npm run deploy                                       # back to the cdk.json defaults
```

> Keep the same `-c` values for every deploy of a scenario. A deploy without them returns to the defaults in `cdk.json`.

### 2.5 Get into the load generator

In CloudShell, print the values the load generator needs (they come from `cdk-outputs.json`, which stays in CloudShell):

```bash
./scripts/get-endpoints.sh
LOADGEN_ID=$(source scripts/lib.sh && out consumer LoadgenInstanceId)
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

### 2.6 Smoke test (all paths, IPv6 and IPv4)

```bash
lg probe-paths.sh --context trusted
```

Expected (dual-stack mode, `latticeAuthMode=vpc-only`):

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
| X-3 | Lattice auth policy: anonymous vs SigV4 | `npm run deploy -- -c latticeAuthMode=iam-required` → `lg probe-paths.sh --context iam-required` |
| X-4 | What the provider sees | `./scripts/source-ip-report.sh 60` |
| X-5 | Data perimeter with endpoint + bucket policies | `s3*-outside` rows in the probe, and `curl` from CloudShell (internet) |
| X-6 | Overlapping IPv4 | both VPCs are `10.0.0.0/16` — and everything above worked |
| X-7 | Exposure review | [05-security-scenarios.md](05-security-scenarios.md#x-7-exposure-review-desk-check) |

---

## 5. Optional: IPv6-only workloads

Switch the workload subnets to IPv6-only. A subnet cannot change type in place, so **destroy and redeploy** with the context set — with cdkd this takes minutes, not a CloudFormation stack-delete cycle:

```bash
npm run destroy
npm run deploy -- -c workloadIpMode=ipv6only
./scripts/accept-endpoint.sh && ./scripts/upload-test-objects.sh
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
npm run destroy
```

`scripts/destroy.sh` empties the two S3 buckets, runs `cdkd destroy --all --yes`, deletes `cdk-outputs.json` and lists anything still tagged `Project=<prefix>` (the list should be empty).

- The images stay in the cdkd container-asset repository. Remove unreferenced ones with `npx cdkd gc` (dry run first, see `npx cdkd gc --help`)
- `npx cdkd bootstrap --destroy` removes cdkd's asset storage for the region if you do not use cdkd elsewhere
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
- [ ] ECR registry scanning on, findings checked; images use content-hash tags (base images pinned by digest too)
- [ ] `npm test` passes; `cdk-outputs.json` and deploy logs are not committed or shared
- [ ] Credentials for the SigV4 test are read from IMDS inside the container and passed to curl via stdin
- [ ] Log retention set (7 days by default)
- [ ] Budget alert set, everything deleted on the same day

## Appendix B. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Deploy fails on `IpAddressType` | No IPv6 support for that endpoint in the region | `-c endpointIpAddressType=ipv4` / `-c s3GatewayIpAddressType=ipv4` (dual-stack mode only) |
| `Failed to acquire lock for stack` | Another / interrupted cdkd run holds the lock | Wait, or if no other run is active: `npx cdkd force-unlock <stack>` |
| A deploy failed half-way | cdkd rolled back automatically, the note says a resource may be partially applied | Fix and deploy again (fix forward), or `npx cdkd rollback <stack> --revert-failed` |
| `cdk-outputs.json not found` | Scripts run before a successful `npm run deploy` | Deploy first, or set `OUTPUTS_FILE` |
| Docker build fails during deploy | Docker not running, or wrong architecture | `docker info`; match `-c cpuArchitecture` to what you build |
| Tasks stuck in `PROVISIONING` / image pull fails | ECR / S3 endpoint missing, endpoint policy too strict | Check the ECR endpoints and the `EcrImageLayers` statement of the S3 gateway endpoint policy |
| Load generator `docker pull` is denied | The image is in a repository the role does not cover | The role allows `cdkd-container-assets-*` and `cdk-*-container-assets-*`; check `LoadgenImageUri` |
| `dnf` fails in the load generator user data | S3 gateway endpoint policy | The `al2023-repos-<region>-*` statement must be there |
| PrivateLink returns `timeout/refused` | Connection not accepted yet, or the client SG is untrusted | `./scripts/accept-endpoint.sh`, check the SG |
| PrivateLink still `timeout/refused` with `A=0 AAAA=0` after acceptance | The VPC resolver cached the NXDOMAIN from the probe you ran before acceptance (X-2); about 9.7 minutes in the 2026-11-19 run | Wait until `dig +short AAAA $PL_DNS` answers on the load generator, then start S-1 (see X-2) |
| Deploy fails on `Ec2MessagesEndpoint`: *doesn't support this IP address type dualstack* | `ec2messages` has no dual-stack endpoint | Already handled: the stack creates it as IPv4 (SSM Agent 3.3.40+ only needs `ssm` + `ssmmessages`) |
| After an interrupted / failed deploy, tasks or the load generator cannot reach ECR, Logs or S3 | cdkd state and AWS drifted (endpoints recorded in state but missing in AWS) | Check `aws ec2 describe-vpc-endpoints`; if they differ from `npx cdkd state resources <stack>`, `npm run destroy` and deploy again |
| Lattice returns 403 | Auth policy: source VPC or `iam-required` | Check the `latticeAuthMode` you deployed with, the access log `authDeniedReason` |
| Lattice targets `UNHEALTHY` | Task SG misses the Lattice ranges | `169.254.171.0/24` and `fd00:ec2:80::/64` on 8080 |
| S3 returns 403 for the data bucket | Request did not go through a consumer endpoint, or the object is missing | Use the dual-stack S3 name / the vpce name; run `upload-test-objects.sh` |
| k6 `dropped_iterations` > 0 | Load generator limit | Use a larger instance or lower rates |
| `run-baseline.sh` prints nothing | The task failed before k6 ran | `aws ecs describe-tasks ... --query 'tasks[0].stoppedReason'` |
