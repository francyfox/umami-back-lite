// Integration tests for OUR code — src/mount.ts and src/app.ts — not the
// vendored umami logic (that's covered by the vendored *.test.ts files under
// vendor/umami, run via `bun run test`). Those never touch Elysia at all;
// this suite is what actually proves a real HTTP request makes it through
// our path-param conversion and method dispatch into a vendored route
// handler and back out correctly.
//
// Needs a real reachable Postgres with the umami schema + seeded admin user
// (the dev stack: `docker compose up -d --build`). Run with:
//   bun run test:integration
//
// Runs under Bun's own test runner, not vitest: src/mount.ts uses Bun.Glob,
// a Bun-native API vitest's Node-based transform can't resolve. That's fine
// here — unlike the vendored suite (bun run test / vitest), this one does no
// module mocking at all, so bun:test's compat gaps around vi.mock() never
// come into play.

import { beforeAll, describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";

let app: Awaited<ReturnType<typeof createApp>>;
let adminToken: string;

async function request(path: string, init?: RequestInit) {
  // app.handle() has no real network socket, so elysia-rate-limit logs a
  // benign "failed to determine client address" warning per request here —
  // expected under this testing pattern, not a bug.
  return app.handle(new Request(`http://localhost${path}`, init));
}

beforeAll(async () => {
  app = await createApp();

  const res = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "umami" }),
  });
  const body = await res.json();
  if (!body.token) {
    throw new Error(
      `admin login failed — is the dev DB up and seeded? (docker compose up -d --build): ${JSON.stringify(body)}`,
    );
  }
  adminToken = body.token;
});

describe("mount.ts: route discovery and method dispatch", () => {
  it("mounts a zero-arg GET route (heartbeat)", async () => {
    const res = await request("/api/heartbeat");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("dispatches POST with a JSON body (auth/login)", async () => {
    const res = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "umami" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.user.username).toBe("admin");
  });

  it("returns 404 for a path with no matching vendored route", async () => {
    const res = await request("/api/this-route-does-not-exist");
    expect(res.status).toBe(404);
  });
});

describe("mount.ts: dynamic path params", () => {
  it("extracts a single-segment param ([websiteId]) and passes it to the handler", async () => {
    const listRes = await request("/api/websites", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const list = await listRes.json();
    expect(listRes.status).toBe(200);

    const created =
      list.data.find((w: { name: string }) => w.name === "adapter-test-site") ??
      (await request("/api/websites", {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "adapter-test-site", domain: "adapter-test.example.com" }),
      }).then((r) => r.json()));

    const res = await request(`/api/websites/${created.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    // If mount.ts's [param] -> :param conversion were broken, Elysia would
    // 404 before ever reaching the route handler.
    expect(body.id).toBe(created.id);
  });
});

describe("app.ts: cross-cutting plugins are actually wired", () => {
  it("applies CORS headers", async () => {
    const res = await request("/api/heartbeat");
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  });

  it("applies rate-limit headers", async () => {
    const res = await request("/api/heartbeat");
    expect(res.headers.get("ratelimit-limit")).toBeTruthy();
  });
});
