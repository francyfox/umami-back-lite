// Where real bugs actually live: not "is the route mounted" (route-coverage.test.ts)
// but "does a request's data survive the full round trip through OUR code —
// mount.ts's params/body passthrough -> the vendored route.ts handler ->
// queries/sql -> real Postgres -> JSON response". Each test here sends a
// known request and asserts an EXACT expected result computed from that
// input, against a real database — not just a status code.
//
// Needs the dev stack up: `docker compose up -d --build`. Run with:
//   bun run test:integration

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createApp } from "../../src/app";

const prismaClient = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WEBSITE_NAME = `data-path-test-${Date.now()}`;
const HOSTNAME = "data-path-test.example.com";

let app: Awaited<ReturnType<typeof createApp>>;
let adminToken: string;
let websiteId: string;

async function request(path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

async function authedJson(path: string, init?: RequestInit) {
  const res = await request(path, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${adminToken}` },
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  app = await createApp();

  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "umami" }),
  }).then((r) => r.json());
  if (!login.token) {
    throw new Error(`admin login failed — is the dev DB up? (docker compose up -d --build): ${JSON.stringify(login)}`);
  }
  adminToken = login.token;

  const created = await authedJson("/api/websites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: WEBSITE_NAME, domain: HOSTNAME }),
  });
  websiteId = created.body.id;
});

afterAll(async () => {
  if (websiteId) {
    await request(`/api/websites/${websiteId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
  }
  await prismaClient.$disconnect();
});

describe("send -> Postgres -> stats: a real pageview produces the exact expected counts", () => {
  it("POST /api/send with a known payload is queryable via /api/websites/:id/stats", async () => {
    const sendRes = await request("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": CHROME_UA },
      body: JSON.stringify({
        type: "event",
        payload: {
          website: websiteId,
          url: "/data-path-test",
          hostname: HOSTNAME,
          title: "Data Path Test",
        },
      }),
    });
    expect(sendRes.status).toBe(200);
    const sendBody = await sendRes.json();
    expect(sendBody.sessionId).toBeTruthy();
    expect(sendBody.visitId).toBeTruthy();

    const now = Date.now();
    const stats = await authedJson(
      `/api/websites/${websiteId}/stats?startAt=${now - 3_600_000}&endAt=${now + 3_600_000}`,
    );

    expect(stats.status).toBe(200);
    // Exact expected result for exactly one pageview from one session: one
    // pageview, one visitor, one visit, and a bounce (single-pageview visit).
    expect(stats.body.pageviews).toBe(1);
    expect(stats.body.visitors).toBe(1);
    expect(stats.body.visits).toBe(1);
    expect(stats.body.bounces).toBe(1);
  });

  it("the event lists with fields correctly parsed from the request (UA, path, title)", async () => {
    const events = await authedJson(
      `/api/websites/${websiteId}/events?startAt=${Date.now() - 3_600_000}&endAt=${Date.now() + 3_600_000}`,
    );

    expect(events.status).toBe(200);
    expect(events.body.data).toHaveLength(1);

    const event = events.body.data[0];
    expect(event.urlPath).toBe("/data-path-test");
    expect(event.pageTitle).toBe("Data Path Test");
    expect(event.hostname).toBe(HOSTNAME);
    // Parsed server-side from the Chrome UA string we sent — proves the
    // request actually carried our headers through mount.ts, not defaults.
    expect(event.browser).toBe("chrome");
    expect(event.os).toBe("Windows 10");
    expect(event.device).toBe("desktop");
  });

  it("the pageview lands in the correct hour bucket of the timeseries", async () => {
    const now = Date.now();
    const series = await authedJson(
      `/api/websites/${websiteId}/pageviews?startAt=${now - 3_600_000}&endAt=${now + 3_600_000}&unit=hour&timezone=UTC`,
    );

    expect(series.status).toBe(200);
    const currentHourBucket = new Date(now).toISOString().slice(0, 13) + ":00:00Z";
    const point = series.body.pageviews.find((p: { x: string; y: number }) => p.x === currentHourBucket);

    expect(point).toBeDefined();
    expect(point.y).toBe(1);
  });
});

