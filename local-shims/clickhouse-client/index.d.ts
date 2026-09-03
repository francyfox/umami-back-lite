// Minimal stand-in types — see index.js for why this package is stubbed.
// vendor/umami/src/lib/clickhouse.ts calls real ClickHouseClient methods
// (.query(), .insert()) on a variable typed as this in dead code paths
// gated behind `enabled` (CLICKHOUSE_URL) — `any` keeps that vendored file
// type-checking unmodified without pretending this stub has a real shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClickHouseClient = any;
export declare function createClient(config?: unknown): ClickHouseClient;
