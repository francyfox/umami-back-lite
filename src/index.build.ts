// Entry point for the bundled build (`bun run build` — see package.json and
// scripts/generate-route-manifest.ts). Not used by dev or the current
// Docker image; those use src/index.ts, which mounts routes via mount.ts's
// own runtime Bun.Glob scan instead of this generated, statically-importable
// manifest.
import { createApp } from "./app";
import { apiRouteManifest, collectRouteManifest } from "./route-manifest.generated";

const app = await createApp({ apiRoutes: apiRouteManifest, collectRoutes: collectRouteManifest });

app.listen(3000);

console.log(`🦊 Elysia (bundled) is running at ${app.server?.hostname}:${app.server?.port}`);
