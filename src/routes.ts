/**
 * Server route latency.
 *
 * A browser can say a page felt slow; only the server can say whether it was
 * slow because the server was. Every response is timed and folded into a
 * per-route counter, so a console can answer "which endpoint is costing us, and
 * did that change with the last deploy?".
 *
 * Aggregated in memory and flushed on a timer rather than written per request:
 * a row per request would put a database write in the path of every request —
 * making the thing being measured slower — and leave millions of rows to scan.
 */
import { sql } from "drizzle-orm";
import { and, desc, eq, gte } from "drizzle-orm";
import { rowsOf, type AnyPgDatabase } from "./database";
import { routeLatencyWindows } from "./drizzle";

const DAY_MS = 86_400_000;
const WINDOW_MS = 60_000;
const FLUSH_MS = 30_000;
const MAX_TRACKED_ROUTES = 500;
const SERVER_ERROR = 500;
const DEFAULT_DAYS = 7;
const DEFAULT_TREND_DAYS = 14;
const MAX_ROWS = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const LONG_HEX = /^[0-9a-f]{12,}$/iu;
const NUMERIC = /^\d+$/u;
/** Stripe-style prefixed object ids, and anything else shaped like them. The
 *  body allows underscores because test-mode ids carry a second one
 *  (`cs_test_a1B2…`), and without it every test checkout is its own route. */
const PREFIXED_ID =
  /^(?:cs|pi|sub|cus|in|seti|ch|re|prod|price)_[A-Za-z0-9_]+$/u;

export type RouteShapeOptions = {
  /** Extra patterns for id segments a caller's own routes use. */
  idPatterns?: readonly RegExp[];
  /** Placeholder written in place of an id. Default `:id`. */
  placeholder?: string;
};

/**
 * Collapse a concrete URL to the route shape it belongs to.
 *
 * `/orders/75942bbb-…` and `/orders/50f48dac-…` are the same route with
 * different arguments; kept apart they fragment the data into thousands of
 * one-request "routes" and answer nothing.
 */
export const routeShape = (
  pathname: string,
  options: RouteShapeOptions = {},
): string => {
  const { idPatterns = [], placeholder = ":id" } = options;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  const shaped = segments.map((segment) =>
    UUID.test(segment) ||
    LONG_HEX.test(segment) ||
    NUMERIC.test(segment) ||
    PREFIXED_ID.test(segment) ||
    idPatterns.some((pattern) => pattern.test(segment))
      ? placeholder
      : segment,
  );

  return `/${shaped.join("/")}`;
};

/**
 * Upper bounds (ms) of the latency histogram every route window keeps; one
 * more bucket counts anything slower than the last. Log-spaced, so a 12ms
 * API call and a 4s report both land in a bucket that resolves them.
 */
export const LATENCY_BUCKETS_MS: readonly number[] = [
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
];
const BUCKET_COUNT = LATENCY_BUCKETS_MS.length + 1;

const bucketIndex = (durationMs: number) => {
  const index = LATENCY_BUCKETS_MS.findIndex((bound) => durationMs <= bound);

  return index === -1 ? LATENCY_BUCKETS_MS.length : index;
};

/** Element-wise sum of histograms (shorter ones read as zeros). */
export const mergeHistograms = (histograms: readonly (readonly number[])[]) => {
  const merged: number[] = Array.from({ length: BUCKET_COUNT }, () => 0);
  for (const histogram of histograms)
    histogram.forEach((count, index) => {
      if (index < BUCKET_COUNT) merged[index] = (merged[index] ?? 0) + count;
    });

  return merged;
};

/**
 * The latency at quantile `q` (0–1) of a histogram, interpolated inside its
 * bucket; capped at the window's max so a bucket's bound never claims a
 * request slower than any that ran. Null for an empty histogram.
 */
export const histogramQuantile = (
  histogram: readonly number[],
  q: number,
  maxMs = Number.POSITIVE_INFINITY,
) => {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;
  const rank = q * total;
  let seen = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    const count = histogram[index] ?? 0;
    if (count > 0 && seen + count >= rank) {
      const lower = index === 0 ? 0 : (LATENCY_BUCKETS_MS[index - 1] ?? 0);
      const upper = LATENCY_BUCKETS_MS[index] ?? Math.max(lower, maxMs);
      const within = (rank - seen) / count;

      return Math.min(maxMs, lower + (upper - lower) * within);
    }
    seen += count;
  }

  return Math.min(
    maxMs,
    LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1] ?? 0,
  );
};

