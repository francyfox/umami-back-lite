#!/usr/bin/env bun
// Downloads DB-IP's free Country Lite geo database (no account/API key
// needed) so `/api/send` doesn't 500 on `getLocation()` for real (non-local)
// visitor IPs — vendor/umami/src/lib/detect.ts throws if GEOLITE_DB_PATH
// doesn't point at a real .mmdb file, and we don't run upstream's own
// build-geo.js (which needs a MaxMind account) to produce one.
//
// Country-only, not city: verified a full city-level database (theirs or
// MaxMind's official GeoLite2-City) adds ~65-125MB of RSS the moment the
// first real IP is looked up — that alone would erase most of this
// project's memory advantage over official Umami. Country Lite adds ~11MB.
//
// License: DB-IP Lite databases are CC BY 4.0 — attribution required, see
// README's Attribution section. https://db-ip.com/db/lite.php
//
// Usage: bun scripts/download-geo-db.ts [dest=geo/dbip-country-lite.mmdb]

import { gunzipSync } from "node:zlib";

const dest = process.argv[2] ?? "geo/dbip-country-lite.mmdb";

function monthsAgo(n: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function tryDownload(yearMonth: string): Promise<Uint8Array | null> {
  const url = `https://download.db-ip.com/free/dbip-country-lite-${yearMonth}.mmdb.gz`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

async function main() {
  // DB-IP publishes monthly; fall back a month in case this runs right at
  // a month boundary before the new file is up.
  for (const ym of [monthsAgo(0), monthsAgo(1)]) {
    const gz = await tryDownload(ym);
    if (gz) {
      const mmdb = gunzipSync(gz);
      await Bun.write(dest, mmdb);
      console.log(
        `Downloaded DB-IP Country Lite ${ym} -> ${dest} (${(mmdb.length / 1024 / 1024).toFixed(1)} MiB)`,
      );
      return;
    }
  }
  throw new Error(
    "Failed to download DB-IP Country Lite database (tried current and previous month)",
  );
}

await main();
