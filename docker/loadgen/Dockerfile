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
# /work/scratch is the writable working directory of the Fargate baseline task (S-0): Fargate creates
# bind-mount volumes as root:0755 unless the container path exists in the image, in which case the
# directory's ownership is copied - so the non-root user can write there with a read-only root FS.
RUN mkdir -p /work/scratch && chown 12345:12345 /work/scratch
WORKDIR /work
USER 12345
ENTRYPOINT []
CMD ["k6", "version"]