type Bucket = {
  count: number;
  histogram: number[];
  errors: number;
  maxMs: number;
  method: string;
  route: string;
  sumMs: number;
  windowStart: number;
};

export type RouteTimingInput = {
  durationMs: number;
  method: string;
  pathname: string;
  status: number;
};

export type RouteTimingCollector = {
  /** Fold one response into the in-memory counters. */
  record: (input: RouteTimingInput) => void;
  /** Write the counters out and clear them. */
  flush: (db: AnyPgDatabase, release?: string) => Promise<{ flushed: number }>;
  /** Start the periodic flush; returns a stop handle. */
  start: (db: AnyPgDatabase, release?: string) => () => void;
  /** How many buckets are waiting. */
  pending: () => number;
};

export type CreateRouteTimingOptions = {
  /** Aggregation window. Default 60s. */
  windowMs?: number;
  /** How often the counters are written. Default 30s. */
  flushMs?: number;
  /** Ceiling on distinct route+method+window buckets held in memory. */
  maxTrackedRoutes?: number;
  shape?: RouteShapeOptions;
};

/**
 * A collector is created rather than exported as module state so two of them —
 * a real one and a test's — cannot end up sharing counters, and so a process
 * that never starts one holds nothing.
 */
export const createRouteTimingCollector = (
  options: CreateRouteTimingOptions = {},
): RouteTimingCollector => {
  const {
    flushMs = FLUSH_MS,
    maxTrackedRoutes = MAX_TRACKED_ROUTES,
    shape,
    windowMs = WINDOW_MS,
  } = options;
  const buckets = new Map<string, Bucket>();

  const record = (input: RouteTimingInput) => {
    const route = routeShape(input.pathname, shape);
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    const key = `${route}|${input.method}|${windowStart}`;
    const bucket = buckets.get(key);
    if (bucket !== undefined) {
      bucket.count += 1;
      const slot = bucketIndex(input.durationMs);
      bucket.histogram[slot] = (bucket.histogram[slot] ?? 0) + 1;
      bucket.sumMs += input.durationMs;
      bucket.maxMs = Math.max(bucket.maxMs, input.durationMs);
      if (input.status >= SERVER_ERROR) bucket.errors += 1;

      return;
    }
    // A caller inventing unique paths must not grow this map without bound;
    // dropping the overflow is better than leaking memory to measure it.
    if (buckets.size >= maxTrackedRoutes) return;
    const histogram: number[] = Array.from({ length: BUCKET_COUNT }, () => 0);
    histogram[bucketIndex(input.durationMs)] = 1;
    buckets.set(key, {
      count: 1,
      histogram,
      errors: input.status >= SERVER_ERROR ? 1 : 0,
      maxMs: input.durationMs,
      method: input.method,
      route,
      sumMs: input.durationMs,
      windowStart,
    });
  };

  /** Adds to whatever is already stored for the window, so two processes
   *  flushing the same minute sum rather than overwrite each other. */
  const flush = async (db: AnyPgDatabase, release?: string) => {
    if (buckets.size === 0) return { flushed: 0 };
    const pending = [...buckets.values()];
    buckets.clear();
    await db
      .insert(routeLatencyWindows)
      .values(
        pending.map((bucket) => ({
          count: bucket.count,
          error_count: bucket.errors,
          latency_buckets: bucket.histogram,
          max_ms: bucket.maxMs,
          method: bucket.method,
          release: release ?? null,
          route: bucket.route,
          sum_ms: bucket.sumMs,
          window_start: new Date(bucket.windowStart),
        })),
      )
      .onConflictDoUpdate({
        set: {
          count: sql`${routeLatencyWindows.count} + excluded.count`,
          error_count: sql`${routeLatencyWindows.error_count} + excluded.error_count`,
          // Bucket by bucket: what was stored plus what this process saw.
          latency_buckets: sql`(
            select coalesce(array_agg(coalesce(stored.n, 0) + coalesce(added.n, 0) order by slot), '{}')
            from unnest(${routeLatencyWindows.latency_buckets}) with ordinality as stored(n, slot)
            full join unnest(excluded.latency_buckets) with ordinality as added(n, slot) using (slot)
          )`,
          max_ms: sql`greatest(${routeLatencyWindows.max_ms}, excluded.max_ms)`,
          sum_ms: sql`${routeLatencyWindows.sum_ms} + excluded.sum_ms`,
        },
        target: [
          routeLatencyWindows.route,
          routeLatencyWindows.method,
          routeLatencyWindows.window_start,
        ],
      });

    return { flushed: pending.length };
  };

  /**
   * Start the periodic flush.
   *
   * Deliberately does NOT install SIGTERM/SIGINT handlers, however tempting a
   * final flush on shutdown is. Registering a signal listener REPLACES the
   * runtime's default terminate behaviour: unless the handler itself exits, the
   * process survives the signal. A library that quietly does that to its host
   * turns every `kill`, every orchestrator stop, and every build step that
   * starts the server and signals it afterwards into a hang — which is exactly
   * how this was found, wedging a compile that starts the app to prerender.
   *
   * `beforeExit` is safe and stays: it fires only when the loop has already
   * emptied, so a short-lived process that ends on its own still reports.
   *
   * An application that wants a true shutdown drain owns its own shutdown, and
   * should call `flush()` from a handler that then exits or re-raises.
   */
  const start = (db: AnyPgDatabase, release?: string) => {
    const timer = setInterval(() => {
      void flush(db, release).catch(() => undefined);
    }, flushMs);
    // Telemetry must never hold the process open.
    timer.unref?.();
    process.once("beforeExit", () => {
      clearInterval(timer);
      void flush(db, release).catch(() => undefined);
    });

    return () => clearInterval(timer);
  };

  return { flush, pending: () => buckets.size, record, start };
};

