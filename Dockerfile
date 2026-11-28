# syntax=docker/dockerfile:1
# SMARTAUTO FLEX - multi-stage build.
#   builder: full toolchain; also used by the `migrate` service (prisma + seed)
#   runner:  minimal Next.js standalone server, non-root

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma/schema.prisma prisma/schema.prisma
RUN npm ci

FROM deps AS builder
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# The build never connects to the database; Prisma only needs the variables to exist.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build" DIRECT_URL="postgresql://build:build@localhost:5432/build"
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
# The runtime only needs `node`: the bundled npm/corepack (and their dependency
# trees and CVEs) are removed from the production image. Debian security fixes
# published after the base image was built (e.g. PAM, zstd) are installed here.
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 saf && useradd --system --uid 1001 --gid saf saf \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
            /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=builder --chown=saf:saf /app/.next/standalone ./
COPY --from=builder --chown=saf:saf /app/.next/static ./.next/static
# Prisma query engine and native modules (not always picked up by output tracing).
COPY --from=builder --chown=saf:saf /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=saf:saf /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=saf:saf /app/node_modules/@node-rs ./node_modules/@node-rs
RUN mkdir -p /app/storage && chown saf:saf /app/storage
USER saf
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
