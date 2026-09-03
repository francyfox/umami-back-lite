import { Elysia } from "elysia";
import cors from "@elysiajs/cors";
import { rateLimit } from "elysia-rate-limit";
import logixlysia from "logixlysia";
import { mountCollectRoutes, mountUmamiRoutes } from "./mount";

export async function createApp() {
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

  return app;
}
