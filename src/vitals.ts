/**
 * Core Web Vitals: ingest, scoring, rollup and the two reads a console needs.
 *
 * The thresholds are Google's, not ours to invent — they are the numbers search
 * ranking is scored against, so an application that picks its own is measuring
 * something no one else is looking at.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { AnyPgDatabase } from "./database";
import { webVitalDaily, webVitals } from "./drizzle";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 7;
const DEFAULT_TREND_DAYS = 30;
const MAX_MATRIX_ROWS = 300;
const ROLLUP_DAYS = 2;
const NAME_MAX = 8;
const PATH_MAX = 512;

export type VitalRating = "good" | "needs-improvement" | "poor";

/** Google's Core Web Vitals boundaries: at or under `good` is good, over `poor`
 *  is poor, and the band between the two is "needs improvement". */
export const VITAL_THRESHOLDS: Record<string, { good: number; poor: number }> =
  {
    CLS: { good: 0.1, poor: 0.25 },
    FCP: { good: 1800, poor: 3000 },
    INP: { good: 200, poor: 500 },
    LCP: { good: 2500, poor: 4000 },
    TBT: { good: 200, poor: 600 },
    TTFB: { good: 800, poor: 1800 },
  };

/** The budget a console scores against: the `good` boundary of each metric. */
export const VITAL_BUDGETS: Record<string, number> = Object.fromEntries(
  Object.entries(VITAL_THRESHOLDS).map(([name, band]) => [name, band.good]),
);

/**
 * Score a raw measurement.
 *
 * The browser reports a rating alongside each vital, but a sample recovered
 * from somewhere else — a backfill, a synthetic run, an older collector that
 * did not store one — still has to be scored, and it has to be scored the same
 * way or the two are not comparable.
 */
export const ratingFor = (name: string, value: number): VitalRating => {
  const band = VITAL_THRESHOLDS[name];
  if (band === undefined) return "good";
  if (value <= band.good) return "good";

  return value > band.poor ? "poor" : "needs-improvement";
};

export type WebVitalInput = {
  at?: number;
  attribution?: Record<string, unknown>;
  environment?: string;
  /** The browser's metric id. */
  id?: string;
  name: string;
  navigationType?: string;
  path: string;
  /** Omit to score the value against the published thresholds. */
  rating?: string;
  release?: string;
  value: number;
};

export const recordWebVital = async (
  db: AnyPgDatabase,
  input: WebVitalInput,
) => {
  await db.insert(webVitals).values({
    at: input.at ?? Date.now(),
    attribution: input.attribution ?? null,
    environment: input.environment ?? null,
    metric_id: input.id ?? null,
    name: input.name.slice(0, NAME_MAX),
    navigation_type: input.navigationType ?? null,
    path: input.path.slice(0, PATH_MAX),
    rating: input.rating ?? ratingFor(input.name, input.value),
    release: input.release ?? null,
    value: input.value,
  });
};

/**
 * Roll raw vitals into the daily table.
 *
 * p75 is the headline because that is what Core Web Vitals is scored on; p50
 * and p95 sit either side so a page whose median is fine but whose tail is bad
 * is visible as what it is. Recomputes each day from the raw rows and upserts,
 * so running it twice — or in two processes at once mid-deploy — costs a
 * duplicate scan and nothing else.
 *
 * The window defaults to two days rather than one: a rollup that only ever
 * recomputed today would leave yesterday's last hour permanently short.
 */
export const rollUpWebVitals = async (
  db: AnyPgDatabase,
  days = ROLLUP_DAYS,
) => {
  const since = Date.now() - days * DAY_MS;
  const rows = await db
    .select({
      day: sql<string>`to_timestamp(floor(${webVitals.at} / 86400000) * 86400)::date`.as(
        "day",
      ),
      name: webVitals.name,
      p50: sql<number>`percentile_cont(0.5) within group (order by ${webVitals.value})`,
      p75: sql<number>`percentile_cont(0.75) within group (order by ${webVitals.value})`,
      p95: sql<number>`percentile_cont(0.95) within group (order by ${webVitals.value})`,
      path: webVitals.path,
      poorRate: sql<number>`avg(case when ${webVitals.rating} = 'poor' then 1.0 else 0.0 end)`,
      samples: sql<number>`count(*)::int`,
    })
    .from(webVitals)
    .where(gte(webVitals.at, since))
    // Group by the first select item. Naming the expression again would emit a
    // second parameter placeholder that does not match the first.
    .groupBy(sql`1`, webVitals.path, webVitals.name);

  if (rows.length === 0) return { rolled: 0 };
  await db
    .insert(webVitalDaily)
    .values(
      rows.map((row) => ({
        day: new Date(row.day),
        name: row.name,
        p50: Number(row.p50),
        p75: Number(row.p75),
        p95: Number(row.p95),
        path: row.path,
        poor_rate: Number(row.poorRate),
        samples: Number(row.samples),
      })),
    )
    .onConflictDoUpdate({
      set: {
        p50: sql`excluded.p50`,
        p75: sql`excluded.p75`,
        p95: sql`excluded.p95`,
        poor_rate: sql`excluded.poor_rate`,
        samples: sql`excluded.samples`,
      },
      target: [webVitalDaily.path, webVitalDaily.name, webVitalDaily.day],
    });

  return { rolled: rows.length };
};

export type VitalCell = {
  budget: number | null;
  name: string;
  /** p75 is past the budget — the page fails this metric. */
  over: boolean;
  p75: number;
  path: string;
  poorRate: number;
  samples: number;
};

/** Every page × metric over the window, busiest first. */
export const webVitalMatrix = async (
  db: AnyPgDatabase,
  days = DEFAULT_DAYS,
): Promise<VitalCell[]> => {
  const since = Date.now() - days * DAY_MS;
  const rows = await db
    .select({
      name: webVitals.name,
      p75: sql<number>`percentile_cont(0.75) within group (order by ${webVitals.value})`,
      path: webVitals.path,
      poor: sql<number>`sum(case when ${webVitals.rating} = 'poor' then 1 else 0 end)::int`,
      samples: sql<number>`count(*)::int`,
    })
    .from(webVitals)
    .where(gte(webVitals.at, since))
    .groupBy(webVitals.path, webVitals.name)
    .orderBy(desc(sql`count(*)`))
    .limit(MAX_MATRIX_ROWS);

  return rows.map((row) => {
    const budget = VITAL_BUDGETS[row.name] ?? null;
    const p75 = Number(row.p75);
    const samples = Number(row.samples);

    return {
      budget,
      name: row.name,
      over: budget !== null && budget < p75,
      p75,
      path: row.path,
      poorRate: samples > 0 ? Number(row.poor) / samples : 0,
      samples,
    };
  });
};

/** The daily series behind one cell of the matrix — did this get worse, and
 *  when. */
export const webVitalTrend = (
  db: AnyPgDatabase,
  name: string,
  path: string,
  days = DEFAULT_TREND_DAYS,
) =>
  db
    .select({
      day: webVitalDaily.day,
      p75: webVitalDaily.p75,
      poorRate: webVitalDaily.poor_rate,
      samples: webVitalDaily.samples,
    })
    .from(webVitalDaily)
    .where(
      and(
        eq(webVitalDaily.name, name),
        eq(webVitalDaily.path, path),
        gte(webVitalDaily.day, new Date(Date.now() - days * DAY_MS)),
      ),
    )
    .orderBy(webVitalDaily.day);
