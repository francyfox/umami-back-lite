import { Elysia } from "elysia";
import cors from "@elysiajs/cors";
import { rateLimit } from "elysia-rate-limit";
import logixlysia from "logixlysia";
import {
  HEARTBEAT_PATH,
  mountCollectRoutes,
  mountRecorderScript,
  mountRouteEntries,
  mountTrackerScript,
  mountUmamiRoutes,
  type RouteEntry,
} from "./mount";

export type CreateAppOptions = {
  // Pre-resolved route entries (from route-manifest.generated.ts) for the
  // bundled build — see src/index.build.ts. Omitted (the normal dev/Docker
  // path): routes are discovered via mount.ts's own runtime Bun.Glob scan.
  apiRoutes?: RouteEntry[];
  collectRoutes?: RouteEntry[];
};

export async function createApp(options: CreateAppOptions = {}) {
  // Tried `aot: false` (Elysia's non-compiled dispatch path) for the ~7MB
  // RSS it saves — broke POST bodies. Our routes read the raw Request
  // themselves (`request.json()` inside vendored parseRequest()) rather
  // than using Elysia's `context.body`; the dynamic (non-AOT) handler path
  // apparently consumes the body stream itself before our handler runs,
  // so downstream `request.json()` sees nothing. Not worth chasing further
  // for ~7MB — stick with the (default) AOT-compiled dispatcher.
  // `app` (outer, returned) stays minimal — just /api/heartbeat, mounted
  // directly on it below — and merges `main` (everything else) in last.
  // logixlysia/rateLimit are `main`'s own plugins; a route already sharing
  // `main`'s instance can't opt out of a `.use()`d plugin's hooks once
  // registered, so heartbeat has to live on a genuinely separate instance
  // instead (verified: cors() reaches app's routes too regardless — it uses
  // Elysia's 'global' hook scope — but rateLimit/logixlysia, both 'scoped',
  // don't reach past `main` unless a route is actually inside it).
  const app = new Elysia();

  const main = new Elysia()
    .use(
      logixlysia({
        config: {
          service: "api-server",
          showStartupMessage: true,
          startupMessageFormat: "banner",
          showContextTree: true,
          contextDepth: 2,
          slowThreshold: 500,
          verySlowThreshold: 1000,
          timestamp: {
            translateTime: "yyyy-mm-dd HH:MM:ss.SSS",
          },
          ip: true,
          // The plugin's own default format has no {ip} token, so `ip: true`
          // above silently did nothing — the client address never appeared
          // anywhere in the log line. logQueryParams surfaces e.g. which
          // website/date-range a /api/websites/:id/stats call was for,
          // otherwise indistinguishable requests to the same path.
          logQueryParams: true,
          customLogFormat: "{now} {service}{icon} {method} {pathname}{query} {status} {duration} {ip} {message}{speed}",
        },
      }),
    )
    .use(cors())
    .use(
      // The plugin's own defaults (max: 10 per 60s per IP) are a placeholder —
      // far too strict for a tracking API (one real visitor easily fires more
      // than 10 requests/min, and many visitors legitimately share an IP behind
      // NAT/a proxy). This is a basic abuse backstop, not fine-grained per-route
      // policy; revisit if a specific endpoint needs a tighter limit.
      rateLimit({
        max: process.env.RATE_LIMIT_MAX ? Number(process.env.RATE_LIMIT_MAX) : 300,
        duration: process.env.RATE_LIMIT_WINDOW_MS ? Number(process.env.RATE_LIMIT_WINDOW_MS) : 10_000,
      }),
    );

  if (options.apiRoutes) {
    const heartbeatRoutes = options.apiRoutes.filter((r) => r.path === HEARTBEAT_PATH);
    const restRoutes = options.apiRoutes.filter((r) => r.path !== HEARTBEAT_PATH);
    mountRouteEntries(app, heartbeatRoutes);
    const count = mountRouteEntries(main, restRoutes);
    console.log(`Mounted ${count} umami route handlers from route-manifest.generated.ts`);
  } else {
    await mountUmamiRoutes(main, app);
  }

  if (options.collectRoutes) {
    mountRouteEntries(main, options.collectRoutes);
    console.log("Mounted 2 umami collect route handlers from route-manifest.generated.ts");
  } else {
    await mountCollectRoutes(main);
  }

  await mountTrackerScript(main);
  await mountRecorderScript(main);

  app.use(main);

  return app;
}
