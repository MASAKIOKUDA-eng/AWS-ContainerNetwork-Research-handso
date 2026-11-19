#!/usr/bin/env bash
# Deletes every stack of the lab with cdkd, after emptying the two S3 buckets.
#
#   AWS_REGION=ap-northeast-1 npm run destroy
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
region=${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-1}}
export CDK_DEFAULT_REGION="$region"
account=$(aws sts get-caller-identity --query Account --output text) || exit 1
export CDK_DEFAULT_ACCOUNT="$account"
P="${PREFIX:-v6lab}"
[[ "$P" =~ ^[a-z0-9-]{3,16}$ ]] || { echo "invalid PREFIX" >&2; exit 1; }

# Buckets must be empty before they can be deleted (they hold only random test objects).
for b in "$P-data-$account" "$P-outside-$account"; do
  if aws s3api head-bucket --bucket "$b" 2>/dev/null; then aws s3 rm "s3://$b" --recursive --only-show-errors; fi
done

start_s=$(date +%s)
npx cdkd destroy --all --yes "$@"
status=$?
duration=$(($(date +%s) - start_s))
mkdir -p deploy-logs
[ -f deploy-logs/HISTORY.md ] && echo "| $(date -u +%Y-%m-%dT%H:%M:%SZ) | \`$(git rev-parse --short HEAD 2>/dev/null)\` | $region | destroy | $([ $status -eq 0 ] && echo success || echo "failed (exit $status)") | ${duration}s | - |" >>deploy-logs/HISTORY.md
[ $status -eq 0 ] && rm -f cdk-outputs.json
echo "Leftovers (should be empty):"
aws resourcegroupstaggingapi get-resources --tag-filters "Key=Project,Values=$P" --query 'ResourceTagMappingList[].ResourceARN' --output text
exit $status
