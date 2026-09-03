# umami-back-lite

[![CI](https://img.shields.io/github/actions/workflow/status/francyfox/umami-back-lite/ci.yml?branch=master&style=flat-square&label=CI)](https://github.com/francyfox/umami-back-lite/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-bun-000000?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![Framework: Elysia](https://img.shields.io/badge/framework-elysia-8B5CF6?style=flat-square)](https://elysiajs.com)
[![Docker](https://img.shields.io/badge/ghcr.io-umami--back--lite-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/francyfox/umami-back-lite/pkgs/container/umami-back-lite)
[![Umami compatible](https://img.shields.io/badge/umami-v3.3.1-1F2937?style=flat-square)](https://umami.is)

A lightweight backend for [Umami](https://umami.is) analytics. Same tracking API, same
Postgres schema, same tracker script — just not Next.js. It runs the actual upstream Umami
route/query logic (vendored, unmodified) on [Elysia](https://elysiajs.com)/[Bun](https://bun.sh)
instead, which is why it idles at a fraction of the memory. See [Benchmark](#benchmark) below.

There's no dashboard here on purpose — see [I need the dashboard](#i-need-the-dashboard).

## Quick start

Point it at any Postgres database Umami can use (a fresh one, or one an existing Umami
instance already migrated) and give it a secret for signing tokens:

```bash
docker run -d \
  --name umami-back-lite \
  -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:password@host:5432/umami" \
  -e APP_SECRET="$(openssl rand -hex 32)" \
  ghcr.io/francyfox/umami-back-lite:latest
```

Every image is tagged with the exact upstream Umami version it vendors, e.g.
`ghcr.io/francyfox/umami-back-lite:v3.3.1` — pin to that instead of `:latest` if you want
to know precisely which Umami release's logic you're running, independent of our own
adapter-side changes. [Available tags](https://github.com/francyfox/umami-back-lite/pkgs/container/umami-back-lite).

Or with Compose:

```yaml
services:
  umami-back-lite:
    image: ghcr.io/francyfox/umami-back-lite:latest
    environment:
      DATABASE_URL: postgresql://user:password@postgres:5432/umami
      APP_SECRET: change-me
    ports:
      - "3000:3000"
```

First time against a brand-new, empty database, run the schema migrations once (the image
ships the `prisma` CLI, so no extra tooling needed):

```bash
docker run --rm \
  -e DATABASE_URL="postgresql://user:password@host:5432/umami" \
  ghcr.io/francyfox/umami-back-lite:latest \
  bun run --bun prisma migrate deploy
```

That's it. Embed the tracker on any site exactly like official Umami:

```html
<script defer src="https://your-instance.example.com/script.js" data-website-id="..."></script>
```

`/script.js` and `/recorder.js` (session replay / heatmap client, if you enable that on a
website) are the real upstream builds — extracted from Umami's own published image at
vendor time, byte-identical — and the same `/api/*` routes are there for dashboards, the
Umami MCP integration, or anything else already talking to a real Umami backend.

### Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string, same as official Umami |
| `APP_SECRET` | recommended | falls back to `DATABASE_URL` | Signs auth/session tokens — set your own |
| `RATE_LIMIT_MAX` | no | `300` | Requests per window per IP |
| `RATE_LIMIT_WINDOW_MS` | no | `10000` | Rate-limit window, in ms |
| `GEOLITE_DB_PATH` | no | pre-set in the image | Points at a geo database for IP -> country lookup — see [Geo lookups](#geo-lookups) |
| `TRACKER_SCRIPT_NAME` | no | — | Comma-separated alternate paths that also serve `/script.js` (ad-blocker evasion), e.g. `analytics.js,stats.js` |

Everything else official Umami reads (`REDIS_URL`, `CLICKHOUSE_URL`, `KAFKA_*`,
`DATABASE_REPLICA_URL`, `SALT_ROTATION`, `DISABLE_BOT_CHECK`, `CLOUD_MODE`, `LOG_QUERY`,
`TWO_FACTOR_ENCRYPTION_KEY`, `IGNORE_IP`, and so on) is read the same way here — it's the
same vendored code. The only things missing are dashboard/build/platform-only variables
that don't apply to an API-only backend (`DEFAULT_LOCALE`, `DISABLE_UI`, `VERCEL`, etc.).

### Geo lookups

`/api/send` looks up the visitor's country from their IP
(`vendor/umami/src/lib/detect.ts`). Official Umami's Docker image bakes in a full
GeoLite2-City database at their own build time, using their own MaxMind license — we
don't have one of those, and a full city-level database (theirs or any other) adds
**~65–125MB of RSS** the moment the first real visitor IP is looked up, which would
undo most of this project's memory advantage. Instead, the image ships a **country-only**
database from [DB-IP's free Lite tier](https://db-ip.com/db/lite.php) (no account
needed, ~11MB RSS) — you get `country`, not `city`/`region`. If you're behind Cloudflare,
Vercel, or CloudFront, their geo headers are used automatically instead and this doesn't
matter. Set `GEOLITE_DB_PATH` yourself to point at a real GeoLite2-City (or compatible
MMDB) file if you want city-level data and can accept the memory cost.

IP geolocation by [DB-IP](https://db-ip.com) (Country Lite, CC BY 4.0).

## I need the dashboard

This project is API-only — no UI is vendored or served. If you want to click around the
Umami dashboard, just run the **official** Umami image locally, pointed at the same
database:

```bash
docker run -d \
  -p 3001:3000 \
  -e DATABASE_URL="postgresql://user:password@host:5432/umami" \
  -e APP_SECRET="anything" \
  ghcr.io/umami-software/umami:postgresql-latest
```

Open `http://localhost:3001`, log in with your usual Umami credentials. It reads/writes
the same tables this backend does — there's no sync step, no API between the two, just a
shared database. You don't need to run it anywhere near production; open it locally
whenever you actually want to look at the dashboard, then close it again.

<!-- BENCHMARK:START -->
## Benchmark

`umami-back-lite` (Elysia on Bun) vs. the official `ghcr.io/umami-software/umami:postgresql-latest`
image, both pointed at one shared Postgres instance with identical schema and
seed data. Measured 2026-09-03 —
reproduce with `docker compose up -d --build`, then
`RATE_LIMIT_MAX=1000000 docker compose up -d app` (raw write capacity — see
caveats),
`bun scripts/bench.ts ours http://localhost:3000 <app-container>`,
`docker compose up -d app` (restore the default limit), then
`bun scripts/bench.ts official http://localhost:3001 <umami-container>`,
and regenerate this section with `bun scripts/bench-report.ts`.

```mermaid
xychart-beta
    title "Throughput (req/s, higher is better)"
    x-axis ["ours · write", "official · write", "ours · read", "official · read"]
    y-axis "req/s" 0 --> 900
    bar [896, 280, 149, 109]
```

```mermaid
xychart-beta
    title "Median latency, ms (lower is better)"
    x-axis ["ours · write", "official · write", "ours · read", "official · read"]
    y-axis "ms" 0 --> 300
    bar [54, 167, 196, 265]
```

```mermaid
xychart-beta
    title "Peak memory, MiB (lower is better)"
    x-axis ["ours · idle", "official · idle", "ours · write", "official · write", "ours · read", "official · read"]
    y-axis "MiB" 0 --> 750
    bar [127, 264, 256, 602, 246, 711]
```

```mermaid
xychart-beta
    title "Peak CPU, % of one core (lower is better)"
    x-axis ["ours · write", "official · write", "ours · read", "official · read"]
    y-axis "%" 0 --> 150
    bar [136, 150, 102, 112]
```

| Metric | umami-back-lite | official umami | difference |
|---|---:|---:|---:|
| Write — req/s | **895.9** | 279.6 | 3.2× |
| Write — p50 / p95 / p99 (ms) | **54 / 70 / 83** | 167 / 235 / 257 | 3.09× faster |
| Write — peak mem (MiB) | **256.2** | 601.9 | 57.4% less |
| Write — peak CPU (%) | **136.1** | 149.6 | 9% less |
| Read — req/s | **148.6** | 108.6 | 1.37× |
| Read — p50 / p95 / p99 (ms) | **196 / 238 / 304** | 265 / 310 / 358 | 1.35× faster |
| Read — peak mem (MiB) | **246.3** | 710.6 | 65.3% less |
| Read — peak CPU (%) | **101.6** | 111.8 | 9.1% less |
| Idle memory (MiB) | **126.8** | 264.4 | 52% less |

**Caveats:** both backends ran as sibling containers on one Docker host, so
absolute numbers are host-specific — the side-by-side comparison is the
meaningful part. Our rate limiter (`RATE_LIMIT_MAX`, 300 req/10s per IP by
default) was raised via env var during the write-path test to measure raw
capacity (a single-IP load generator would otherwise hit it almost
immediately); it ships enabled at the 300 default. Traffic came from one
synthetic IP/session, so the read path was measured against a small, uniform
dataset, not high-cardinality data at scale.
<!-- BENCHMARK:END -->

**Cold boot, measured separately (not part of the table above, different methodology):**
routes are mounted lazily — a route's module only imports on its *first* real request, not
at startup (see `src/mount.ts`). RSS right after container start, before any request at
all, is **~28MB**. The 126.8MB "Idle" row above already reflects a couple of setup
requests (login, create-website) that the benchmark script itself makes before sampling —
it's the fairer number for comparing against official Umami under identical conditions,
but 28MB is the more honest answer to "how light is this at boot."

## License

MIT — see [LICENSE](./LICENSE).

This repo vendors upstream Umami's own source under `vendor/umami/` (unmodified, aside
from two files mechanically patched to drop a Next.js-only import — see
`scripts/vendor-umami.sh`). That code stays under Umami Software, Inc.'s own MIT license
(kept alongside it at `vendor/umami/LICENSE`). This project is an adapter that runs that
code on a different HTTP layer — it doesn't fork or rewrite Umami's own logic.
