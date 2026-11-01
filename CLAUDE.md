# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`umami-back-lite` is (planned to become) a lightweight self-hosted replacement for the
Umami analytics backend. Upstream Umami is a Next.js monolith (SSR dashboard + API routes
in one process, ~220MB idle). This project splits that apart:

- **This repo** — a thin **Elysia/Bun** wrapper that vendors and directly imports Umami's
  business logic (`lib/`, `queries/`, `prisma/`, selected `route.ts` files) rather than
  reimplementing it. Runs 24/7 on a VPS, only serves the API (tracking ingestion + REST
  for the MCP integration). Target: <100MB RSS.
- **The dashboard** — stays the original, unmodified Next.js Umami frontend. It is *not*
  deployed here; it's run locally on demand and talks to the same Neon Postgres database
  directly. There is no HTTP link between the dashboard and this backend — the database is
  the only shared point of contact.


## Commands

- Install deps: `bun install`
- Run dev server (watch mode): `bun run dev` (equivalent to `bun run --watch src/index.ts`)
- Run directly: `bun run src/index.ts`
- Unit tests (vendored `lib`/`queries`/permissions, real vitest — see CI comment in
  `.github/workflows/ci.yml` for why not `bun test`'s vitest-compat shim): `bun run test`
- Integration tests (real HTTP request through our Elysia adapter into a vendored route
  handler, against a real Postgres): `bun run test:integration`
- No lint script is configured yet.
- Bundled build (see the Bundled build section below): `bun run build`, then
  `bun run start:bundled`

## Architecture notes for future work (per the fork plan)

- **Routing pattern**: don't rewrite Umami's route logic. Each vendored `route.ts` exposes
  Web-standard `Request`/`Response` handlers (e.g. `POST`); Elysia routes should just call
  through, e.g. `app.post('/api/auth/login', ({ request }) => loginRoute.POST(request))`.
  `mountRouteEntries` (`src/mount.ts`) sets `set.status` from the handler's real
  `Response.status` after calling through — without it, `set.status` stays `undefined`
  forever (vendored handlers never touch Elysia's `set`), and every request logger that
  reads it — logixlysia's `onAfterHandle` included — defaults to `200` regardless of the
  real status. Found by noticing every access-log line said 200 even for a verified-400
  `curl` response; don't drop this when touching the mounting loop.
- **Elysia 2 (`2.0.0-rc.1`)** — migrated from 1.4.29 with the official codemod
  (`bunx @elysia/codemod@latest`; it refuses to run once `elysia` is already 2.x, and wants
  an interactive "continue?" confirmation, so run it from a real/pty terminal against an
  installed 1.4 tree). It only touched `package.json` and renamed `@elysiajs/cors` →
  `@elysia/cors`; it does **not** bump `elysia-rate-limit` (needs `5.x`) or `logixlysia`
  (needs `7.x`, still a `next` pre-release) — those peer ranges are `>= 2.0.0-*` and have
  to be bumped by hand. Every Elysia-related dependency is pinned **exact** (no `rc`/`next`
  dist-tags) — Elysia 2 also declares `typebox >= 1.3.0` and `exact-mirror >= 1.2.6` as
  *peer* deps, and a stale `exact-mirror@0.2.7` left in `bun.lock` from the 1.4 era
  silently satisfied nothing; both are now explicit direct dependencies. Behaviour changes
  worth knowing: unmatched routes return RFC 9457 `application/problem+json`
  (`{"type":"not-found",...}`) instead of the plain `NOT_FOUND` text 1.4 sent. Measured
  against 1.4.29 on this host (`ab`, 3 runs each): idle RSS ~51-54MB vs ~57MB, `/api/send`
  and `/stats` against a real Postgres equal or better; the one real gap left is the
  framework-level *error* path (404 etc., logixlysia 7 writes a context tree per error),
  ~30% fewer req/s — real tracking/API traffic doesn't take it.
- **`/api/heartbeat` is served by a separate, plugin-free Elysia instance reached through
  an outer `.wrap()`** (`src/app.ts`'s `createApp`): `heartbeatApp` carries only
  `/api/heartbeat`; the returned `app` has a `.wrap()` that answers that exact path
  straight from `heartbeatApp.fetch(...)` and hands every other request to the normal
  pipeline; `main` carries every other route plus
  `.use(logixlysia()).use(cors()).use(rateLimit())` and is merged in last via
  `app.use(main)`. Same port, same process. **Order matters**: the wrap must be
  registered on `app` *before* `app.use(main)` — logixlysia 7 logs through its own global
  `.wrap()` (it wraps the whole `fetch`), and a wrap registered earlier runs *outside* a
  later one, a wrap registered after `.use(main)` doesn't (verified empirically). A plain
  sibling instance — what worked on 1.4, where logixlysia/rate-limit were `'scoped'` —
  is not enough on Elysia 2: heartbeat then lands in the access log (20k log lines per 20k
  requests, ~17% throughput loss, measured). Consequence: heartbeat gets no CORS and no
  rate-limit headers either; fine, since Docker/Podman's own `HEALTHCHECK` (a plain
  `curl`, same host) is the only real caller upstream (`gh search code "heartbeat" --repo
  umami-software/umami`), never the browser dashboard. `app.routes` therefore does not
  list heartbeat — `tests/integration/route-coverage.test.ts` accounts for that
  explicitly.
- **What gets vendored**: `lib/` (auth.ts, jwt.ts, crypto.ts, password.ts, db.ts, prisma.ts,
  request.ts, response.ts, schema.ts, filters.ts, + their `*.test.ts`), `queries/`
  (prisma/ and sql/ layers), `prisma/` (schema + migrations as-is), and only the needed
  `app/api/*/route.ts` files (auth/, send, batch, heartbeat, websites/, teams/, users/,
  realtime/, reports/, boards/, me/, config/).
- **What's explicitly out of scope**: `src/app/(main)/*` (dashboard UI), `src/components/*`,
  and the `(collect)/p` / `(collect)/q` pixel & short-link routes (Next-coupled, unused
  features).
- **Prisma under Bun**: plan is to switch the vendored `prisma/schema.prisma` generator
  from `prisma-client-js` to `prisma-client` (`engineType = "client"`, `runtime = "bun"`)
  with `@prisma/adapter-pg`, to avoid bundling the Rust query engine. Bun does not
  auto-load `.env` for CLI tools, so Prisma commands need `--env-file=.env` explicitly
  (e.g. `bun run --bun --env-file=.env prisma generate`). This is unvalidated against the
  actual RSS win — measure before treating it as load-bearing for the <100MB target.
  Same `DATABASE_URL` (Neon) is shared with the dashboard; `APP_SECRET` is *not* shared —
  each instance mints its own tokens.
- **Sync/CI intent**: eventual periodic sync of the vendored directories against new
  upstream Umami releases, gated by `tsc --noEmit` plus vendored + own tests, auto-deploy
  on green.
- **Route mounting is lazy, deliberately** (`src/mount.ts`): which HTTP methods a
  `route.ts` exports is detected by regexing its *source text*, not by importing it — the
  actual `import()` happens inside the request handler, on first hit, and is memoized
  after that. Importing all ~127 vendored route files eagerly at startup (the original
  approach) cost real memory for features a given deployment likely never touches — e.g.
  `@clickhouse/client` alone costs ~38MB RSS just to *import*, unconditionally, even
  though nothing calls it unless `CLICKHOUSE_URL` is set. Measured effect: idle RSS before
  any request dropped from ~124MB to ~28MB. `mountCollectRoutes` needs the same laziness
  for the same reason — `q/[slug]/route.ts` statically imports `send/route.ts`'s `POST`,
  so leaving that one eager silently reintroduces the same cost through a side door.
  `@clickhouse/client` is further replaced at the dependency level with a local stub
  (`local-shims/clickhouse-client`, wired via `package.json`'s `"file:"` dependency) that
  throws if actually called — real gain here is smaller than the isolated import number
  suggests once Prisma/pg are already loaded (shared transitive deps), but it's free and
  correct so it stays. If you re-vendor and a new route file eagerly imports something
  else heavy, the same pattern applies: don't patch the vendored file, either lean on the
  existing laziness or add another local shim.

- **Bundled build** (`bun run build` → `tsdown.config.ts`, `scripts/generate-route-manifest.ts`,
  `src/index.build.ts`; production `CMD` in `Dockerfile`): a *separate* entrypoint from
  `src/index.ts`, not a replacement. `mountUmamiRoutes`'s runtime `import(filePath)` (see
  above) is invisible to any bundler's static analysis — a `filePath` computed from a
  `Bun.Glob` scan can't be traced, so a plain `bun build`/`esbuild`/`tsdown` of
  `src/index.ts` doesn't actually pull in the vendored route code at all (Prisma, bcryptjs,
  jsonwebtoken, ...) — it silently produces a tiny bundle that still needs `node_modules`
  on disk for anything DB-backed, defeating the point. Fix: `scripts/generate-route-manifest.ts`
  runs the *same* route-detection logic (`mount.ts`'s `scanApiRoutes`) at build time and
  emits *literal* `import("../vendor/.../route.ts")` strings into a generated,
  gitignored `src/route-manifest.generated.ts` — a bundler can see a string literal, so
  everything a route transitively imports gets pulled into the bundle graph, while each
  loader stays a separate `import()` (not a static top-level import), so lazy-loading
  semantics are preserved — verified: cold RSS is the same as unbundled, not the
  eager-import regression this whole lazy-mounting design exists to avoid. `src/app.ts`'s
  `createApp()` takes optional `{ apiRoutes, collectRoutes }` (pre-built `RouteEntry[]`
  from the manifest) — omitted (the normal dev/Docker-via-`src/index.ts` path), it falls
  back to `mountUmamiRoutes`'s own runtime scan.
  Bundler choice matters: `bun build`'s own resolver chokes on `file-type` (Elysia's own
  optional dynamic import, wrapped in `.catch()` for exactly this "not installed" case) —
  its transitive dep `strtok3` has a broken `package.json` `exports` map (same bug class as
  the `@sinclair/typebox` cache-corruption gotcha below); mark `file-type` external to work
  around it (already done in `tsdown.config.ts`). Picked `tsdown` (Rolldown) over plain
  `bun build`/`esbuild` specifically because it code-splits each dynamic `import()` into
  its own chunk file by default — `bun build`'s single-`--outfile` mode inlines everything,
  which still preserves *evaluation* laziness (dynamically-imported modules are wrapped in
  a lazily-invoked init function, not eagerly run) but not *parse* laziness, and measured
  ~40MB higher cold RSS as a result; `bun build --outdir --splitting --target bun` also
  code-splits and measured about the same as tsdown, so either works — tsdown's chunk
  naming/config ergonomics were just nicer to work with.
  Real, measured wins: ~24MB cold-boot RSS instead of ~28MB, and ~78ms to ready instead of
  ~115ms (skips `mountUmamiRoutes`'s startup-time glob scan + per-file regex parse across
  127 files — the manifest is precomputed). Under concurrent load (`ab`, matching
  `scripts/bench.ts`'s write/read profile), an isolated bare-process A/B showed a real gap
  (~2000 vs ~1740 req/s write, p99 38ms vs 84ms) but a same-conditions Docker A/B (same
  host, same competing containers) showed it mostly evaporate on the write path (noise —
  894 vs 909 req/s) while the read path kept a real, repeatable ~12% gain — container
  overhead (docker-proxy/NAT, cgroup accounting) dominates enough to swamp the smaller
  effect; don't trust a single benchmark run on a shared dev host for this, especially the
  read path (seen swing ±25% run to run under nominally identical conditions).
  `node_modules` is **not** dropped from the shipped image despite bundling — `prisma`
  (the CLI, for the README's documented `prisma migrate deploy` one-off workflow) needs to
  still be invokable from the *published* image after the fact (DB migrations are
  inherently a runtime action against each user's own `DATABASE_URL`, unknowable at CI
  build time anyway, so it can't be done at build time and discarded). This does *not*
  mean the build has to stay single-stage, though — see the Dockerfile section below for
  the multi-stage version that keeps `prisma` while still dropping the build toolchain.

- **Dockerfile** is multi-stage (`builder` runs `prisma generate` + the geo-db download +
  `bun run build`; `runtime` is what actually ships). Both stages pin `oven/bun:1.4-alpine`
  rather than the floating `oven/bun:1`/`oven/bun:1-alpine` tags — verified locally that
  `oven/bun:1-alpine` lagged at bun 1.3.14 while `oven/bun:1` (debian) and this repo's own
  `bun.lock` were on 1.4.0, and 1.3.14 can't parse `bun.lock`'s `lockfileVersion: 2`
  (`--frozen-lockfile` hard-fails with "Unknown lockfile version") — bump this pin
  alongside `bun-types` in `package.json` when upgrading bun, don't drop back to a floating
  tag. `prisma` lives in `package.json`'s `"dependencies"` (not `"devDependencies"`)
  specifically so the `runtime` stage's `bun install --frozen-lockfile --production` still
  installs the CLI; `tsdown`/`typescript`/`vitest` and their transitive deps do not get
  reinstalled there. `RUN --mount=type=cache,target=/root/.bun/install/cache` on both
  install steps keeps bun's global package cache out of the image layers entirely (a
  `rm -rf` *after* the same `bun install` in one combined `RUN` also works and was tested —
  bun hardlinks cache entries into `node_modules`, so a same-layer cleanup only saved ~4MB,
  not the ~400MB a naive `du` on the cache dir suggests; deleting it in a *later* `RUN`
  saves nothing at all, since Docker layers are additive and the earlier layer's bytes are
  already committed — the cache mount is the actually-correct fix, not a micro-optimization).
  `vendor/umami/public/{script.js,recorder.js}` are copied explicitly into `runtime` — they
  are read straight off disk at request time by `mountStaticScript` (`src/mount.ts`) via a
  `Bun.file()` path relative to the running module, *not* bundled by tsdown the way
  `route.ts` handlers are (verified by omitting them: cold start throws `ENOENT` opening
  `script.js`, not caught by anything upstream). `vendor/umami/src/app/api` (the route
  source tree) is *not* copied into `runtime` — the bundled build never reads it at
  runtime, only `mount.ts`'s `scanApiRoutes()` fallback (the dev/`src/index.ts` path) does.
  Measured end-to-end (`docker build`/`docker history`, this host): previous single-stage
  debian image was 690MB, and ~480MB of that was bun's *own install cache* at `/root/.bun`
  baked into the image — a near-duplicate of `node_modules` that no `RUN` step ever
  cleaned and there was no second stage to leave it behind in. This Dockerfile: 511MB.
  Verified working end-to-end against a real Postgres: `prisma migrate deploy` from inside
  the shipped `runtime` image, and the app itself serving `/script.js` and `/api/heartbeat`.

## Known environment gotcha

`bun install` can populate a stale/corrupted entry in Bun's *global* package cache
(`~/.bun/install/cache`) whose contents don't match the real registry tarball — this has
been observed with `@sinclair/typebox` (an Elysia peer dep), producing errors like
`Cannot find module '<pkg>/dist/.../foo.mjs'` referenced via a bare specifier that isn't in
that package's `exports` map. If a fresh `bun install` produces a "cannot find module"
error inside `node_modules/<pkg>`, compare the offending file against the real npm tarball
before assuming it's a real upstream bug — if they differ, delete the specific
`~/.bun/install/cache/<pkg>@<version>@@@1` entry (and `node_modules`/`bun.lock`) and
reinstall.

Separately, the Elysia 1.x `latest` dist-tag (`1.4.30`) is a genuinely broken release
upstream — it self-imports via bare specifiers not covered by its own `exports` map. That
was why `package.json` used to pin `elysia` to `1.4.29`; the project is now on the 2.x
line (see the Elysia 2 note above), pinned exact. Don't switch to a floating dist-tag
(`latest`/`rc`/`next`) for `elysia`, `@elysia/cors`, `elysia-rate-limit` or `logixlysia`
without checking the installed `dist/` imports and peer ranges first.

The upstream sync workflow (`.github/workflows/sync-umami.yml`) wipes and re-vendors
`vendor/umami/` from scratch (`rm -rf` then copy) and auto-merges when CI is green, so
Elysia-specific changes must live in `src/`, `tests/` and `package.json` — never in
`vendor/` — or the next sync PR silently drops them.
