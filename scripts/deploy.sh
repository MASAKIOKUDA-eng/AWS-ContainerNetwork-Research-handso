#!/usr/bin/env bash
# Deploys all stacks with cdkd (CDK app, no CloudFormation stacks) and keeps a log in deploy-logs/.
#
#   AWS_REGION=ap-northeast-1 npm run deploy                                   # dual-stack, defaults from cdk.json
#   AWS_REGION=ap-northeast-1 npm run deploy -- -c workloadIpMode=ipv6only     # extra cdkd options pass through
#   AWS_REGION=ap-northeast-1 npm run deploy -- -c latticeAuthMode=iam-required
#
# - Stack outputs: cdk-outputs.json (read by the other scripts; contains resource IDs, not committed)
# - Log: deploy-logs/<UTC>.log (colour codes removed, account ID masked) + one line in deploy-logs/HISTORY.md
#   The deploy time per run is talk material (speed scenario S-6); check a log before you commit or share it.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
LOG_DIR=deploy-logs
mkdir -p "$LOG_DIR"

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
log_file="$LOG_DIR/$stamp.log"
region=${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-1}}
export CDK_DEFAULT_REGION="$region"
commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
dirty=$([ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] && echo " (uncommitted changes)" || echo "")
account=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")
[ -n "$account" ] || { echo "AWS credentials not found (aws sts get-caller-identity failed)" >&2; exit 1; }
export CDK_DEFAULT_ACCOUNT="$account"

sanitize() { sed -e $'s/\x1b\\[[0-9;]*[A-Za-z]//g' -e "s/$account/<ACCOUNT_ID>/g"; }

{
  echo "# cdkd deploy log"
  echo "started_at: $started_at"
  echo "commit:     $commit$dirty"
  echo "region:     $region"
  echo "command:    cdkd deploy --all --outputs-file cdk-outputs.json $*"
  echo "----------------------------------------"
} | sanitize >"$log_file"

start_s=$(date +%s)
raw=$(mktemp); trap 'rm -f "$raw"' EXIT
npx cdkd deploy --all --outputs-file cdk-outputs.json "$@" 2>&1 | tee "$raw"
status=${PIPESTATUS[0]}
duration=$(($(date +%s) - start_s))
sanitize <"$raw" >>"$log_file"
chmod 600 cdk-outputs.json 2>/dev/null || true

result=$([ "$status" -eq 0 ] && echo "success" || echo "failed (exit $status)")
{
  echo "----------------------------------------"
  echo "finished_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "duration:    ${duration}s"
  echo "result:      $result"
} >>"$log_file"

history="$LOG_DIR/HISTORY.md"
if [ ! -f "$history" ]; then
  # shellcheck disable=SC2016  # backticks are Markdown, not command substitution
  printf '# Deploy history\n\nOne line per `npm run deploy` / `npm run destroy`.\n\n| UTC | commit | region | command | result | duration | log |\n| --- | --- | --- | --- | --- | --- | --- |\n' >"$history"
fi
args=$(printf '%s ' "$@" | sed 's/|/\\|/g')
echo "| $started_at | \`$commit\`$dirty | $region | deploy ${args} | $result | ${duration}s | $stamp.log |" >>"$history"
echo
echo "log: $log_file (history: $history)"
exit "$status"
