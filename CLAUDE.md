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

The full rationale, source-level analysis of upstream Umami (which route handlers are
already Next-free), the Prisma driver-adapter plan, and the milestone breakdown (M0–M4)
live in `docs/umami-elysia-fork-plan.md` — read it before doing any nontrivial work here,
especially before vendoring a new route group or touching the Prisma client setup.

**Current status**: pre-M0 scaffold. `src/index.ts` is still the default Elysia template
("Hello Elysia"); none of the vendoring/porting work has started yet.

## Commands

- Install deps: `bun install`
- Run dev server (watch mode): `bun run dev` (equivalent to `bun run --watch src/index.ts`)
- Run directly: `bun run src/index.ts`
- No test runner or lint script is configured yet — `bun run test` is the unconfigured npm
  default placeholder (exits 1). Set up real tests/lint before relying on either.

## Architecture notes for future work (per the fork plan)

- **Routing pattern**: don't rewrite Umami's route logic. Each vendored `route.ts` exposes
  Web-standard `Request`/`Response` handlers (e.g. `POST`); Elysia routes should just call
  through, e.g. `app.post('/api/auth/login', ({ request }) => loginRoute.POST(request))`.
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

Separately, `elysia@1.4.30` (the `latest` dist-tag at time of writing) is a genuinely
broken release upstream — it self-imports via bare specifiers not covered by its own
`exports` map. `package.json` pins `elysia` to `1.4.29` for this reason; don't casually
bump it back to `"latest"` without checking the installed `dist/index.mjs` imports first.
