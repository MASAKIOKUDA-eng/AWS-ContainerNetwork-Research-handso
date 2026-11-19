#!/usr/bin/env bash
# Shared helpers for the CloudShell-side scripts (sourced, not executed).
# Stack outputs are read from cdk-outputs.json, written by `npm run deploy` (cdkd --outputs-file).
P="${PREFIX:-v6lab}"
[[ "$P" =~ ^[a-z0-9-]{3,16}$ ]] || { echo "invalid PREFIX" >&2; exit 1; }
: "${AWS_REGION:?set AWS_REGION}"
OUTPUTS_FILE="${OUTPUTS_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/cdk-outputs.json}"
[[ -f "$OUTPUTS_FILE" ]] || { echo "$OUTPUTS_FILE not found - run 'npm run deploy' first" >&2; exit 1; }

out() {  # out <stack-suffix> <OutputKey>   e.g. out consumer PrivateLinkEndpointDns
  local v
  v="$(jq -r --arg s "$P-$1" --arg k "$2" '.[$s][$k] // empty' "$OUTPUTS_FILE")"
  [[ -n "$v" ]] || { echo "output $2 of stack $P-$1 not found in $OUTPUTS_FILE" >&2; return 1; }
  printf '%s\n' "$v"
}
