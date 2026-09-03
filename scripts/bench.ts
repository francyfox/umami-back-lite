#!/usr/bin/env bun
// Benchmarks one running backend (ours or the official image) and writes
// structured results into bench-results.json for scripts/bench-report.ts to
// turn into README charts. Requires the dev stack (`docker compose up -d
// --build`) to be up, with both backends pointed at the same Postgres.
//
// IMPORTANT: our backend's rate limiter (src/index.ts, max: 300 per 10s per
// IP by default) will cap `ab`'s single-IP load well below real capacity. To
// measure raw capacity, raise it for the container via env — no source edit
// or rebuild needed, `RATE_LIMIT_MAX` is read at runtime:
//   RATE_LIMIT_MAX=1000000 docker compose up -d app
// ...then restore the default before leaving the stack running:
//   docker compose up -d app
//
// Usage:
//   bun scripts/bench.ts <label> <baseUrl> <container> [password=umami]
//
// Example:
//   RATE_LIMIT_MAX=1000000 docker compose up -d app
//   bun scripts/bench.ts ours     http://localhost:3000 umami-back-lite-app-1
//   docker compose up -d app
//   bun scripts/bench.ts official http://localhost:3001 umami-back-lite-umami-1

import { $ } from "bun";

const RESULTS_FILE = new URL("../bench-results.json", import.meta.url).pathname;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WEBSITE_NAME = "bench-site";

interface LoadResult {
  reqPerSec: number;
  p50: number;
  p95: number;
  p99: number;
  failedRequests: number;
  peakMemMiB: number;
  peakCpuPct: number;
}

const [label, baseUrl, container, password = "umami"] = process.argv.slice(2);
if (!label || !baseUrl || !container) {
  console.error(
    "Usage: bun scripts/bench.ts <label> <baseUrl> <container> [password=umami]",
  );
  process.exit(1);
}

async function login(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}

async function ensureWebsite(token: string): Promise<string> {
  const list = await fetch(`${baseUrl}/api/websites`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  const existing = list.data?.find((w: { name: string }) => w.name === WEBSITE_NAME);
  if (existing) return existing.id;

  const created = await fetch(`${baseUrl}/api/websites`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: WEBSITE_NAME, domain: "bench.example.com" }),
  }).then((r) => r.json());
  return created.id;
}

async function sampleDockerStats(durationMs: number): Promise<{ peakMemMiB: number; peakCpuPct: number }> {
  let peakMemMiB = 0;
  let peakCpuPct = 0;
  const deadline = Date.now() + durationMs;

  while (Date.now() < deadline) {
    try {
      const out =
        await $`docker stats --no-stream --format "{{.CPUPerc}}\t{{.MemUsage}}" ${container}`.text();
      const [cpuRaw, memRaw] = out.trim().split("\t");
      const cpuPct = parseFloat(cpuRaw.replace("%", ""));
      const memMiB = parseFloat(memRaw); // "123.4MiB / 30.75GiB" -> 123.4
      if (!Number.isNaN(cpuPct)) peakCpuPct = Math.max(peakCpuPct, cpuPct);
      if (!Number.isNaN(memMiB)) peakMemMiB = Math.max(peakMemMiB, memMiB);
    } catch {
      // container may be between samples; ignore and keep polling
    }
    await Bun.sleep(500);
  }

  return { peakMemMiB, peakCpuPct };
}

function parseAbOutput(text: string) {
  const num = (re: RegExp) => {
    const m = text.match(re);
    if (!m) throw new Error(`ab output missing expected field: ${re}`);
    return parseFloat(m[1]);
  };
  return {
    reqPerSec: num(/Requests per second:\s+([\d.]+)/),
    failedRequests: num(/Failed requests:\s+(\d+)/),
    p50: num(/\s50%\s+(\d+)/),
    p95: num(/\s95%\s+(\d+)/),
    p99: num(/\s99%\s+(\d+)/),
  };
}

async function runLoad(opts: {
  method: "send" | "stats";
  durationSec: number;
  concurrency: number;
  url: string;
  headers: string[];
  bodyFile?: string;
}): Promise<LoadResult> {
  const args = ["-t", String(opts.durationSec), "-c", String(opts.concurrency), "-n", "5000000"];
  for (const h of opts.headers) args.push("-H", h);
  if (opts.bodyFile) args.push("-p", opts.bodyFile, "-T", "application/json");
  args.push(opts.url);

  const abPromise = $`ab ${args}`.text();
  const statsPromise = sampleDockerStats((opts.durationSec + 3) * 1000);

  const [abOut, stats] = await Promise.all([abPromise, statsPromise]);
  const parsed = parseAbOutput(abOut);

  return { ...parsed, ...stats };
}

async function main() {
  console.log(`=== ${label} (${baseUrl}, container ${container}) ===`);

  const token = await login();
  const websiteId = await ensureWebsite(token);

  console.log("idle sample (3s, no load)...");
  const idle = await sampleDockerStats(3000);

  const sendPayloadFile = `/tmp/bench-send-payload-${label}.json`;
  await Bun.write(
    sendPayloadFile,
    JSON.stringify({
      type: "event",
      payload: { website: websiteId, url: "/bench-page", hostname: "bench.example.com", title: "Bench Page" },
    }),
  );

  console.log("write path: /api/send ...");
  const write = await runLoad({
    method: "send",
    durationSec: 15,
    concurrency: 50,
    url: `${baseUrl}/api/send`,
    headers: [`User-Agent: ${UA}`],
    bodyFile: sendPayloadFile,
  });
  console.log(write);

  const now = Date.now();
  const statsUrl = `${baseUrl}/api/websites/${websiteId}/stats?startAt=${now - 3_600_000}&endAt=${now}`;

  console.log("read path: /api/websites/:id/stats ...");
  const read = await runLoad({
    method: "stats",
    durationSec: 10,
    concurrency: 30,
    url: statsUrl,
    headers: [`Authorization: Bearer ${token}`],
  });
  console.log(read);

  const existing = (await Bun.file(RESULTS_FILE)
    .json()
    .catch(() => ({}))) as Record<string, unknown>;

  existing[label] = {
    label,
    baseUrl,
    container,
    measuredAt: new Date().toISOString(),
    idleMemMiB: idle.peakMemMiB,
    write,
    read,
  };

  await Bun.write(RESULTS_FILE, JSON.stringify(existing, null, 2) + "\n");
  console.log(`\nwrote ${RESULTS_FILE}`);
}

await main();
