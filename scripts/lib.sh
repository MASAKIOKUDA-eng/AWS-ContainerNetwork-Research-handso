#!/usr/bin/env bash
# Shared helpers for the CloudShell-side scripts (sourced, not executed).
P="${PREFIX:-v6lab}"
[[ "$P" =~ ^[a-z0-9-]{3,16}$ ]] || { echo "invalid PREFIX" >&2; exit 1; }
: "${AWS_REGION:?set AWS_REGION}"

out() {  # out <stack-suffix> <OutputKey>
  aws cloudformation describe-stacks --stack-name "$P-$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}
