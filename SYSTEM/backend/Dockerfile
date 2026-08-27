FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS frontend-build

WORKDIR /app/SYSTEM/frontend

# A release source tree intentionally contains no generated backend/public
# directory. Build the exact frontend from its lockfile inside BuildKit so a
# fresh runtime never depends on host node_modules or an unpublished artifact.
COPY SYSTEM/frontend/package*.json ./
RUN npm ci
COPY SYSTEM/frontend ./
COPY SYSTEM/app /app/SYSTEM/app
RUN npm run build

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS backend-build

WORKDIR /app/backend

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Build context is the repository root. The closed image includes:
# - SYSTEM/backend
# - the exact-tree verified prebuilt SYSTEM frontend
# - installable module packages under SYSTEM/app and SYSTEM/addons
COPY SYSTEM/backend/package*.json ./
RUN npm ci

COPY SYSTEM/backend/tsconfig.json ./
COPY SYSTEM/backend/tsconfig.seed.json ./
COPY SYSTEM/backend/prisma.config.ts ./
COPY SYSTEM/backend/prisma ./prisma
COPY SYSTEM/backend/config ./config
COPY SYSTEM/backend/scripts/modules ./scripts/modules
COPY SYSTEM/backend/scripts/runtime ./scripts/runtime
COPY SYSTEM/backend/scripts/setup ./scripts/setup
COPY SYSTEM/backend/src ./src
COPY SYSTEM/app /app/app
COPY --from=frontend-build /app/SYSTEM/frontend/dist ./public/system

ENV NODE_ENV=production
ENV RUN_SYSTEM_ROOT=/app/run_system
ENV BONNI_PROJECT_ROOT=/app

RUN npm run build
RUN npm run modules:build
RUN npm run modules:verify
RUN npm run modules:sync-legal-payloads
RUN npm run modules:stage-runtime -- /app/runtime-packages
RUN node scripts/setup/prebuilt-frontend.mjs --write public/system
RUN node scripts/setup/prebuilt-frontend.mjs --verify public/system

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime

ARG BONNI_CORE_VERSION=0.1.20
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
COPY --from=backend-build /app/backend/node_modules/.prisma ./node_modules/.prisma
COPY --from=backend-build /app/backend/node_modules/@prisma/client ./node_modules/@prisma/client

# Installierbare Pakete werden generisch entdeckt, gebaut und als eigenständige
# Verzeichnisse neben Core übernommen. Neue Apps/Add-ons benötigen keine
# Dockerfile-Sonderbehandlung.
COPY --from=backend-build /app/runtime-packages/app /app/app
COPY --from=backend-build /app/runtime-packages/apps /app/apps
COPY --from=backend-build /app/runtime-packages/addons /app/addons
COPY --from=backend-build /app/runtime-packages/plugins /app/plugins
COPY --from=backend-build /app/runtime-packages/bridges /app/bridges
COPY --from=backend-build /app/licenses /app/licenses

# Frontend build outputs are baked into the same closed system container.
COPY --from=backend-build /app/backend/public/system /app/public/system

# Dynamisch geladener App-Code findet dieselben Runtime-Abhängigkeiten wie Core.
RUN ln -s /app/backend/node_modules /app/node_modules \
  && mkdir -p /app/run_system/system /app/run_system/storage/media /app/run_system/storage/licenses /app/run_system/archiv/logs /app/public/system

EXPOSE 4000 4001 4002

CMD ["sh", "-c", "npm run backup:restore-pending && exec npm run start"]
