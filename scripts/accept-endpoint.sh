#!/usr/bin/env bash
# Provider-side approval of the PrivateLink connection (security control: AcceptanceRequired=true).
# Also prints how long the consumer endpoint took to become "available" after acceptance (speed S-6).
#
#   ./scripts/accept-endpoint.sh
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

SVC_ID="$(out provider EndpointServiceId)"
EP_ID="$(out consumer PrivateLinkEndpointId)"
[[ "$SVC_ID" =~ ^vpce-svc-[0-9a-f]+$ && "$EP_ID" =~ ^vpce-[0-9a-f]+$ ]] || { echo "stack outputs not found" >&2; exit 1; }

state() { aws ec2 describe-vpc-endpoints --vpc-endpoint-ids "$EP_ID" --query 'VpcEndpoints[0].State' --output text; }
echo "endpoint $EP_ID state before: $(state)"
aws ec2 describe-vpc-endpoint-connections \
  --filters "Name=service-id,Values=$SVC_ID" \
  --query 'VpcEndpointConnections[].{endpoint:VpcEndpointId,owner:VpcEndpointOwner,state:VpcEndpointState}' --output table

start=$(date +%s)
aws ec2 accept-vpc-endpoint-connections --service-id "$SVC_ID" --vpc-endpoint-ids "$EP_ID" \
  --query 'Unsuccessful' --output text
while [[ "$(state)" != "available" ]]; do sleep 5; done
echo "endpoint $EP_ID available $(( $(date +%s) - start )) s after acceptance"
mkdir -p results
echo "privatelink,accept_to_available,$(( $(date +%s) - start )),s,$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> results/provisioning.csv
