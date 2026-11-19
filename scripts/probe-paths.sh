#!/usr/bin/env bash
# One-shot reachability / identity probe for every path, over IPv6 and IPv4 (security scenarios X-1 .. X-5).
# Baked into the loadgen image; run it on the load generator EC2 like this:
#
#   lg probe-paths.sh --context trusted
#   (swap the instance to the untrusted SG with scripts/swap-client-sg.sh, then)
#   lg probe-paths.sh --context untrusted
#
# Required environment (export them before calling lg; see docs/en/03-handson-guide.md 2.7):
#   AWS_REGION PL_DNS LATTICE_DNS S3IF_DNS DATA_BUCKET OUTSIDE_BUCKET
#
# For each target it records: DNS answers (A / AAAA), HTTP status or timeout, the remote IP used,
# connect / total time, and for /whoami the source address the PROVIDER saw.
# The SigV4 test reads the instance role credentials from IMDSv2 inside this process only
# (they are passed to curl through stdin, never on the command line).
set -euo pipefail

CONTEXT="trusted" OUT="results/probe.csv" TIMEOUT=5
while [[ $# -gt 0 ]]; do
  case "$1" in
    --context) CONTEXT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done
[[ "$CONTEXT" =~ ^[A-Za-z0-9_-]+$ && "$TIMEOUT" =~ ^[0-9]+$ ]] || { echo "invalid --context / --timeout" >&2; exit 1; }
for v in AWS_REGION PL_DNS LATTICE_DNS S3IF_DNS DATA_BUCKET OUTSIDE_BUCKET; do
  [[ -n "${!v:-}" ]] || { echo "set $v" >&2; exit 1; }
  [[ "${!v}" =~ ^[A-Za-z0-9.*-]+$ ]] || { echo "invalid value in $v" >&2; exit 1; }
done

S3GW="s3.dualstack.${AWS_REGION}.amazonaws.com"
S3IF="bucket.${S3IF_DNS#\*.}"          # *.vpce-xxx.s3.<region>.vpce.amazonaws.com -> bucket.vpce-xxx...

# name | url | expected (trusted context, dual-stack) | signed?
TARGETS=(
  "pl-http|http://${PL_DNS}/whoami|200|no"
  "lattice-http|http://${LATTICE_DNS}/whoami|200|no"
  "lattice-https|https://${LATTICE_DNS}/whoami|200 (vpc-only) / 403 (iam-required)|no"
  "lattice-https-sigv4|https://${LATTICE_DNS}/whoami|200|yes"
  "s3gw-data|https://${DATA_BUCKET}.${S3GW}/1k|200|no"
  "s3gw-outside|https://${OUTSIDE_BUCKET}.${S3GW}/1k|403 (endpoint policy)|no"
  "s3if-data|https://${S3IF}/${DATA_BUCKET}/1k|200|no"
  "s3if-outside|https://${S3IF}/${OUTSIDE_BUCKET}/1k|403 (endpoint policy)|no"
)

imds() {  # IMDSv2 over IPv4, falling back to IPv6 (IPv6-only subnets)
  local base tok
  for base in "http://169.254.169.254" "http://[fd00:ec2::254]"; do
    tok="$(curl -s -m 2 -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 300" "$base/latest/api/token" || true)"
    if [[ -n "$tok" ]]; then
      curl -s -m 2 -H "X-aws-ec2-metadata-token: $tok" "$base/latest/meta-data/$1"
      return 0
    fi
  done
  return 1
}

CREDS=""
load_creds() {
  [[ -n "$CREDS" ]] && return 0
  local role
  role="$(imds iam/security-credentials/ | head -n1)" || return 1
  CREDS="$(imds "iam/security-credentials/$role")" || return 1
}

probe() {  # $1 name $2 url $3 family(4|6) $4 signed
  local name="$1" url="$2" fam="$3" signed="$4" host a aaaa fmt out code rip tc tt body
  host="$(sed -E 's#^https?://([^/]+).*#\1#' <<<"$url")"
  a="$(dig +short A "$host" | grep -cE '^[0-9.]+$' || true)"
  aaaa="$(dig +short AAAA "$host" | grep -c ':' || true)"
  fmt='%{http_code} %{remote_ip} %{time_connect} %{time_total}'
  body="$(mktemp)"
  if [[ "$signed" == yes ]]; then
    load_creds || { echo "$CONTEXT,$name,$fam,$a,$aaaa,no-credentials,,,,," >> "$OUT"; return; }
    out="$(jq -r '"user = \"\(.AccessKeyId):\(.SecretAccessKey)\"\nheader = \"x-amz-security-token: \(.Token)\""' <<<"$CREDS" \
      | curl -s -"$fam" -m "$TIMEOUT" -o "$body" -w "$fmt" -K - \
          --aws-sigv4 "aws:amz:${AWS_REGION}:vpc-lattice-svcs" \
          -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" "$url" || true)"
  else
    out="$(curl -s -"$fam" -m "$TIMEOUT" -o "$body" -w "$fmt" "$url" || true)"
  fi
  read -r code rip tc tt <<<"${out:-000 - 0 0}"
  [[ "$code" == "000" ]] && code="timeout/refused"
  local seen=""
  if [[ "$url" == */whoami && -s "$body" ]]; then
    seen="$(jq -r '"remote=\(.remote) src_vpc=\(.lattice_source_vpc) identity=\(.lattice_identity|.[0:60])"' "$body" 2>/dev/null || true)"
  fi
  rm -f "$body"
  printf '%s,%s,IPv%s,%s,%s,%s,%s,%.1f,%.1f,"%s"\n' "$CONTEXT" "$name" "$fam" "$a" "$aaaa" "$code" "$rip" \
    "$(awk "BEGIN{print ${tc:-0}*1000}")" "$(awk "BEGIN{print ${tt:-0}*1000}")" "$seen" >> "$OUT"
  printf '  [%-9s] %-20s IPv%s  A=%s AAAA=%s  -> %-16s %s\n' "$CONTEXT" "$name" "$fam" "$a" "$aaaa" "$code" "$seen"
}

mkdir -p "$(dirname "$OUT")"
[[ -f "$OUT" ]] || echo "context,target,family,a_records,aaaa_records,result,remote_ip,connect_ms,total_ms,provider_saw" > "$OUT"

echo "expected results (trusted context): see docs/en/05-security-scenarios.md"
for t in "${TARGETS[@]}"; do
  IFS='|' read -r name url expect signed <<<"$t"
  echo "- $name (expected: $expect)"
  for fam in 6 4; do probe "$name" "$url" "$fam" "$signed"; done
done
echo "Results appended to $OUT"
