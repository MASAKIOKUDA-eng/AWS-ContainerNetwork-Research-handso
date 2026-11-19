#!/usr/bin/env bash
# Switches the load generator between the trusted and the untrusted client security group (X-1).
#
#   ./scripts/swap-client-sg.sh untrusted   # then run: lg probe-paths.sh --context untrusted
#   ./scripts/swap-client-sg.sh trusted     # always switch back afterwards
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

case "${1:-}" in
  trusted) SG="$(out consumer TrustedClientSg)" ;;
  untrusted) SG="$(out consumer UntrustedClientSg)" ;;
  *) echo "usage: $0 trusted|untrusted" >&2; exit 1 ;;
esac
ID="$(out consumer LoadgenInstanceId)"
aws ec2 modify-instance-attribute --instance-id "$ID" --groups "$SG"
aws ec2 describe-instances --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].SecurityGroups[].GroupName' --output text
