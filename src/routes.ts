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
import type { AnyPgDatabase } from "./database";
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

type Bucket = {
  count: number;
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
      bucket.sumMs += input.durationMs;
      bucket.maxMs = Math.max(bucket.maxMs, input.durationMs);
      if (input.status >= SERVER_ERROR) bucket.errors += 1;

      return;
    }
    // A caller inventing unique paths must not grow this map without bound;
    // dropping the overflow is better than leaking memory to measure it.
    if (buckets.size >= maxTrackedRoutes) return;
    buckets.set(key, {
      count: 1,
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
export const routeLatency = async (
  db: AnyPgDatabase,
  days = DEFAULT_DAYS,
): Promise<RouteLatencyRow[]> => {
  const since = new Date(Date.now() - days * DAY_MS);
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

    return {
      calls,
      errorRate: calls > 0 ? errors / calls : 0,
      errors,
      maxMs: Number(row.maxMs),
      meanMs: calls > 0 ? totalMs / calls : 0,
      method: row.method,
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

  return rows.map((row) => {
    const calls = Number(row.calls);

    return {
      at: new Date(row.bucket).getTime(),
      calls,
      maxMs: Number(row.maxMs),
      meanMs: calls > 0 ? Number(row.totalMs) / calls : 0,
    };
  });
};
