FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
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

ENV NODE_ENV=production
EXPOSE 3000

USER bun
CMD ["bun", "run", "src/index.ts"]
