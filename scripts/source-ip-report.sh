#!/usr/bin/env bash
# What did the PROVIDER see? (security scenario X-4: identity and source address)
# Runs CloudWatch Logs Insights over the netbench access logs and the VPC Lattice access logs.
#
#   ./scripts/source-ip-report.sh [minutes]     (default: last 60 minutes)
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

MIN="${1:-60}"; [[ "$MIN" =~ ^[0-9]+$ ]] || { echo "minutes must be a number" >&2; exit 1; }
APP_LG="$(out provider-platform AppLogGroupName)"
LAT_LG="$(out provider-platform LatticeAccessLogGroupName)"

query() {  # $1 log group, $2 query
  local id
  id="$(aws logs start-query --log-group-name "$1" --start-time $(( $(date +%s) - MIN * 60 )) \
        --end-time "$(date +%s)" --query-string "$2" --query queryId --output text)"
  while :; do
    local r; r="$(aws logs get-query-results --query-id "$id")"
    [[ "$(jq -r .status <<<"$r")" =~ ^(Complete|Failed|Cancelled)$ ]] && { jq -r '.results[] | map("\(.field)=\(.value)") | join("  ")' <<<"$r"; break; }
    sleep 2
  done
}

echo "== Provider access log: source address / Lattice headers per service"
query "$APP_LG" 'filter @logStream like /netbench/ and ispresent(remote)
| parse @logStream "netbench/web/*" as task
| stats count(*) as requests by remote, lattice_source_vpc, substr(lattice_identity, 0, 40) as identity
| sort requests desc | limit 30'

echo
echo "== VPC Lattice access log: auth decisions"
query "$LAT_LG" 'stats count(*) as requests by responseCode, authDeniedReason, callerPrincipal, sourceVpcArn
| sort requests desc | limit 30'
