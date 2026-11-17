#!/usr/bin/env bash
# Speed scenarios S-1 .. S-5 (see docs/en/04-speed-scenarios.md).
# Baked into the loadgen image; run it on the load generator EC2 like this:
#
#   lg run-k6.sh --label privatelink --url "http://$PL_DNS/1k" --rates "100 500 1000"
#   lg run-k6.sh --label lattice-https --url "https://$LATTICE_DNS/1k" --reuse no --rates "100"
#   lg run-k6.sh --label s3-gateway --url "https://$DATA_BUCKET.s3.dualstack.$AWS_REGION.amazonaws.com/1m" --mode throughput
#
# Appends p50/p95/p99 of total / connect / TLS / wait time, error rate and MB/s to results/k6.csv.
set -euo pipefail

LABEL="" URL="" RATES="100 500 1000" DURATION="2m" MODE="latency" VUS=16
IP_POLICY="onlyIPv6" REUSE="yes" EXPECT=200 PAUSE=20
OUT="results/k6.csv"
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) LABEL="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --rates) RATES="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;            # latency | throughput
    --vus) VUS="$2"; shift 2 ;;
    --ip) IP_POLICY="$2"; shift 2 ;;         # onlyIPv6 | onlyIPv4 | preferIPv6 | preferIPv4
    --reuse) REUSE="$2"; shift 2 ;;          # yes | no
    --expect) EXPECT="$2"; shift 2 ;;
    --pause) PAUSE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done
[[ "$LABEL" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "--label is required ([A-Za-z0-9_.-])" >&2; exit 1; }
[[ "$URL" =~ ^https?://[A-Za-z0-9.:-]+(/[A-Za-z0-9._/-]*)?$ ]] || { echo "a valid --url is required" >&2; exit 1; }
[[ "$MODE" =~ ^(latency|throughput)$ ]] || { echo "--mode must be latency or throughput" >&2; exit 1; }
[[ "$IP_POLICY" =~ ^(onlyIPv6|onlyIPv4|preferIPv6|preferIPv4)$ ]] || { echo "invalid --ip" >&2; exit 1; }
[[ "$REUSE" =~ ^(yes|no)$ ]] || { echo "--reuse must be yes or no" >&2; exit 1; }
[[ "$VUS" =~ ^[0-9]+$ && "$EXPECT" =~ ^[0-9]{3}$ && "$PAUSE" =~ ^[0-9]+$ ]] || { echo "invalid number" >&2; exit 1; }
[[ "$DURATION" =~ ^[0-9]+[smh]$ ]] || { echo "invalid --duration" >&2; exit 1; }
[[ "$MODE" == "throughput" ]] && RATES="vus$VUS"

mkdir -p "$(dirname "$OUT")" results/raw
[[ -f "$OUT" ]] || echo "path,mode,ip,reuse,load,metric,value,unit,timestamp" > "$OUT"
ip_tag="${IP_POLICY#only}"; ip_tag="${ip_tag#prefer}"
n="${DURATION%[smh]}"
case "$DURATION" in *s) secs=$n ;; *m) secs=$((n * 60)) ;; *h) secs=$((n * 3600)) ;; esac

for load in $RATES; do
  rate="${load#vus}"
  [[ "$rate" =~ ^[0-9]+$ ]] || { echo "invalid rate: $load" >&2; exit 1; }
  summary="results/raw/k6-${LABEL}-${MODE}-${ip_tag}-${REUSE}-${load}-$(date +%s).json"
  echo "== [$LABEL] mode=$MODE ip=$IP_POLICY reuse=$REUSE load=$load"
  # k6 exits non-zero when a threshold fails; the numbers are still recorded.
  k6 run --quiet \
    -e TARGET_URL="$URL" -e MODE="$MODE" -e RATE="$rate" -e VUS="$VUS" -e DURATION="$DURATION" \
    -e IP_POLICY="$IP_POLICY" -e REUSE="$REUSE" -e EXPECT="$EXPECT" -e LABEL="$LABEL" \
    --summary-export "$summary" "$SCRIPT_DIR/k6-load.js" || true

  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  jq -r --arg l "$LABEL" --arg m "$MODE" --arg ip "$ip_tag" --arg ru "$REUSE" --arg ld "$load" \
        --arg ts "$ts" --argjson secs "$secs" '
    .metrics as $x
    | def t($n): ($x[$n + "{phase:measure}"] // $x[$n] // {});
    [ ["total_p50_ms",   t("http_req_duration").med],
      ["total_p95_ms",   t("http_req_duration")["p(95)"]],
      ["total_p99_ms",   t("http_req_duration")["p(99)"]],
      ["connect_p50_ms", t("http_req_connecting").med],
      ["connect_p99_ms", t("http_req_connecting")["p(99)"]],
      ["tls_p50_ms",     t("http_req_tls_handshaking").med],
      ["tls_p99_ms",     t("http_req_tls_handshaking")["p(99)"]],
      ["wait_p50_ms",    t("http_req_waiting").med],
      ["wait_p99_ms",    t("http_req_waiting")["p(99)"]],
      ["error_rate",     (t("http_req_failed").value // t("http_req_failed").rate // 0)],
      ["requests",       (t("iterations").count // 0)],
      ["throughput_MBps", ((t("data_received").count // 0) / 1048576 / $secs)],
      ["dropped_iterations", ($x.dropped_iterations.count // 0)] ]
    | .[]
    | "\($l),\($m),\($ip),\($ru),\($ld),\(.[0]),\(.[1] // ""),\(if (.[0]|endswith("_ms")) then "ms" elif .[0]=="error_rate" then "ratio" elif .[0]=="throughput_MBps" then "MB/s" else "count" end),\($ts)"
  ' "$summary" >> "$OUT"
  tail -n 13 "$OUT" | cut -d, -f1,5-8
  sleep "$PAUSE"   # let the targets settle before the next step
done
