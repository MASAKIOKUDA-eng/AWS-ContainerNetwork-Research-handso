# Results (template for the slides)

[日本語](../ja/result-template.md)

## Conditions

| Item | Value |
|------|-------|
| Date / time (UTC) | |
| Region / AZs (load generator, tasks) | |
| workloadIpMode | dualstack / ipv6only |
| Load generator instance type | |
| Task size / count per service | 0.5 vCPU / 1 GiB × 2 |
| Image URIs / tags (netbench / loadgen, from cdk-outputs.json) | |
| cdkd version / deploy and destroy time (deploy-logs/HISTORY.md) | |
| Runs per data point | |

## Speed

### S-1 latency, 1 KiB, keep-alive, IPv6 (ms, median of runs)

| Path | p50 @100 | p99 @100 | p50 @500 | p99 @500 | p50 @1000 | p99 @1000 | added p50 vs S-0 |
|------|----------|----------|----------|----------|-----------|-----------|------------------|
| S-0 baseline (NLB, in-VPC) | | | | | | | 0 |
| PrivateLink | | | | | | | |
| Lattice HTTP | | | | | | | |
| Lattice HTTPS | | | | | | | |
| S3 gateway endpoint | | | | | ― | ― | ― |
| S3 interface endpoint | | | | | ― | ― | ― |

### S-2 new connection per request (ms, p50)

| Path | connect | TLS | total | total with keep-alive (S-1) |
|------|---------|-----|-------|-----------------------------|
| PrivateLink | | ― | | |
| Lattice HTTP | | ― | | |
| Lattice HTTPS | | | | |

### S-3 IPv6 vs IPv4 (p50 / p99 ms at 500 rps)

| Path | IPv6 | IPv4 | difference within run-to-run spread? |
|------|------|------|-------------------------------------|
| PrivateLink | | | |
| Lattice HTTP | | | |
| S3 gateway | | | |

### S-4 throughput, 1 MiB (MB/s)

| Path | 32 VUs | 64 VUs | limiting factor (client / task / path) |
|------|--------|--------|----------------------------------------|
| PrivateLink | | | |
| Lattice HTTP | | | |
| S3 gateway | | | |
| S3 interface | | | |

### S-6 time to connect a new consumer (s)

| Path | resource create | approval | until first 200 |
|------|-----------------|----------|-----------------|
| PrivateLink | | human + `accept_to_available` | |
| Lattice | | ― | |
| S3 gateway / interface | | ― | |

## Security

### Probe matrix (IPv6 / IPv4)

| target | trusted | untrusted SG (X-1) | not accepted (X-2) | iam-required (X-3) |
|--------|---------|--------------------|--------------------|--------------------|
| pl-http | | | | |
| lattice-http | | | | |
| lattice-https | | | | |
| lattice-https-sigv4 | | | | |
| s3gw-data | | | | |
| s3gw-outside | | | | |
| s3if-data | | | | |
| s3if-outside | | | | |

### What the provider saw (X-4)

| Path | remote | source VPC header | identity header |
|------|--------|-------------------|-----------------|
| PrivateLink | | ― | ― |
| Lattice (anonymous) | | | ― |
| Lattice (SigV4) | | | |

## Conclusion (update the decision guide on slide 15 with these results)

| Hypothesis | Confirmed? | Evidence |
|------------|-----------|----------|
| H1 | | |
| H2 | | |
| H3 | | |
| H4 | | |
| H5 | | |
| H6 | | |
| H7 | | |
