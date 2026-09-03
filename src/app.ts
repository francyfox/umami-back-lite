import { Elysia } from "elysia";
import cors from "@elysiajs/cors";
import { rateLimit } from "elysia-rate-limit";
import logixlysia from "logixlysia";
import { mountCollectRoutes, mountRecorderScript, mountTrackerScript, mountUmamiRoutes } from "./mount";

export async function createApp() {
  // Tried `aot: false` (Elysia's non-compiled dispatch path) for the ~7MB
  // RSS it saves — broke POST bodies. Our routes read the raw Request
  // themselves (`request.json()` inside vendored parseRequest()) rather
  // than using Elysia's `context.body`; the dynamic (non-AOT) handler path
  // apparently consumes the body stream itself before our handler runs,
  // so downstream `request.json()` sees nothing. Not worth chasing further
  // for ~7MB — stick with the (default) AOT-compiled dispatcher.
  const app = new Elysia()
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

  await mountUmamiRoutes(app);
  await mountCollectRoutes(app);
  await mountTrackerScript(app);
  await mountRecorderScript(app);

  return app;
}
