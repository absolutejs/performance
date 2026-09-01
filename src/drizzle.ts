/**
 * The five tables the performance console reads.
 *
 * Four independent measurements of the same question — is this fast enough to
 * use? Vitals are what a person's browser felt, resources are what the page had
 * to download, routes are what the server took, and the database numbers are
 * where server time usually goes. They stay separate because the fix for each
 * is different, and a single "performance" table with a `kind` column loses the
 * columns each one actually needs.
 *
 * The fifth, `perf_issues`, holds only human decisions. Everything a console
 * reports is derived live from the other four, so nothing on it can be stale;
 * what has to be stored is that somebody looked at a finding and accepted it.
 */
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/** One Core Web Vitals sample, as the browser reported it. */
export const webVitals = pgTable(
  "web_vitals",
  {
    at: bigint({ mode: "number" }).notNull(),
    /** Why it scored as it did — which element painted, whether the delay was
     *  bytes or render. Sent with the sample; there is no way to recover it
     *  afterwards. */
    attribution: jsonb().$type<Record<string, unknown>>(),
    environment: varchar({ length: 40 }),
    id: bigserial({ mode: "number" }).primaryKey(),
    /** The browser's own id for the metric, so a re-report of a metric that
     *  updates in place (LCP, CLS) can be recognised. */
    metric_id: varchar({ length: 64 }),
    /** LCP | INP | CLS | FCP | TTFB | TBT */
    name: varchar({ length: 8 }).notNull(),
    navigation_type: varchar({ length: 32 }),
    path: varchar({ length: 512 }).notNull(),
    /** good | needs-improvement | poor */
    rating: varchar({ length: 20 }).notNull(),
    release: varchar({ length: 160 }),
    /** Milliseconds for LCP/INP/FCP/TTFB/TBT; unitless for CLS. */
    value: doublePrecision().notNull(),
  },
  (table) => [
    index("web_vitals_at_idx").on(table.at),
    index("web_vitals_path_name_at_idx").on(table.path, table.name, table.at),
  ],
);

/**
 * Daily percentiles per page and metric.
 *
 * A trend cannot be drawn from raw samples without scanning every one of them
 * on every render, and the raw table is the busiest in this set. Rolled up
 * once, read cheaply forever.
 */
export const webVitalDaily = pgTable(
  "web_vital_daily",
  {
    day: timestamp().notNull(),
    id: bigserial({ mode: "number" }).primaryKey(),
    name: varchar({ length: 8 }).notNull(),
    p50: doublePrecision().notNull(),
    p75: doublePrecision().notNull(),
    p95: doublePrecision().notNull(),
    path: varchar({ length: 512 }).notNull(),
    /** Share of samples rated poor — the number Core Web Vitals is judged on. */
    poor_rate: doublePrecision().notNull(),
    samples: integer().notNull(),
  },
  (table) => [
    uniqueIndex("web_vital_daily_path_name_day_idx").on(
      table.path,
      table.name,
      table.day,
    ),
  ],
);

/** One static asset load, as Resource Timing reported it. */
export const resourcePerformance = pgTable(
  "resource_performance",
  {
    at: bigint({ mode: "number" }).notNull(),
    cache_hit: boolean().notNull().default(false),
    duration_ms: doublePrecision().notNull(),
    environment: varchar({ length: 40 }),
    id: bigserial({ mode: "number" }).primaryKey(),
    initiator_type: varchar({ length: 40 }).notNull(),
    /** The page that asked for it. */
    page: varchar({ length: 512 }).notNull(),
    protocol: varchar({ length: 20 }),
    release: varchar({ length: 160 }),
    /** The asset itself, origin-stripped for same-origin files. */
    target: varchar({ length: 512 }).notNull(),
    transfer_size: bigint({ mode: "number" }).notNull().default(0),
  },
  (table) => [
    index("resource_performance_at_idx").on(table.at),
    index("resource_performance_target_at_idx").on(table.target, table.at),
  ],
);

/**
 * Server latency, one counter per route per method per minute.
 *
 * A row per request would put a database write in the path of every request,
 * making the thing being measured slower, and leave millions of rows to scan.
 * A counter per window costs one upsert per route per flush and answers the
 * same questions. The unique index is what lets two processes flushing the same
 * minute sum rather than overwrite each other.
 */
export const routeLatencyWindows = pgTable(
  "route_latency_windows",
  {
    count: integer().notNull().default(0),
    error_count: integer().notNull().default(0),
    id: bigserial({ mode: "number" }).primaryKey(),
    /** Highest single request in the window — the tail users actually feel,
     *  which an average hides completely. */
    max_ms: doublePrecision().notNull().default(0),
    method: varchar({ length: 10 }).notNull(),
    release: varchar({ length: 160 }),
    route: varchar({ length: 256 }).notNull(),
    sum_ms: doublePrecision().notNull().default(0),
    window_start: timestamp().notNull(),
  },
  (table) => [
    uniqueIndex("route_latency_route_method_window_idx").on(
      table.route,
      table.method,
      table.window_start,
    ),
    index("route_latency_window_idx").on(table.window_start),
  ],
);

/** A decision somebody made about a finding: seen and accepted, or fixed. */
export const perfIssues = pgTable("perf_issues", {
  acknowledged_at: timestamp(),
  acknowledged_by: varchar({ length: 255 }),
  fingerprint: varchar({ length: 128 }).primaryKey(),
  fixed_at: timestamp(),
  fixed_by: varchar({ length: 255 }),
  kind: varchar({ length: 40 }).notNull(),
  note: text(),
  subject: varchar({ length: 512 }).notNull(),
  updated_at: timestamp().notNull().defaultNow(),
});

export const performanceDrizzleSchema = {
  perfIssues,
  resourcePerformance,
  routeLatencyWindows,
  webVitalDaily,
  webVitals,
};
