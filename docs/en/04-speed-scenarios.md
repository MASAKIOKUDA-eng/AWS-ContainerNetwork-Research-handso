# 04. Speed scenarios

[日本語](../ja/04-speed-scenarios.md)

"Speed" in this lab has three meanings:

1. **Request latency** — how much time a path adds to one request (S-0, S-1, S-3)
2. **Connection cost and throughput** — what new connections and large objects cost (S-2, S-4)
3. **Time to connect** — how long until a new consumer can call the service (S-6)

All commands run on the load generator through the `lg` function (see [03-handson-guide.md](03-handson-guide.md#25-get-into-the-load-generator)) unless marked *CloudShell*.

## Metrics recorded by `run-k6.sh`

| Metric | Meaning |
|--------|---------|
| `total_p50_ms` / `total_p95_ms` / `total_p99_ms` | `http_req_duration` (send → last byte), measure phase only |
| `connect_p50_ms` / `connect_p99_ms` | TCP connect time (≈ 0 with keep-alive) |
| `tls_p50_ms` / `tls_p99_ms` | TLS handshake time |
| `wait_p50_ms` / `wait_p99_ms` | time to first byte after the request is sent (server + path) |
| `error_rate` | share of responses that were not the expected status |
| `throughput_MBps` | bytes received in the measure phase / duration |
| `dropped_iterations` | > 0 means the **load generator** was the limit — discard the run |

## S-0 Baseline: no PrivateLink hop (*CloudShell*)

k6 runs as a Fargate task **inside the provider VPC** and calls the NLB directly. The difference S-1(privatelink) − S-0 is the cost of the PrivateLink hop itself.

```bash
./scripts/run-baseline.sh "100 500 1000" onlyIPv6
```

> The baseline client is Fargate, the S-1 client is EC2, and AZ placement differs. Treat S-0 as an order of magnitude, not an exact subtraction.

## S-1 Latency with keep-alive (the main comparison)

| Label | URL |
|-------|-----|
| `privatelink` | `http://$PL_DNS/1k` |
| `lattice-http` | `http://$LATTICE_DNS/1k` |
| `lattice-https` | `https://$LATTICE_DNS/1k` |
| `s3-gateway` | `https://$DATA_BUCKET.s3.dualstack.$AWS_REGION.amazonaws.com/1k` |
| `s3-interface` | `https://bucket.${S3IF_DNS#\*.}/$DATA_BUCKET/1k` |

```bash
for i in 1 2 3; do
  lg run-k6.sh --label privatelink   --url "http://$PL_DNS/1k"
  lg run-k6.sh --label lattice-http  --url "http://$LATTICE_DNS/1k"
  lg run-k6.sh --label lattice-https --url "https://$LATTICE_DNS/1k"
done
lg run-k6.sh --label s3-gateway   --url "https://$DATA_BUCKET.s3.dualstack.$AWS_REGION.amazonaws.com/1k" --rates "100 500"
lg run-k6.sh --label s3-interface --url "https://bucket.${S3IF_DNS#\*.}/$DATA_BUCKET/1k" --rates "100 500"
```

- Default rates: 100 / 500 / 1000 rps, 2 min each (+20 s warm-up). S3 is a different kind of server, compare S3 paths only with each other.
- **Hypothesis H1**: PrivateLink ≈ baseline + small; Lattice HTTP adds a little more (L7 proxy); HTTPS adds only a little with keep-alive.
- Look at **p99**, not only p50. A path that is fine at 100 rps can bend at 1000 rps.

## S-2 New connection per request

```bash
lg run-k6.sh --label privatelink   --url "http://$PL_DNS/1k"       --reuse no --rates "100 300"
lg run-k6.sh --label lattice-http  --url "http://$LATTICE_DNS/1k"  --reuse no --rates "100 300"
lg run-k6.sh --label lattice-https --url "https://$LATTICE_DNS/1k" --reuse no --rates "100 300"
```

- Compare `connect_*` and `tls_*` with S-1.
- **Hypothesis H3**: "HTTPS without keep-alive" costs more than "PrivateLink vs Lattice". The design lesson is connection pooling, not the path.

## S-3 IPv6 vs IPv4 on the same path

```bash
for ip in onlyIPv6 onlyIPv4; do
  lg run-k6.sh --label privatelink  --url "http://$PL_DNS/1k"      --ip "$ip" --rates "500"
  lg run-k6.sh --label lattice-http --url "http://$LATTICE_DNS/1k" --ip "$ip" --rates "500"
  lg run-k6.sh --label s3-gateway   --url "https://$DATA_BUCKET.s3.dualstack.$AWS_REGION.amazonaws.com/1k" --ip "$ip" --rates "500"
done
```

- **Hypothesis H2**: no meaningful difference. If the IPv4 S3 gateway result fails while IPv6 works (or the other way round), check `S3GatewayIpAddressType`.
- Confirm the family in Flow Logs: `pkt-srcaddr` of the load generator ENI should be IPv6 for the `onlyIPv6` runs.

```
# CloudWatch Logs Insights on /<prefix>/consumer/vpc-flow-logs
parse @message "* * * * * * * * * * * * * * * * * * * *" as ver, eni, src, dst, sport, dport, proto, pkts, bytes, start, end, action, status, psrc, pdst, dir, path, az, ecssvc, ecstask
| filter dport in [80, 443] and dir = "egress"
| fields strcontains(psrc, ":") as is_ipv6
| stats sum(bytes) as total_bytes by is_ipv6, pdst, path
| sort total_bytes desc
```

## S-4 Throughput with 1 MiB objects

```bash
lg run-k6.sh --label privatelink  --url "http://$PL_DNS/1m"      --mode throughput --vus 32
lg run-k6.sh --label lattice-http --url "http://$LATTICE_DNS/1m" --mode throughput --vus 32
lg run-k6.sh --label s3-gateway   --url "https://$DATA_BUCKET.s3.dualstack.$AWS_REGION.amazonaws.com/1m" --mode throughput --vus 32
lg run-k6.sh --label s3-interface --url "https://bucket.${S3IF_DNS#\*.}/$DATA_BUCKET/1m" --mode throughput --vus 32
```

- Increase `--vus` (32 → 64 → 128) until MB/s stops growing. Watch the load generator CPU (`top` in another session).
- With only 2 small Fargate tasks behind ① and ②, the **tasks** may be the limit. Redeploy with `-c desiredCount=4 -c taskCpu=1024` if needed and write it down.
- Remember the cost side: interface endpoints and Lattice charge per GB, the S3 gateway endpoint does not (check pricing).

## S-5 Scale behaviour (optional)

Raise the rate until p99 bends (`--rates "1000 2000 4000"`), with `DesiredCount=4`. Note the first rate at which p99 doubles compared with 100 rps, per path.

## S-6 Time to connect a new consumer (*CloudShell*)

```bash
python3 scripts/measure-provisioning.py --prefix "$PREFIX" --csv results/provisioning.csv
cat results/provisioning.csv     # also contains accept_to_available from accept-endpoint.sh
```

| Path | What a new consumer team has to do | Time to measure |
|------|------------------------------------|-----------------|
| PrivateLink | create interface endpoint → **ask the provider to accept** → endpoint available | create time + waiting for a human + `accept_to_available` |
| VPC Lattice | associate the VPC with the service network (if the network is shared with them) | association create time |
| S3 endpoints | gateway: route table association (free) / interface: endpoint per AZ | create time |

- **Hypothesis H5**: Lattice is fastest to onboard once the service network exists; PrivateLink adds a human approval (which is also a security feature).

## Reading the results

```bash
python3 scripts/summarize.py results/k6.csv --pivot total_p50_ms
python3 scripts/summarize.py results/k6.csv --pivot total_p99_ms
python3 scripts/summarize.py results/k6.csv --pivot connect_p50_ms
python3 scripts/summarize.py results/k6.csv --pivot tls_p50_ms
python3 scripts/summarize.py results/k6.csv --pivot throughput_MBps
```

Rules for the slides:

- Show medians of ≥ 3 runs, and say how many runs
- Show **added latency vs S-0**, not absolute values only
- Keep S3 rows separate from service rows
- If two paths differ by less than the run-to-run spread, say "no meaningful difference"
