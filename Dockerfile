FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# .env.build only needs to make DATABASE_URL syntactically valid for `prisma generate`
# (schema path itself comes from prisma.config.ts); no real DB connectivity required.
RUN bun run --bun --env-file=.env.build prisma generate

ENV NODE_ENV=production
EXPOSE 3000

USER bun
CMD ["bun", "run", "src/index.ts"]
