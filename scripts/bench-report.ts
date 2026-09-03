#!/usr/bin/env bun
// Reads bench-results.json (written by scripts/bench.ts for both "ours" and
// "official") and (re)generates the Benchmark section of README.md between
// the BENCHMARK:START/END markers. Re-run after every bench.ts run to keep
// README in sync — this script never hand-edits numbers, it only reads them.
//
// Usage: bun scripts/bench-report.ts

const RESULTS_FILE = new URL("../bench-results.json", import.meta.url).pathname;
const README_FILE = new URL("../README.md", import.meta.url).pathname;
const START = "<!-- BENCHMARK:START -->";
const END = "<!-- BENCHMARK:END -->";

interface LoadResult {
  reqPerSec: number;
  p50: number;
  p95: number;
  p99: number;
  failedRequests: number;
  peakMemMiB: number;
  peakCpuPct: number;
}

interface RunResult {
  label: string;
  measuredAt: string;
  idleMemMiB: number;
  write: LoadResult;
  read: LoadResult;
}

const results = (await Bun.file(RESULTS_FILE).json()) as Record<string, RunResult>;
const ours = results.ours;
const official = results.official;
if (!ours || !official) {
  console.error(
    `bench-results.json needs both "ours" and "official" entries — run scripts/bench.ts for each first.`,
  );
  process.exit(1);
}

const fmt = (n: number, digits = 1) => n.toLocaleString(undefined, { maximumFractionDigits: digits });
const ratio = (a: number, b: number) => `${fmt(a / b, 2)}×`;
// Signed: positive = ours is that much smaller (good for mem/CPU/latency),
// negative = ours is actually larger — never mislabel a negative as "less".
const pctDiff = (ours: number, official: number) => {
  const pct = (1 - ours / official) * 100;
  return pct >= 0 ? `${fmt(pct)}% less` : `${fmt(-pct)}% more`;
};

function xychart(title: string, yLabel: string, yMax: number, labels: string[], values: number[]) {
  const x = labels.map((l) => `"${l}"`).join(", ");
  const v = values.map((n) => fmt(n, n < 10 ? 2 : 0)).join(", ");
  return [
    "```mermaid",
    "xychart-beta",
    `    title "${title}"`,
    `    x-axis [${x}]`,
    `    y-axis "${yLabel}" 0 --> ${yMax}`,
    `    bar [${v}]`,
    "```",
  ].join("\n");
}

const LABELS = ["ours · write", "official · write", "ours · read", "official · read"];

const throughputChart = xychart(
  "Throughput (req/s, higher is better)",
  "req/s",
  Math.ceil(Math.max(ours.write.reqPerSec, official.write.reqPerSec) / 100) * 100,
  LABELS,
  [ours.write.reqPerSec, official.write.reqPerSec, ours.read.reqPerSec, official.read.reqPerSec],
);

const latencyChart = xychart(
  "Median latency, ms (lower is better)",
  "ms",
  Math.ceil(Math.max(ours.write.p50, official.write.p50, ours.read.p50, official.read.p50) / 50) * 50,
  LABELS,
  [ours.write.p50, official.write.p50, ours.read.p50, official.read.p50],
);

const MEM_LABELS = ["ours · idle", "official · idle", "ours · write", "official · write", "ours · read", "official · read"];
const memoryChart = xychart(
  "Peak memory, MiB (lower is better)",
  "MiB",
  Math.ceil(
    Math.max(ours.idleMemMiB, official.idleMemMiB, ours.write.peakMemMiB, official.write.peakMemMiB, ours.read.peakMemMiB, official.read.peakMemMiB) / 50,
  ) * 50,
  MEM_LABELS,
  [ours.idleMemMiB, official.idleMemMiB, ours.write.peakMemMiB, official.write.peakMemMiB, ours.read.peakMemMiB, official.read.peakMemMiB],
);

const cpuChart = xychart(
  "Peak CPU, % of one core (lower is better)",
  "%",
  Math.ceil(Math.max(ours.write.peakCpuPct, official.write.peakCpuPct) / 25) * 25,
  LABELS,
  [ours.write.peakCpuPct, official.write.peakCpuPct, ours.read.peakCpuPct, official.read.peakCpuPct],
);

