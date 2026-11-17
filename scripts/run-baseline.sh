#!/usr/bin/env bash
# Scenario S-0: k6 inside the PROVIDER VPC straight to the NLB (no PrivateLink hop).
# Runs the loadgen image as a one-off Fargate task and copies its CSV lines into results/k6.csv.
#
#   ./scripts/run-baseline.sh [rates] [ip]      e.g. ./scripts/run-baseline.sh "100 500 1000" onlyIPv6
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

RATES="${1:-100 500 1000}" IP="${2:-onlyIPv6}"
[[ "$RATES" =~ ^[0-9\ ]+$ && "$IP" =~ ^(onlyIPv6|onlyIPv4|preferIPv6|preferIPv4)$ ]] || { echo "invalid args" >&2; exit 1; }
NLB="$(out provider-platform NlbDnsName)"
TD="$(out provider-services BaselineTaskDefArn)"
LOG_GROUP="$(out provider-platform AppLogGroupName)"
SUBNET="$(aws cloudformation list-exports --query "Exports[?Name=='$P-provider-WorkloadSubnetA'].Value" --output text)"
SG="$(out provider-platform BaselineSg)"

CMD="cd /tmp && run-k6.sh --label baseline-nlb --url http://$NLB/1k --rates '$RATES' --ip $IP --pause 10 && sed 's/^/K6CSV /' results/k6.csv"
OVERRIDES="$(jq -n --arg c "$CMD" '{containerOverrides:[{name:"k6",command:["bash","-c",$c]}]}')"
ARN="$(aws ecs run-task --cluster "$P" --task-definition "$TD" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --overrides "$OVERRIDES" --started-by baseline --query 'tasks[0].taskArn' --output text)"
echo "task $ARN running (about $(( $(wc -w <<<"$RATES") * 3 )) min)"
aws ecs wait tasks-stopped --cluster "$P" --tasks "$ARN" || aws ecs wait tasks-stopped --cluster "$P" --tasks "$ARN"
sleep 5
mkdir -p results
[[ -f results/k6.csv ]] || echo "path,mode,ip,reuse,load,metric,value,unit,timestamp" > results/k6.csv
aws logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "baseline/k6/${ARN##*/}" \
  --query 'events[].message' --output text | tr '\t' '\n' | grep '^K6CSV ' | sed 's/^K6CSV //' \
  | grep -v '^path,' | tee -a results/k6.csv
