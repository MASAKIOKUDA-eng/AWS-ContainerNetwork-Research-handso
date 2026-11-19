#!/usr/bin/env bash
# Uploads random 1 KiB / 1 MiB test objects to the data and outside buckets (run in CloudShell).
# Reads of these objects are only possible through the consumer VPC endpoints (bucket policy).
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
head -c 1024 /dev/urandom > "$tmp/1k"
head -c 1048576 /dev/urandom > "$tmp/1m"
for b in "$(out consumer DataBucketName)" "$(out consumer OutsideBucketName)"; do
  for o in 1k 1m; do
    aws s3api put-object --bucket "$b" --key "$o" --body "$tmp/$o" --query ETag --output text
  done
done
echo "Check from CloudShell (internet path) - this MUST fail with 403:"
echo "  curl -s -o /dev/null -w '%{http_code}' https://$(out consumer DataBucketName).s3.dualstack.$AWS_REGION.amazonaws.com/1k"
