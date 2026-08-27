FROM docker:29.6.2-cli@sha256:be132a9f282288de4afaf63379dff75711fda0147c6b72a9df44e51841402144 AS dockercli

FROM node:22.22.0-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34

RUN apk add --no-cache postgresql-client

COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

WORKDIR /runner/SYSTEM/backend
COPY SYSTEM/backend/src/system/update-runner ./src/system/update-runner
COPY SYSTEM/backend/ops/update-runner ./ops/update-runner
COPY SYSTEM/backend/scripts/backup/update-cutover-snapshot-lib.mjs ./scripts/backup/update-cutover-snapshot-lib.mjs
COPY SYSTEM/backend/scripts/backup/update-cutover-snapshot.mjs ./scripts/backup/update-cutover-snapshot.mjs
COPY SYSTEM/backend/scripts/backup/update-cutover-retention.mjs ./scripts/backup/update-cutover-retention.mjs
COPY SYSTEM/backend/scripts/runtime/runtime-mode-exclusion.mjs ./scripts/runtime/runtime-mode-exclusion.mjs

ENTRYPOINT ["node", "/runner/SYSTEM/backend/ops/update-runner/run.mjs"]
