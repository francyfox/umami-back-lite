# syntax=docker/dockerfile:1.7

# oven/bun:1-alpine (the floating tag) is pinned back to bun 1.3.14 as of
# this writing while oven/bun:1 (debian) and this repo's own bun.lock are on
# 1.4.0 — the older alpine image can't parse our lockfile's lockfileVersion
# 2 ("Unknown lockfile version", verified locally) and `--frozen-lockfile`
# then hard-fails. Pin the version explicitly so alpine and debian stay in
# lockstep instead of silently drifting apart again; bump alongside bun-types
# in package.json when upgrading bun.
#
# Builder stage: full deps (build tooling + all runtime deps) needed to run
# `prisma generate` and the tsdown bundle. Discarded below — only dist/ and
# the geo database survive into the runtime stage.
FROM oven/bun:1.4-alpine AS builder
WORKDIR /app

COPY package.json bun.lock ./
# @clickhouse/client resolves to this local shim (package.json's "file:"
# dependency) — needs to exist before `bun install` runs, so it's copied
# ahead of the main COPY . . below.
COPY local-shims ./local-shims
# Cache mount keeps bun's global package cache out of the image layer
# entirely (BuildKit-only storage, never committed) instead of writing it
# into this RUN's layer and hoping a later `rm -rf` shrinks anything — it
# wouldn't; Docker layers are additive, so cleanup has to happen in the same
# RUN or, better, never touch a layer at all.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

COPY . .
# .env.build only needs to make DATABASE_URL syntactically valid for `prisma generate`
# (schema path itself comes from prisma.config.ts); no real DB connectivity required.
RUN bun run --bun --env-file=.env.build prisma generate

# Without this, /api/send 500s for every real (non-local) visitor IP —
# vendor/umami/src/lib/detect.ts throws opening a missing geo database. See
# scripts/download-geo-db.ts for why this is DB-IP's free Country Lite
# database and not a full city-level one (memory, not licensing).
RUN bun scripts/download-geo-db.ts geo/dbip-country-lite.mmdb

# Bundled build (see tsdown.config.ts, scripts/generate-route-manifest.ts):
# measurably better than running src/index.ts directly — ~32% faster
# container start (skips the runtime Bun.Glob scan + per-file regex parse
# across 127 route.ts files that mount.ts's normal path does), and under
# concurrent load, ~15% more req/s with p99 latency more than 2x better on
# the write path (/api/send and its transitive deps no longer pay on-the-fly
# TS transpilation on first hit — dist/ is already plain compiled JS).
# The generated Prisma client (vendor/umami/src/generated/prisma) is pure TS
# with no binary/wasm assets (engineType = "client" — no bundled query
# engine), so tsdown traces and inlines it into dist/; it doesn't need to be
# copied into the runtime stage separately.
RUN bun run build

# Runtime stage: only production dependencies, not the build toolchain
# (tsdown/@rolldown, typescript, vitest and their transitive deps — ~90MB of
# node_modules that has no business in a running container). `prisma` (the
# CLI) is deliberately kept — it lives in package.json's "dependencies" (not
# "devDependencies") for exactly this reason, so a plain `--production`
# install still includes it, for the documented one-off `prisma migrate
# deploy` workflow (see README). `@prisma/client`/`@prisma/adapter-pg` also
# stay — those are the actual runtime query path.
#
# Measured: the previous single-stage image (debian base, full `bun install`
# with no --production, no cache mount) was 690MB — and ~480MB of that was
# bun's *own install cache* at /root/.bun, baked into the image right next to
# an almost-identical copy of it in node_modules (RUN never cleaned it, and
# there was no second stage to leave it behind in). This image: 511MB — the
# cache mount above means that duplicate is never written to a layer at all
# in the first place, on top of the production-only/alpine wins.
FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app

COPY package.json bun.lock ./
COPY local-shims ./local-shims
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/geo ./geo
# script.js/recorder.js are served by reading this file straight off disk at
# request time (src/mount.ts's mountStaticScript, via a Bun.file() path
# relative to the running module) — unlike route.ts handlers, which the
# manifest-driven bundled build inlines into dist/, these two are read raw
# and are NOT bundled, so they have to physically exist here.
COPY --from=builder /app/vendor/umami/public ./vendor/umami/public
# Needed only for `prisma migrate deploy` (the CLI reads these at the path
# prisma.config.ts points at) — not by the app itself, which never imports
# these files directly (see comment on RUN bun run build above).
COPY vendor/umami/prisma ./vendor/umami/prisma
COPY prisma.config.ts ./

ENV NODE_ENV=production
ENV GEOLITE_DB_PATH=/app/geo/dbip-country-lite.mmdb
EXPOSE 3000

USER bun
CMD ["bun", "run", "dist/index.build.mjs"]
