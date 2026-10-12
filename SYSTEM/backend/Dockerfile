FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS frontend-build

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

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS backend-build

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
RUN npm ci

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

RUN npm run build
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

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime

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
  && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-client \
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
RUN npm ci --omit=dev

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

CMD ["sh", "-c", "npm run backup:restore-pending && exec npm run start"]
