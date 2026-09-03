// Stand-in for @clickhouse/client, not the real thing — see README's
// "ClickHouse" note. vendor/umami/src/lib/clickhouse.ts only calls
// createClient() from inside connect(), and connect() only runs when
// process.env.CLICKHOUSE_URL is set (never, in this deployment). The real
// package costs ~38MB of RSS just to *import*, unconditionally, regardless
// of whether it's ever actually used — this avoids paying that for every
// deployment to support a storage backend nobody running on a small VPS is
// also going to be running a ClickHouse cluster for.
export function createClient() {
  throw new Error(
    "umami-back-lite doesn't bundle the real @clickhouse/client (saves ~38MB RSS). " +
      "Don't set CLICKHOUSE_URL against this backend — use the official umami-software/umami image instead if you need ClickHouse.",
  );
}
