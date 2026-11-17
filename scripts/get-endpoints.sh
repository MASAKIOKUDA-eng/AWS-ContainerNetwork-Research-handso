#!/usr/bin/env bash
# Prints the "export ..." lines to paste into the load generator session (run in CloudShell).
# The load generator has no route to the CloudFormation API on purpose, so values are copied by hand.
#
#   ./scripts/get-endpoints.sh
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

cat <<EOT
export AWS_REGION=$AWS_REGION
export PL_DNS=$(out consumer PrivateLinkEndpointDns)
export LATTICE_DNS=$(out provider-platform LatticeServiceDns)
export S3IF_DNS='$(out consumer S3InterfaceEndpointDns)'
export DATA_BUCKET=$(out consumer DataBucketName)
export OUTSIDE_BUCKET=$(out consumer OutsideBucketName)
export LOADGEN_IMAGE=${LOADGEN_IMAGE:-<set LOADGEN_IMAGE (repo@sha256:digest)>}
EOT
