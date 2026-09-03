import { Glob } from "bun";

// Elysia's generics track every route/plugin added via chained `.use()`/`.get()`
// calls; a function mounting an open-ended, dynamically discovered set of routes
// can't participate in that statically, so this intentionally takes `any`.
type AnyElysia = any;

export const API_ROOT = new URL("../vendor/umami/src/app/api", import.meta.url)
  .pathname;
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export function toElysiaPath(routeFile: string): string {
  return (
    "/api/" +
    routeFile
      .replace(/\/route\.ts$/, "")
      .split("/")
      .map((seg) => (seg.startsWith("[") ? ":" + seg.slice(1, -1) : seg))
      .join("/")
  );
}

export async function mountUmamiRoutes(app: AnyElysia) {
  const glob = new Glob("**/route.ts");
  let count = 0;

  for await (const file of glob.scan(API_ROOT)) {
    const path = toElysiaPath(file);
    const mod = await import(`${API_ROOT}/${file}`);

    for (const method of METHODS) {
      if (typeof mod[method] === "function") {
        app[method.toLowerCase()](
          path,
          ({ request, params }: { request: Request; params: Record<string, string> }) =>
            mod[method](request, { params: Promise.resolve(params) }),
        );
        count++;
      }
    }
  }

  console.log(`Mounted ${count} umami route handlers from ${API_ROOT}`);

  return app;
}

const COLLECT_ROOT = new URL("../vendor/umami/src/app/(collect)", import.meta.url)
  .pathname;

// Fixed, not globbed: only two files live under app/(collect) upstream (the
// only vendored code that touched next/server — see scripts/vendor-umami.sh
// for the mechanical NextResponse -> Response patch). A rename or a third
// (collect) route upstream needs a matching update here.
export async function mountCollectRoutes(app: AnyElysia) {
  const pixel = await import(`${COLLECT_ROOT}/p/[slug]/route.ts`);
  const link = await import(`${COLLECT_ROOT}/q/[slug]/route.ts`);

  app.get("/p/:slug", ({ request, params }: { request: Request; params: Record<string, string> }) =>
    pixel.GET(request, { params: Promise.resolve(params) }),
  );
  app.get("/q/:slug", ({ request, params }: { request: Request; params: Record<string, string> }) =>
    link.GET(request, { params: Promise.resolve(params) }),
  );

  console.log("Mounted 2 umami collect route handlers (pixel beacon + short-link redirect)");

  return app;
}