// Session replay and heatmap both save straight to Postgres via Prisma
// (queries/sql/replays/saveRecording.ts, queries/sql/heatmap/saveHeatmapEvents.ts)
// — no ClickHouse/Kafka/S3 involved unless CLICKHOUSE_URL is set, which we
// don't. Separate website: recorder needs replayConfig enabled, which the
// suite above doesn't set.
describe("record -> Postgres -> replays: recorder chunks are queryable end to end", () => {
  const REPLAY_WEBSITE_NAME = `data-path-replay-test-${Date.now()}`;
  const REPLAY_HOSTNAME = "data-path-replay-test.example.com";
  let replayWebsiteId: string;

  afterAll(async () => {
    if (replayWebsiteId) {
      await request(`/api/websites/${replayWebsiteId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    }
  });

  it("enabling replayConfig on a website turns on recorderEnabled server-side", async () => {
    const created = await authedJson("/api/websites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: REPLAY_WEBSITE_NAME, domain: REPLAY_HOSTNAME }),
    });
    replayWebsiteId = created.body.id;

    const updated = await authedJson(`/api/websites/${replayWebsiteId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: REPLAY_WEBSITE_NAME,
        replayConfig: { replayEnabled: true, heatmapEnabled: true },
      }),
    });

    expect(updated.status).toBe(200);
    expect(updated.body.recorderEnabled).toBe(true);
  });

  it("a recorder chunk saved via /api/record shows up in /api/websites/:id/replays", async () => {
    const sendRes = await request("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": CHROME_UA },
      body: JSON.stringify({
        type: "event",
        payload: { website: replayWebsiteId, url: "/replay-test", hostname: REPLAY_HOSTNAME },
      }),
    }).then((r) => r.json());
    const cacheToken = sendRes.cache;
    expect(cacheToken).toBeTruthy();

    const recordRes = await request("/api/record", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": CHROME_UA,
        "x-umami-cache": cacheToken,
      },
      body: JSON.stringify({
        type: "record",
        payload: {
          website: replayWebsiteId,
          events: [{ type: 2, timestamp: Date.now(), data: { source: "test" } }],
        },
      }),
    });
    expect(recordRes.status).toBe(200);
    expect(await recordRes.json()).toEqual({ ok: true });

    const now = Date.now();
    const replays = await authedJson(
      `/api/websites/${replayWebsiteId}/replays?startAt=${now - 3_600_000}&endAt=${now + 3_600_000}`,
    );

    expect(replays.status).toBe(200);
    expect(replays.body.data).toHaveLength(1);
    expect(replays.body.data[0].sessionId).toBe(sendRes.sessionId);
    expect(replays.body.data[0].chunkCount).toBe(1);
  });

  it("a heatmap event batch saved via /api/record persists (heatmap_event row count)", async () => {
    const sendRes = await request("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": CHROME_UA },
      body: JSON.stringify({
        type: "event",
        payload: { website: replayWebsiteId, url: "/heatmap-test", hostname: REPLAY_HOSTNAME },
      }),
    }).then((r) => r.json());

    const recordRes = await request("/api/record", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": CHROME_UA,
        "x-umami-cache": sendRes.cache,
      },
      body: JSON.stringify({
        type: "heatmap",
        payload: {
          website: replayWebsiteId,
          events: [{ type: "click", url: "/heatmap-test", x: 100, y: 200 }],
        },
      }),
    });

    expect(recordRes.status).toBe(200);
    // /api/record swallows saveHeatmapEvents errors internally and always
    // returns {ok:true} regardless (see record/route.ts's try/catch) — a 200
    // here does NOT prove the row was written. Check Postgres directly
    // instead of trusting the response body.
    await recordRes.json();

    const row = await prismaClient.heatmapEvent.findFirst({
      where: { websiteId: replayWebsiteId, urlPath: "/heatmap-test" },
    });

    expect(row).not.toBeNull();
    expect(row.x).toBe(100);
    expect(row.y).toBe(200);
  });
});