const table = `
| Metric | umami-back-lite | official umami | difference |
|---|---:|---:|---:|
| Write — req/s | **${fmt(ours.write.reqPerSec)}** | ${fmt(official.write.reqPerSec)} | ${ratio(ours.write.reqPerSec, official.write.reqPerSec)} |
| Write — p50 / p95 / p99 (ms) | **${ours.write.p50} / ${ours.write.p95} / ${ours.write.p99}** | ${official.write.p50} / ${official.write.p95} / ${official.write.p99} | ${ratio(official.write.p50, ours.write.p50)} faster |
| Write — peak mem (MiB) | **${fmt(ours.write.peakMemMiB)}** | ${fmt(official.write.peakMemMiB)} | ${pctDiff(ours.write.peakMemMiB, official.write.peakMemMiB)} |
| Write — peak CPU (%) | **${fmt(ours.write.peakCpuPct)}** | ${fmt(official.write.peakCpuPct)} | ${pctDiff(ours.write.peakCpuPct, official.write.peakCpuPct)} |
| Read — req/s | **${fmt(ours.read.reqPerSec)}** | ${fmt(official.read.reqPerSec)} | ${ratio(ours.read.reqPerSec, official.read.reqPerSec)} |
| Read — p50 / p95 / p99 (ms) | **${ours.read.p50} / ${ours.read.p95} / ${ours.read.p99}** | ${official.read.p50} / ${official.read.p95} / ${official.read.p99} | ${ratio(official.read.p50, ours.read.p50)} faster |
| Read — peak mem (MiB) | **${fmt(ours.read.peakMemMiB)}** | ${fmt(official.read.peakMemMiB)} | ${pctDiff(ours.read.peakMemMiB, official.read.peakMemMiB)} |
| Read — peak CPU (%) | **${fmt(ours.read.peakCpuPct)}** | ${fmt(official.read.peakCpuPct)} | ${pctDiff(ours.read.peakCpuPct, official.read.peakCpuPct)} |
| Idle memory (MiB) | **${fmt(ours.idleMemMiB)}** | ${fmt(official.idleMemMiB)} | ${pctDiff(ours.idleMemMiB, official.idleMemMiB)} |
`.trim();

const section = `${START}
## Benchmark

\`umami-back-lite\` (Elysia on Bun) vs. the official \`ghcr.io/umami-software/umami:postgresql-latest\`
image, both pointed at one shared Postgres instance with identical schema and
seed data. Measured ${new Date(ours.measuredAt).toISOString().slice(0, 10)} —
reproduce with \`docker compose up -d --build\`, then
\`RATE_LIMIT_MAX=1000000 docker compose up -d app\` (raw write capacity — see
caveats),
\`bun scripts/bench.ts ours http://localhost:3000 <app-container>\`,
\`docker compose up -d app\` (restore the default limit), then
\`bun scripts/bench.ts official http://localhost:3001 <umami-container>\`,
and regenerate this section with \`bun scripts/bench-report.ts\`.

${throughputChart}

${latencyChart}

${memoryChart}

${cpuChart}

${table}

**Caveats:** both backends ran as sibling containers on one Docker host, so
absolute numbers are host-specific — the side-by-side comparison is the
meaningful part. Our rate limiter (\`RATE_LIMIT_MAX\`, 300 req/10s per IP by
default) was raised via env var during the write-path test to measure raw
capacity (a single-IP load generator would otherwise hit it almost
immediately); it ships enabled at the 300 default. Traffic came from one
synthetic IP/session, so the read path was measured against a small, uniform
dataset, not high-cardinality data at scale.
${END}`;

const readme = await Bun.file(README_FILE).text();
const next = readme.includes(START)
  ? readme.replace(new RegExp(`${START}[\\s\\S]*?${END}`), section)
  : `${readme.trimEnd()}\n\n${section}\n`;

await Bun.write(README_FILE, next);
console.log(`updated ${README_FILE}`);
