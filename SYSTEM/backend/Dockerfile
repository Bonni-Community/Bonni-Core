# BONNI_ARMV7_ENGINES_V2
ARG TARGETARCH
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS bonni-node-host
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS bonni-node-target
FROM ubuntu:22.04@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401 AS bonni-arm-os
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates openssl libssl3 zlib1g libreadline8 libstdc++6 libatomic1 locales tzdata \
    && rm -rf /var/lib/apt/lists/*
RUN localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8

FROM bonni-arm-os AS bonni-pg-build
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      curl bzip2 build-essential libssl-dev zlib1g-dev libreadline-dev bison flex \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl --fail --show-error --location --proto '=https' --tlsv1.2 \
      https://ftp.postgresql.org/pub/source/v16.14/postgresql-16.14.tar.bz2 -o postgres.tar.bz2 \
    && echo 'f6d077142737920858ce958ccdb75c6ee137a63b5b0853c70693d401ac7e3471  postgres.tar.bz2' | sha256sum -c - \
    && tar -xjf postgres.tar.bz2 --strip-components=1 \
    && ./configure --prefix=/usr/local/pgsql --with-openssl --without-icu \
      --with-system-tzdata=/usr/share/zoneinfo \
      LDFLAGS='-Wl,-z,max-page-size=65536 -Wl,-z,common-page-size=65536 -Wl,-rpath,/usr/local/pgsql/lib' \
    && make -j2 world-bin && make install-world-bin \
    && cp COPYRIGHT /usr/local/pgsql/COPYRIGHT

FROM bonni-arm-os AS bonni-base-arm
COPY --from=bonni-node-target /usr/local /usr/local
COPY --from=bonni-pg-build /usr/local/pgsql /usr/local/pgsql
ENV PATH=/usr/local/pgsql/bin:$PATH
RUN echo /usr/local/pgsql/lib > /etc/ld.so.conf.d/bonni-postgresql.conf && ldconfig && node --version && pg_dump --version
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS bonni-base-amd64
FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS bonni-base-arm64
FROM --platform=$BUILDPLATFORM ubuntu:22.04@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401 AS bonni-engines
COPY --from=bonni-node-host /usr/local /usr/local
ARG TARGETARCH
ARG TARGETVARIANT
WORKDIR /work
COPY SYSTEM/backend/package-lock.json ./package-lock.json
COPY SYSTEM/backend/scripts/runtime/build-armv7-engines.sh ./build-armv7-engines.sh
RUN sh ./build-armv7-engines.sh

FROM bonni-node-host AS frontend-build

ARG BONNI_CORE_VERSION=0.1.21

WORKDIR /app/SYSTEM/frontend

# A release source tree intentionally contains no generated backend/public
# directory. Build the exact frontend from its lockfile inside BuildKit so a
# fresh runtime never depends on host node_modules or an unpublished artifact.
COPY SYSTEM/frontend/package*.json ./
RUN npm ci
COPY SYSTEM/frontend ./
RUN npm run build
COPY SYSTEM/backend/scripts/licenses /app/license-scripts
RUN node /app/license-scripts/build-core-license-component.mjs \
      --package-root /app/SYSTEM/frontend \
      --output-root /app/core-licenses/frontend \
      --component frontend \
      --version "${BONNI_CORE_VERSION}"

FROM bonni-base-${TARGETARCH} AS backend-build
COPY --from=bonni-engines /opt/bonni-engines /opt/bonni-engines

ARG BONNI_CORE_VERSION=0.1.21

WORKDIR /app/backend

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Build context is the repository root. The closed image includes:
# - SYSTEM/backend
# - the exact-tree verified prebuilt SYSTEM frontend
# Fach-Apps und Add-ons bleiben vollständig außerhalb dieses Core-Images.
COPY SYSTEM/backend/package*.json ./
RUN . /opt/bonni-engines/environment.sh && npm ci

COPY SYSTEM/backend/tsconfig.json ./
COPY SYSTEM/backend/tsconfig.seed.json ./
COPY SYSTEM/backend/prisma.config.ts ./
COPY SYSTEM/backend/prisma ./prisma
COPY SYSTEM/backend/config ./config
COPY SYSTEM/backend/scripts/modules ./scripts/modules
COPY SYSTEM/backend/scripts/licenses ./scripts/licenses
COPY SYSTEM/backend/scripts/runtime ./scripts/runtime
COPY SYSTEM/backend/scripts/storage ./scripts/storage
COPY SYSTEM/backend/scripts/setup ./scripts/setup
COPY SYSTEM/backend/legal ./legal
COPY SYSTEM/backend/src ./src
COPY --from=frontend-build /app/SYSTEM/frontend/dist ./public/system
COPY --from=frontend-build /app/core-licenses/frontend /app/licenses/platform/bonni-core/${BONNI_CORE_VERSION}/frontend

ENV NODE_ENV=production
ENV RUN_SYSTEM_ROOT=/app/run_system
ENV BONNI_PROJECT_ROOT=/app

RUN . /opt/bonni-engines/environment.sh && npm run build
RUN node scripts/licenses/build-core-license-component.mjs \
      --package-root /app/backend \
      --output-root /app/licenses/platform/bonni-core/${BONNI_CORE_VERSION}/backend \
      --component backend \
      --version "${BONNI_CORE_VERSION}"
RUN node scripts/licenses/finalize-core-license-payload.mjs \
      --license-root /app/licenses \
      --version "${BONNI_CORE_VERSION}" \
      --notice /app/backend/legal/BONNI_CORE_LICENSE_NOTICE.md
RUN node scripts/setup/prebuilt-frontend.mjs --write public/system
RUN node scripts/setup/prebuilt-frontend.mjs --verify public/system

FROM bonni-base-${TARGETARCH} AS runtime
COPY --from=bonni-engines /opt/bonni-engines /opt/bonni-engines

ARG BONNI_CORE_VERSION=0.1.21
ARG BONNI_CORE_REVISION=unknown

LABEL org.opencontainers.image.title="Bonni Core" \
      org.opencontainers.image.description="Bonni Core closed system runtime" \
      org.opencontainers.image.version="${BONNI_CORE_VERSION}" \
      org.opencontainers.image.revision="${BONNI_CORE_REVISION}" \
      org.bonni.product="bonni-core" \
      org.bonni.runtime.contract="1"

WORKDIR /app/backend

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates $(if [ "$(dpkg --print-architecture)" != armhf ]; then echo postgresql-client; fi) \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=4000
ENV LOCAL_AUTH_BIND=0.0.0.0
ENV LOCAL_AUTH_PORT=4001
ENV RUN_SYSTEM_ROOT=/app/run_system
ENV BONNI_PROJECT_ROOT=/app
ENV FRONTEND_DIST_ROOT=/app/public
ENV BONNI_CORE_IMAGE_VERSION=${BONNI_CORE_VERSION}
ENV BONNI_CORE_LICENSE_SEED_ROOT=/app/licenses
ENV BONNI_CORE_LICENSE_PREDECESSOR_SEED_ROOT=/app/license-predecessors
ENV BONNI_LICENSE_ROOT=/app/run_system/storage/licenses

COPY SYSTEM/backend/package*.json ./
RUN . /opt/bonni-engines/environment.sh && npm ci --omit=dev

# SYSTEM backend runtime.
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=backend-build /app/backend/prisma ./prisma
COPY --from=backend-build /app/backend/prisma.config.ts ./prisma.config.ts
COPY --from=backend-build /app/backend/config ./config
COPY SYSTEM/backend/scripts/auth ./scripts/auth
COPY SYSTEM/backend/scripts/backup ./scripts/backup
COPY SYSTEM/backend/scripts/maintenance ./scripts/maintenance
COPY SYSTEM/backend/scripts/runtime ./scripts/runtime
COPY SYSTEM/backend/scripts/storage ./scripts/storage
COPY SYSTEM/backend/scripts/database ./scripts/database
COPY SYSTEM/backend/scripts/licenses/license-payload-utils.mjs ./scripts/licenses/license-payload-utils.mjs
COPY SYSTEM/backend/ops/migrations ./ops/migrations
COPY --from=backend-build /app/backend/node_modules/.prisma ./node_modules/.prisma
COPY --from=backend-build /app/backend/node_modules/@prisma/client ./node_modules/@prisma/client

# Das offizielle Core-Image enthält ausschließlich Bonni Core. Apps, Add-ons,
# Plugins und Bridges werden später als eigenständige signierte Pakete
# installiert und sind deshalb nicht Bestandteil dieses Images.
COPY --from=backend-build /app/licenses /app/licenses
COPY SYSTEM/backend/legal/core-license-predecessors /app/license-predecessors

# Frontend build outputs are baked into the same closed system container.
COPY --from=backend-build /app/backend/public/system /app/public/system

# Dynamisch geladener App-Code findet dieselben Runtime-Abhängigkeiten wie Core.
RUN ln -s /app/backend/node_modules /app/node_modules \
  && mkdir -p /app/app /app/apps /app/addons /app/plugins /app/bridges \
       /app/run_system/system /app/run_system/storage/media /app/run_system/storage/licenses \
       /app/run_system/archiv/logs /app/public/system

EXPOSE 4000 4001 4002

ENTRYPOINT ["/opt/bonni-engines/entrypoint.sh"]
CMD ["sh", "-c", "npm run backup:restore-pending && exec npm run start"]
