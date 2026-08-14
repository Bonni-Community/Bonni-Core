FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS backend-build

WORKDIR /app/backend

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Build context is the repository root. The closed image includes:
# - System/backend
# - the exact-tree verified prebuilt System frontend
# - installable module packages under System/app and System/addons
COPY System/backend/package*.json ./
RUN npm ci

COPY System/backend/tsconfig.json ./
COPY System/backend/tsconfig.seed.json ./
COPY System/backend/prisma.config.ts ./
COPY System/backend/prisma ./prisma
COPY System/backend/config ./config
COPY System/backend/scripts/modules ./scripts/modules
COPY System/backend/scripts/setup ./scripts/setup
COPY System/backend/src ./src
COPY System/backend/public ./public
COPY System/app /app/app

ENV NODE_ENV=production
ENV RUN_SYSTEM_ROOT=/app/run_system
ENV BONNI_PROJECT_ROOT=/app

RUN npm run build
RUN npm run modules:build
RUN npm run modules:verify
RUN npm run modules:sync-legal-payloads
RUN npm run modules:stage-runtime -- /app/runtime-packages
RUN node scripts/setup/prebuilt-frontend.mjs --verify public/system

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime

ARG BONNI_CORE_VERSION=0.1.19
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

COPY System/backend/package*.json ./
RUN npm ci --omit=dev

# System backend runtime.
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=backend-build /app/backend/prisma ./prisma
COPY --from=backend-build /app/backend/prisma.config.ts ./prisma.config.ts
COPY --from=backend-build /app/backend/config ./config
COPY System/backend/scripts/auth ./scripts/auth
COPY System/backend/scripts/backup ./scripts/backup
COPY System/backend/scripts/runtime ./scripts/runtime
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
