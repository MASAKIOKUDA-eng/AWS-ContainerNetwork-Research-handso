# 07. Event runbook (until 2026-11-21)

[日本語](../ja/07-event-runbook.md)

## Timeline

| When | What | Done |
|------|------|------|
| D-4 (11/17) | Repository ready, templates validated (CI green) | ☐ |
| D-3 (11/18) | Deploy in a sandbox account (dual-stack mode), smoke test 2.6, security probes X-1 … X-5 | ☐ |
| D-3 (11/18) | Speed runs S-0 … S-4 (×3), S-6. Copy `results/` to your laptop. **Delete the stacks the same day** | ☐ |
| D-2 (11/19) | (Optional) `npm run deploy -- -c workloadIpMode=ipv6only`, S-1 / S-3, then `npm run destroy` | ☐ |
| D-2 (11/19) | Fill [result-template.md](result-template.md), make charts, replace every `[RESULT]` in the script | ☐ |
| D-1 (11/20) | Rehearse twice with a timer (target 18–19 min). Prepare the 10-min cut. Export the deck to PDF | ☐ |
| Day (11/21) | Arrive early, test the projector and the QR code. No live AWS demo — screenshots only | ☐ |
| After | Publish the deck, add the link to README, open issues for audience questions | ☐ |

## Measurement session plan (about 3 hours, one sitting)

| Time | Step | Notes |
|------|------|-------|
| 0:00 | `npm ci && npm test`, `npx cdkd bootstrap` (first time), `npm run deploy` (builds the images too) | note the duration from `deploy-logs/HISTORY.md` |
| 0:20 | Check the image scan, probe before acceptance (X-2), accept, upload objects | |
| 0:40 | Smoke test 2.6, X-1, X-4 | screenshots of the probe output |
| 0:55 | X-3: `npm run deploy -- -c latticeAuthMode=iam-required` → probe → `npm run deploy` | screenshot of the Lattice access log, deploy times of the update |
| 1:05 | S-1 ×3 (rotate order), S-2, S-3 | ~60 min |
| 2:05 | S-4, S-0 baseline, S-6 | |
| 2:40 | Copy results, `summarize.py`, screenshots of Flow Logs / Logs Insights | |
| 2:55 | **Clean up**: `npm run destroy` (lists leftovers) | note the destroy time |

## Screenshots to take (backup for the talk)

- [ ] `npm run deploy` finished, with the duration from `deploy-logs/HISTORY.md` (cdkd)
- [ ] VPC console: subnets with IPv6 CIDRs (edge dual-stack / workload)
- [ ] Endpoint service: `Acceptance required`, supported IP address types IPv4 + IPv6, pending connection
- [ ] Lattice: service network with the consumer VPC association and the SG
- [ ] Lattice access log entry with `authDeniedReason` and one with `callerPrincipal`
- [ ] Probe output for trusted / untrusted / iam-required
- [ ] Provider access log: `remote` for PrivateLink vs Lattice (source-ip-report)
- [ ] k6 summary of one run (to show the method)
- [ ] Flow Logs query showing IPv6 `pkt-srcaddr`

## Cost notes (check current pricing before you start)

Main hourly items while the lab runs: interface endpoints (per endpoint per AZ: 2 VPCs × 2 AZs × 4–7 endpoints), NLB, VPC Lattice service, 4 Fargate tasks, the load generator EC2. Data processing is charged per GB on interface endpoints and Lattice. Run the measurements in one sitting and delete everything the same day.

## Security notes for the day

- Do not show account IDs, VPC IDs, ARNs or access log lines with principals unmasked on slides
- Do not show the AWS console of your main account; use the sandbox
- Do not run a live demo against a public endpoint (there is none by design)
