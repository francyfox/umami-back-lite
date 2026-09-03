import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "src/index.build.ts",
  platform: "node",
  format: "esm",
  outDir: "dist",
  dts: false,
  // Default (tsup-inherited) behavior treats every node_modules import as
  // external — fine for publishing a library, wrong for us: we want an
  // actually self-contained bundle. `file-type` stays external — see
  // scripts/generate-route-manifest.ts's header comment and CLAUDE.md for
  // why (Elysia's own optional dynamic import, wrapped in .catch(), whose
  // transitive dep `strtok3` has a genuinely broken package.json `exports`
  // map — same bug class hit before with @sinclair/typebox).
  noExternal: () => true,
  external: ["bun", "file-type"],
});
