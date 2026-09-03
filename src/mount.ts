import { Glob } from "bun";

// Elysia's generics track every route/plugin added via chained `.use()`/`.get()`
// calls; a function mounting an open-ended, dynamically discovered set of routes
// can't participate in that statically, so this intentionally takes `any`.
type AnyElysia = any;

export const API_ROOT = new URL("../vendor/umami/src/app/api", import.meta.url)
  .pathname;
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export function toElysiaPath(routeFile: string): string {
  return (
    "/api/" +
    routeFile
      .replace(/\/route\.ts$/, "")
      .split("/")
      .map((seg) => (seg.startsWith("[") ? ":" + seg.slice(1, -1) : seg))
      .join("/")
  );
}

const METHOD_EXPORT_RE = /^export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/gm;

// A route's existence + methods, independent of *how* its module gets
// loaded — shared by the runtime scanner (mountUmamiRoutes, below) and
// scripts/generate-route-manifest.ts (which needs the plain relative file,
// not a bound loader, so it can emit a literal `import("...")` string a
// bundler can see statically — see that script for why).
export type ApiRouteInfo = {
  path: string;
  methods: (typeof METHODS)[number][];
  file: string; // relative to API_ROOT, e.g. "auth/login/route.ts"
};

// Which methods a route.ts exports is detected by reading its *source text*
// (cheap — no module evaluation, no transitive npm deps loaded), not by
// importing it.
export async function scanApiRoutes(): Promise<ApiRouteInfo[]> {
  const glob = new Glob("**/route.ts");
  const out: ApiRouteInfo[] = [];

  for await (const file of glob.scan(API_ROOT)) {
    const text = await Bun.file(`${API_ROOT}/${file}`).text();
    const methods = [...text.matchAll(METHOD_EXPORT_RE)]
      .map((m) => m[1])
      .filter((m): m is (typeof METHODS)[number] => (METHODS as readonly string[]).includes(m));

    if (methods.length) out.push({ path: toElysiaPath(file), methods, file });
  }

  return out;
}

export type RouteEntry = {
  path: string;
  methods: readonly string[];
  load: () => Promise<any>;
};

// Registers already-resolved entries (each with its own loader) — used both
// by mountUmamiRoutes below (loaders close over a runtime-computed path) and
// by the bundled-build entrypoint (loaders come from route-manifest.generated.ts,
// where each loader is a literal `import("...")`  a bundler can see and
// inline — see scripts/generate-route-manifest.ts).
export function mountRouteEntries(app: AnyElysia, entries: RouteEntry[]): number {
  let count = 0;

  for (const entry of entries) {
    for (const method of entry.methods) {
      app[method.toLowerCase()](
        entry.path,
        async ({ request, params }: { request: Request; params: Record<string, string> }) => {
          const mod = await entry.load();
          return mod[method](request, { params: Promise.resolve(params) });
        },
      );
      count++;
    }
  }

  return count;
}

// The actual `import()` only happens inside the handler, on the first real
// request to that specific route, and is cached after that.
//
// Why this matters: many vendored route.ts files eagerly import genuinely
// heavy, rarely-used dependencies (e.g. @clickhouse/client alone costs
// ~38MB RSS just to import, unconditionally, even though it's only ever
// *called* if CLICKHOUSE_URL is set). Importing all 127 route files at
// startup — the previous behavior — paid that cost for every feature
// (2FA, admin, links, pixels, revenue, segments, replays, telemetry, ...)
// whether or not a given deployment ever uses it. This way, a deployment
// that only ever hits send/stats/websites/reports never pays for the rest.
export async function mountUmamiRoutes(app: AnyElysia) {
  const infos = await scanApiRoutes();

  const entries: RouteEntry[] = infos.map((info) => {
    const filePath = `${API_ROOT}/${info.file}`;
    let modPromise: Promise<any> | undefined;
    return { path: info.path, methods: info.methods, load: () => (modPromise ??= import(filePath)) };
  });

  const count = mountRouteEntries(app, entries);

  console.log(`Mounted ${count} umami route handlers from ${API_ROOT} (lazy — imported on first hit)`);

  return app;
}

export const COLLECT_ROOT = new URL("../vendor/umami/src/app/(collect)", import.meta.url)
  .pathname;

// Fixed, not globbed: only two files live under app/(collect) upstream (the
// only vendored code that touched next/server — see scripts/vendor-umami.sh
// for the mechanical NextResponse -> Response patch). A rename or a third
// (collect) route upstream needs a matching update here — and in
// scripts/generate-route-manifest.ts, which reuses this same list.
export const COLLECT_ROUTES: ApiRouteInfo[] = [
  { path: "/p/:slug", methods: ["GET"], file: "p/[slug]/route.ts" },
  { path: "/q/:slug", methods: ["GET"], file: "q/[slug]/route.ts" },
];

// Lazy for the same reason as mountUmamiRoutes: q/[slug]/route.ts does
// `import { POST } from '@/app/api/send/route'` at the top of the file —
// eagerly importing this one small file was dragging in send/route.ts's
// entire dependency chain (clickhouse et al) unconditionally, which is
// exactly the cost mountUmamiRoutes' own laziness was trying to avoid.
export async function mountCollectRoutes(app: AnyElysia) {
  const entries: RouteEntry[] = COLLECT_ROUTES.map((info) => {
    const filePath = `${COLLECT_ROOT}/${info.file}`;
    let modPromise: Promise<any> | undefined;
    return { path: info.path, methods: info.methods, load: () => (modPromise ??= import(filePath)) };
  });

  mountRouteEntries(app, entries);

  console.log("Mounted 2 umami collect route handlers (pixel beacon + short-link redirect, lazy)");

  return app;
}

const PUBLIC_ROOT = new URL("../vendor/umami/public", import.meta.url).pathname;

// script.js (tracker) and recorder.js (session replay / heatmap client) both
// aren't in upstream's git tree — they're rollup build outputs
// (src/tracker/*, src/recorder/*) they produce at their own build time.
// scripts/vendor-umami.sh extracts the real built files from their published
// Docker image instead of us vendoring their whole build toolchain for two
// files. Headers/caching match what their own server sends them with.
async function mountStaticScript(
  app: AnyElysia,
  path: string,
  file: string,
  aliasEnvVar?: string,
) {
  const body = await Bun.file(`${PUBLIC_ROOT}/${file}`).text();
  const headers = {
    "Content-Type": "application/javascript; charset=UTF-8",
    "Cache-Control": "public, max-age=86400, must-revalidate",
    "Access-Control-Allow-Origin": "*",
  };
  const handler = () => new Response(body, { headers });

  app.get(path, handler);

  // Ad-blocker-evasion aliases, matching upstream's own next.config.ts, e.g.
  // TRACKER_SCRIPT_NAME="analytics.js,stats.js" serves the same script.js
  // content under those extra paths too.
  const names = aliasEnvVar
    ? (process.env[aliasEnvVar] ?? "")
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)
    : [];

  for (const name of names) {
    app.get(`/${name.replace(/^\/+/, "")}`, handler);
  }

  console.log(
    `Mounted ${file} at ${path}${names.length ? ` (+ ${names.length} alias${names.length === 1 ? "" : "es"})` : ""}`,
  );
}

export async function mountTrackerScript(app: AnyElysia) {
  await mountStaticScript(app, "/script.js", "script.js", "TRACKER_SCRIPT_NAME");
  return app;
}

export async function mountRecorderScript(app: AnyElysia) {
  await mountStaticScript(app, "/recorder.js", "recorder.js");
  return app;
}
