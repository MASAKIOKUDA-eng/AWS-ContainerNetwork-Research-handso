# Load generator image: k6 + curl + dig + the measurement scripts.
# Build from the repository root so the scripts can be copied in:
#   docker build -f docker/loadgen/Dockerfile -t <repo>:v1 .
# Pin the base image by digest before you build for the talk, e.g.
#   --build-arg BASE=grafana/k6@sha256:<digest>
ARG BASE=grafana/k6:latest
FROM ${BASE}
USER root
RUN apk upgrade --no-cache && apk add --no-cache bash curl jq bind-tools coreutils
COPY scripts/k6-load.js scripts/run-k6.sh scripts/probe-paths.sh /opt/v6lab/
RUN chmod 0555 /opt/v6lab/*.sh \
 && ln -s /opt/v6lab/run-k6.sh /usr/local/bin/run-k6.sh \
 && ln -s /opt/v6lab/probe-paths.sh /usr/local/bin/probe-paths.sh
# Results are written to /work/results (mount a host directory there).
# /work/scratch is the writable working directory of the Fargate baseline task (S-0); the task's
# init container chowns the volume mounted there (see BaselineTaskDef in lib/provider-stack.ts).
RUN mkdir -p /work/scratch && chown 12345:12345 /work/scratch
WORKDIR /work
USER 12345
ENTRYPOINT []
CMD ["k6", "version"]