export type RouteLatencyRow = {
  calls: number;
  /** The median and tail, from the window's latency histogram; null until a
   *  window recorded with buckets has been flushed. */
  p50Ms: number | null;
  p95Ms: number | null;
  /** The same route over the period before this one, to say whether it got
   *  slower: null when it saw no calls then. */
  previous: { calls: number; p95Ms: number | null } | null;
  errorRate: number;
  errors: number;
  maxMs: number;
  meanMs: number;
  method: string;
  route: string;
  /** Total time this route cost across the window — what to fix first is
   *  usually the biggest number here, not the slowest single call. */
  totalMs: number;
};

/**
 * Per-route latency over the window.
 *
 * Mean and max are reported together on purpose: a route with a 40ms mean and
 * an 8s max is not a fast route, it is a route that is fast until it isn't, and
 * the mean alone would say it was fine.
 */
type HistogramRow = {
  current: boolean;
  method: string;
  n: number;
  route: string;
  slot: number;
};

/** Each route's latency histogram over this period and the one before it,
 *  summed in the database (one row per route, period and bucket). */
const routeHistograms = async (
  db: AnyPgDatabase,
  since: Date,
  previousSince: Date,
) => {
  const rows = rowsOf<HistogramRow>(
    await db.execute(sql`
      select route, method,
        window_start >= ${since} as current,
        slot::int as slot, sum(n)::int as n
      from ${routeLatencyWindows},
        unnest(latency_buckets) with ordinality as bucket(n, slot)
      where window_start >= ${previousSince}
      group by route, method, current, slot
    `),
  );
  const histograms = new Map<string, number[]>();
  for (const row of rows) {
    const key = `${row.current ? "now" : "before"}|${row.method}|${row.route}`;
    const histogram =
      histograms.get(key) ?? Array.from({ length: BUCKET_COUNT }, () => 0);
    const index = Number(row.slot) - 1;
    if (index >= 0 && index < BUCKET_COUNT)
      histogram[index] = (histogram[index] ?? 0) + Number(row.n);
    histograms.set(key, histogram);
  }

  return histograms;
};

type PreviousRow = { calls: number; method: string; route: string };

