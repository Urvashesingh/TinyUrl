# syntax=docker/dockerfile:1

# --- build -------------------------------------------------------------
# Full dependency tree, TypeScript compiler, Prisma generation.
FROM node:22-alpine AS build
WORKDIR /app

# Copied before the source so a source-only change does not invalidate the
# dependency layer. prisma/ is needed here because postinstall runs
# `prisma generate`, which reads the schema.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
# The partition-maintenance CronJob runs scripts/partitions.ts from this stage,
# so it has to be in the image even though the runtime stage never sees it.
COPY scripts ./scripts
RUN npm run build

# --- runtime -----------------------------------------------------------
# Production dependencies only, no compiler, no test tooling.
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY prisma ./prisma

# --ignore-scripts because postinstall would run `prisma generate`, and the
# Prisma CLI is a devDependency that is deliberately not in this image. The
# generated client is copied from the build stage instead.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
# The demo console is served by GET /, so it has to be in the runtime image.
COPY public ./public

# node:alpine ships an unprivileged "node" user. Running as root inside a
# container is a container escape away from being root on the host.
USER node

EXPOSE 3000

# Liveness only -- deliberately does not check Postgres, so a database blip
# does not get every healthy container restarted.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/index.js"]
