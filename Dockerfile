# ── Stage 1: install all dependencies ─────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy all workspace package manifests — yarn needs them all to resolve hoisted deps.
COPY package.json yarn.lock ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/outbox-relay/package.json ./packages/outbox-relay/package.json
COPY packages/settlement-worker/package.json ./packages/settlement-worker/package.json
COPY packages/audit-consumer/package.json ./packages/audit-consumer/package.json

RUN yarn install --frozen-lockfile

# ── Stage 2: build ─────────────────────────────────────────────────────────────
FROM deps AS builder

COPY tsconfig.base.json ./
COPY packages/ ./packages/

# Build shared first so all workspace packages can import from its dist/
RUN yarn workspace @ledger/shared build && yarn build

# ── Stage 3: production runtime ────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# SERVICE selects which compiled package to run (api | outbox-relay | settlement-worker | audit-consumer)
ARG SERVICE
ENV SERVICE=${SERVICE}

WORKDIR /app

# Install production deps only (hoisted into root node_modules)
COPY package.json yarn.lock ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/outbox-relay/package.json ./packages/outbox-relay/package.json
COPY packages/settlement-worker/package.json ./packages/settlement-worker/package.json
COPY packages/audit-consumer/package.json ./packages/audit-consumer/package.json

RUN yarn install --frozen-lockfile --production

# Copy compiled output for shared (always needed) and the selected service
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/${SERVICE}/dist ./packages/${SERVICE}/dist

USER node

EXPOSE 3000

# exec replaces the shell so Node receives SIGTERM directly (PID 1)
ENTRYPOINT ["sh", "-c", "exec node packages/$SERVICE/dist/index.js"]