export const routeLatency = async (
  db: AnyPgDatabase,
  days = DEFAULT_DAYS,
): Promise<RouteLatencyRow[]> => {
  const since = new Date(Date.now() - days * DAY_MS);
  const previousSince = new Date(since.getTime() - days * DAY_MS);
  const [histograms, previousCalls] = await Promise.all([
    routeHistograms(db, since, previousSince),
    db
      .select({
        calls: sql<number>`sum(${routeLatencyWindows.count})::int`,
        method: routeLatencyWindows.method,
        route: routeLatencyWindows.route,
      })
      .from(routeLatencyWindows)
      .where(
        and(
          gte(routeLatencyWindows.window_start, previousSince),
          sql`${routeLatencyWindows.window_start} < ${since}`,
        ),
      )
      .groupBy(routeLatencyWindows.route, routeLatencyWindows.method),
  ]);
  const before = new Map(
    (previousCalls as PreviousRow[]).map((row) => [
      `${row.method}|${row.route}`,
      Number(row.calls),
    ]),
  );
  const rows = await db
    .select({
      calls: sql<number>`sum(${routeLatencyWindows.count})::int`,
      errors: sql<number>`sum(${routeLatencyWindows.error_count})::int`,
      maxMs: sql<number>`max(${routeLatencyWindows.max_ms})`,
      method: routeLatencyWindows.method,
      route: routeLatencyWindows.route,
      totalMs: sql<number>`sum(${routeLatencyWindows.sum_ms})`,
    })
    .from(routeLatencyWindows)
    .where(gte(routeLatencyWindows.window_start, since))
    .groupBy(routeLatencyWindows.route, routeLatencyWindows.method)
    .orderBy(desc(sql`sum(${routeLatencyWindows.sum_ms})`))
    .limit(MAX_ROWS);

  return rows.map((row) => {
    const calls = Number(row.calls);
    const errors = Number(row.errors);
    const totalMs = Number(row.totalMs);

    const maxMs = Number(row.maxMs);
    const key = `${row.method}|${row.route}`;
    const histogram = histograms.get(`now|${key}`) ?? [];
    const previousHistogram = histograms.get(`before|${key}`) ?? [];
    const previousCount = before.get(key) ?? 0;

    return {
      calls,
      errorRate: calls > 0 ? errors / calls : 0,
      errors,
      maxMs,
      meanMs: calls > 0 ? totalMs / calls : 0,
      method: row.method,
      p50Ms: histogramQuantile(histogram, 0.5, maxMs),
      p95Ms: histogramQuantile(histogram, 0.95, maxMs),
      previous:
        previousCount > 0
          ? {
              calls: previousCount,
              p95Ms: histogramQuantile(previousHistogram, 0.95),
            }
          : null,
      route: row.route,
      totalMs,
    };
  });
};

/** Hourly series for one route — did this get slower, and when. */
export const routeTrend = async (
  db: AnyPgDatabase,
  route: string,
  days = DEFAULT_TREND_DAYS,
) => {
  const since = new Date(Date.now() - days * DAY_MS);
  const rows = await db
    .select({
      bucket:
        sql<string>`date_trunc('hour', ${routeLatencyWindows.window_start})`.as(
          "bucket",
        ),
      calls: sql<number>`sum(${routeLatencyWindows.count})::int`,
      maxMs: sql<number>`max(${routeLatencyWindows.max_ms})`,
      totalMs: sql<number>`sum(${routeLatencyWindows.sum_ms})`,
    })
    .from(routeLatencyWindows)
    .where(
      and(
        eq(routeLatencyWindows.route, route),
        gte(routeLatencyWindows.window_start, since),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const hourly = rowsOf<{ hour: string; n: number; slot: number }>(
    await db.execute(sql`
      select date_trunc('hour', window_start) as hour,
        slot::int as slot, sum(n)::int as n
      from ${routeLatencyWindows},
        unnest(latency_buckets) with ordinality as bucket(n, slot)
      where route = ${route} and window_start >= ${since}
      group by hour, slot
    `),
  );
  const histogramByHour = new Map<number, number[]>();
  for (const row of hourly) {
    const at = new Date(row.hour).getTime();
    const histogram =
      histogramByHour.get(at) ?? Array.from({ length: BUCKET_COUNT }, () => 0);
    const index = Number(row.slot) - 1;
    if (index >= 0 && index < BUCKET_COUNT)
      histogram[index] = (histogram[index] ?? 0) + Number(row.n);
    histogramByHour.set(at, histogram);
  }

  return rows.map((row) => {
    const calls = Number(row.calls);
    const at = new Date(row.bucket).getTime();
    const maxMs = Number(row.maxMs);

    return {
      at,
      calls,
      maxMs,
      meanMs: calls > 0 ? Number(row.totalMs) / calls : 0,
      p95Ms: histogramQuantile(histogramByHour.get(at) ?? [], 0.95, maxMs),
    };
  });
};
