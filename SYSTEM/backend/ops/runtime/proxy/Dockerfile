FROM nginx:1.29.7-alpine-slim@sha256:0848ca84c476868cbeb6a5c2c009a98821b8540f96c44b1ba06820db50262e35

LABEL org.opencontainers.image.title="Bonni Core Runtime Proxy" \
      org.opencontainers.image.description="Fixed Bonni Core active/emergency runtime proxy" \
      org.bonni.product="bonni-core" \
      org.bonni.component="runtime-proxy"

COPY System/backend/ops/runtime/nginx/default.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/runtime-proxy/status || exit 1
