# Test target image: nginx (non-root, port 8080, IPv4 + IPv6 listener).
# Pin the base image by digest before you build for the talk, e.g.
#   docker build --build-arg BASE=public.ecr.aws/nginx/nginx-unprivileged@sha256:<digest> ...
ARG BASE=public.ecr.aws/nginx/nginx-unprivileged:stable-alpine
FROM ${BASE}

USER root
RUN apk upgrade --no-cache \
 && mkdir -p /usr/share/nginx/html \
 && head -c 1024    /dev/urandom > /usr/share/nginx/html/1k \
 && head -c 102400  /dev/urandom > /usr/share/nginx/html/100k \
 && head -c 1048576 /dev/urandom > /usr/share/nginx/html/1m \
 && chown -R 101:101 /usr/share/nginx/html \
 && mkdir -p /tmp && chown 101:101 /tmp && chmod 1777 /tmp
COPY nginx.conf /etc/nginx/nginx.conf

# The root filesystem is read-only in ECS; nginx writes only to /tmp (task volume).
VOLUME ["/tmp"]
USER 101
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
