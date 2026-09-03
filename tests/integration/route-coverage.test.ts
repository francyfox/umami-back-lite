// Exhaustive mount coverage: every HTTP method exported by every vendored
// route.ts must actually be registered on the Elysia app. This is a purely
// mechanical check (no DB, no business logic, no auth) — it independently
// re-derives "what SHOULD be mounted" straight from the vendored source text
// (regex over exported function names), then diffs that against Elysia's own
// `app.routes` after mount.ts has run, so a file that silently fails to
// import, a method the glob loop skips, or a route that gets dropped shows
// up as a concrete missing {method, path} pair rather than a vague "some
// routes might not work."
//
// Deliberately reuses mount.ts's own `toElysiaPath` (the thing under test for
// "does :param syntax round-trip a real request" is tests/integration/adapter.test.ts's
// dynamic-param case) rather than reimplementing path conversion here — this
// test's only job is "did every discovered file's methods get registered",
// not "is the path syntax itself correct".
//
// No DB needed — Elysia registers a route the moment mount.ts calls
// app.get()/app.post()/etc, before any request is ever handled.

import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { API_ROOT, METHODS, toElysiaPath } from "../../src/mount";
import { createApp } from "../../src/app";

const METHOD_EXPORT_RE = /^export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/gm;

async function expectedRoutes(): Promise<Set<string>> {
  const glob = new Glob("**/route.ts");
  const expected = new Set<string>();

  for await (const file of glob.scan(API_ROOT)) {
    const text = await Bun.file(`${API_ROOT}/${file}`).text();
    const path = toElysiaPath(file);

    for (const match of text.matchAll(METHOD_EXPORT_RE)) {
      const method = match[1];
      if ((METHODS as readonly string[]).includes(method)) {
        expected.add(`${method} ${path}`);
      }
    }
  }

  return expected;
}

describe("mount.ts: every vendored route.ts method is actually registered", () => {
  it("mounts all 100+ expected {method, path} pairs with none missing or extra", async () => {
    const expected = await expectedRoutes();
    // Sanity check on the check itself — if this is small, the glob/regex
    // above broke and the rest of the test would pass vacuously.
    expect(expected.size).toBeGreaterThan(100);

    const app = await createApp();
    const actual = new Set(
      app.routes
        .map((r: { method: string; path: string }) => `${r.method} ${r.path}`)
        .filter((r: string) => r.includes(" /api/")),
    );

    const missing = [...expected].filter((r) => !actual.has(r)).sort();
    const extra = [...actual].filter((r) => !expected.has(r)).sort();

    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });
});
