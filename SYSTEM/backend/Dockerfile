FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS backend-build

WORKDIR /app/backend

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Build context is the repository root. The closed image includes:
# - System/backend
# - System/frontend build output
# - installable Apps under System/app
COPY System/backend/package*.json ./
RUN npm ci

COPY System/backend/tsconfig.json ./
COPY System/backend/prisma.config.ts ./
COPY System/backend/prisma ./prisma
COPY System/backend/config ./config
COPY System/backend/src ./src

ENV NODE_ENV=production
ENV DATABASE_URL=postgresql://postgres:postgres@db:5432/stueberlapp?schema=public
ENV MASTER_KEY=change-me-long-random-master-key
ENV RUN_SYSTEM_ROOT=/app/run_system
ENV BONNI_PROJECT_ROOT=/app

RUN npm run prisma:generate
RUN npm run build

FROM backend-build AS stueberlapp-backend-build

WORKDIR /app/app/stueberlapp/backend
COPY System/app/stueberlapp/backend/package*.json ./
RUN npm ci --include=dev
COPY System/app/stueberlapp/backend/tsconfig.json ./
COPY System/app/stueberlapp/backend/scripts ./scripts
COPY System/app/stueberlapp/backend/src ./src

# Der App-Client wird aus exakt demselben assemblierten Core-Schema erzeugt.
RUN node scripts/sync-prisma-client.mjs
RUN npx tsc

FROM backend-build AS hocketapp-backend-build

WORKDIR /app/app/hocketapp/backend
COPY System/app/hocketapp/backend/package*.json ./
RUN npm ci --include=dev
COPY System/app/hocketapp/backend/tsconfig.json ./
COPY System/app/hocketapp/backend/src ./src
RUN npm run build

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS system-frontend-build

WORKDIR /frontend
COPY System/frontend/package*.json ./
RUN npm ci
COPY System/frontend ./
ENV NODE_ENV=production
RUN npm run build

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS stueberlapp-frontend-build

WORKDIR /frontend
COPY System/app/stueberlapp/frontend/package*.json ./
RUN npm ci
COPY System/app/stueberlapp/frontend ./
ENV NODE_ENV=production
RUN npm run build

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS kontorapp-frontend-build

WORKDIR /frontend
COPY System/app/kontorapp/frontend/package*.json ./
RUN npm ci
COPY System/app/kontorapp/frontend ./
ENV NODE_ENV=production
RUN npm run build

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS hocketapp-frontend-build

WORKDIR /frontend
COPY System/app/hocketapp/frontend/package*.json ./
RUN npm ci
COPY System/app/hocketapp/frontend ./
ENV NODE_ENV=production
RUN npm run build

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime

ARG BONNI_CORE_VERSION=0.1.13
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
COPY System/backend/scripts/backup ./scripts/backup
COPY System/backend/scripts/runtime ./scripts/runtime
COPY --from=backend-build /app/backend/node_modules/.prisma ./node_modules/.prisma
COPY --from=backend-build /app/backend/node_modules/@prisma/client ./node_modules/@prisma/client

# Installierbare Pakete bleiben voneinander unabhängig und liegen neben Core.
COPY System/app/stueberlapp/manifest.ts /app/app/stueberlapp/manifest.ts
COPY System/app/stueberlapp/prisma /app/app/stueberlapp/prisma
COPY System/app/stueberlapp/backend/package.json /app/app/stueberlapp/backend/package.json
COPY --from=stueberlapp-backend-build /app/app/stueberlapp/backend/dist /app/app/stueberlapp/backend/dist
COPY --from=stueberlapp-frontend-build /frontend/dist /app/app/stueberlapp/frontend/dist

COPY System/app/kontorapp/manifest.ts /app/app/kontorapp/manifest.ts
COPY System/app/kontorapp/prisma /app/app/kontorapp/prisma
COPY --from=kontorapp-frontend-build /frontend/dist /app/app/kontorapp/frontend/dist

COPY System/app/hocketapp/manifest.ts /app/app/hocketapp/manifest.ts
COPY System/app/hocketapp/backend/package.json /app/app/hocketapp/backend/package.json
COPY --from=hocketapp-backend-build /app/app/hocketapp/backend/dist /app/app/hocketapp/backend/dist
COPY --from=hocketapp-frontend-build /frontend/dist /app/app/hocketapp/frontend/dist

# Bonni Network bleibt ein separat installierbares Add-on. Seine Laufzeit
# besteht aus nativen ESM-Modulen und bereits gebauten Frontend-Dateien, daher
# ist keine eigene Build-Stage nötig. Das Paket muss dennoch im geschlossenen
# Image liegen, damit der Store es entdecken und gezielt aktivieren kann.
COPY System/addons/bonni-network /app/addons/bonni-network

# Frontend build outputs are baked into the same closed system container.
COPY --from=system-frontend-build /frontend/dist /app/public/system

# Dynamisch geladener App-Code findet dieselben Runtime-Abhängigkeiten wie Core.
RUN ln -s /app/backend/node_modules /app/node_modules \
  && mkdir -p /app/run_system/system /app/run_system/storage/media /app/run_system/storage/licenses /app/run_system/archiv/logs /app/storage/addons/bonni-network /app/public/system

EXPOSE 4000 4001 4002

CMD ["sh", "-c", "npm run backup:restore-pending && exec npm run start"]
