import { Glob } from "bun";

// Elysia's generics track every route/plugin added via chained `.use()`/`.get()`
// calls; a function mounting an open-ended, dynamically discovered set of routes
// can't participate in that statically, so this intentionally takes `any`.
type AnyElysia = any;

const API_ROOT = new URL("../vendor/umami/src/app/api", import.meta.url)
  .pathname;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function toElysiaPath(routeFile: string): string {
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
