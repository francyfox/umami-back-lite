FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
# @clickhouse/client resolves to this local shim (package.json's "file:"
# dependency) — needs to exist before `bun install` runs, so it's copied
# ahead of the main COPY . . below.
COPY local-shims ./local-shims
RUN bun install --frozen-lockfile

COPY . .
# .env.build only needs to make DATABASE_URL syntactically valid for `prisma generate`
# (schema path itself comes from prisma.config.ts); no real DB connectivity required.
RUN bun run --bun --env-file=.env.build prisma generate

# Without this, /api/send 500s for every real (non-local) visitor IP —
# vendor/umami/src/lib/detect.ts throws opening a missing geo database. See
# scripts/download-geo-db.ts for why this is DB-IP's free Country Lite
# database and not a full city-level one (memory, not licensing).
RUN bun scripts/download-geo-db.ts geo/dbip-country-lite.mmdb
ENV GEOLITE_DB_PATH=/app/geo/dbip-country-lite.mmdb

# Bundled build (see tsdown.config.ts, scripts/generate-route-manifest.ts):
# measurably better than running src/index.ts directly — ~32% faster
# container start (skips the runtime Bun.Glob scan + per-file regex parse
# across 127 route.ts files that mount.ts's normal path does), and under
# concurrent load, ~15% more req/s with p99 latency more than 2x better on
# the write path (/api/send and its transitive deps no longer pay on-the-fly
# TS transpilation on first hit — dist/ is already plain compiled JS).
# node_modules stays in the image regardless (see USER bun below), so this
# doesn't shrink it — the win here is startup time and request latency, not
# image size.
RUN bun run build

ENV NODE_ENV=production
EXPOSE 3000

USER bun
# `prisma` (the CLI, for the documented one-off `prisma migrate deploy`
# workflow — see README) lives in devDependencies, so node_modules stays in
# the image rather than being pruned in a slimmer final stage.
CMD ["bun", "run", "dist/index.build.mjs"]
