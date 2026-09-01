/**
 * What a performance console shows: the headline numbers, and the one
 * actionable list.
 *
 * Findings are derived live from the four measurements rather than stored, so
 * nothing on the list can be stale — a page that got fixed stops appearing
 * because it got fixed. The only stored half is the human decision, joined on,
 * so a known and accepted slow page stops shouting without disappearing.
 */
import { count, eq, gte, sql } from "drizzle-orm";
import { databaseHealth, type AnyPgDatabase } from "./database";
import {
  perfIssues,
  resourcePerformance,
  routeLatencyWindows,
  webVitals,
} from "./drizzle";
import { resourceTimings } from "./resources";
import { routeLatency } from "./routes";
import { rollUpWebVitals, VITAL_BUDGETS, webVitalMatrix } from "./vitals";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 7;
const PERCENT = 100;
const ROLLUP_MS = 900_000;
const ROLLUP_WARMUP_MS = 60_000;
const SUBJECT_MAX = 512;
const QUERY_SUBJECT_MAX = 120;

export type PerformanceOverview = {
  days: number;
  resourceSamples: number;
  routes: { calls: number; errorRate: number; meanMs: number };
  vitals: {
    budget: number | null;
    name: string;
    over: boolean;
    p75: number;
    poorRate: number;
    samples: number;
  }[];
};

/** The four headline numbers, in one round of queries. */
export const performanceOverview = async (
  db: AnyPgDatabase,
  days = DEFAULT_DAYS,
): Promise<PerformanceOverview> => {
  const since = Date.now() - days * DAY_MS;
  const sinceDate = new Date(since);
  const [vitals, routes, resources] = await Promise.all([
    db
      .select({
        name: webVitals.name,
        p75: sql<number>`percentile_cont(0.75) within group (order by ${webVitals.value})`,
        poor: sql<number>`sum(case when ${webVitals.rating} = 'poor' then 1 else 0 end)::int`,
        samples: sql<number>`count(*)::int`,
      })
      .from(webVitals)
      .where(gte(webVitals.at, since))
      .groupBy(webVitals.name),
    db
      .select({
        calls: sql<number>`sum(${routeLatencyWindows.count})::int`,
        errors: sql<number>`sum(${routeLatencyWindows.error_count})::int`,
        totalMs: sql<number>`sum(${routeLatencyWindows.sum_ms})`,
      })
      .from(routeLatencyWindows)
      .where(gte(routeLatencyWindows.window_start, sinceDate)),
    db
      .select({ value: count() })
      .from(resourcePerformance)
      .where(gte(resourcePerformance.at, since)),
  ]);

  const [routeTotals] = routes;
  const calls = Number(routeTotals?.calls ?? 0);

  return {
    days,
    resourceSamples: Number(resources[0]?.value ?? 0),
    routes: {
      calls,
      errorRate: calls > 0 ? Number(routeTotals?.errors ?? 0) / calls : 0,
      meanMs: calls > 0 ? Number(routeTotals?.totalMs ?? 0) / calls : 0,
    },
    vitals: vitals.map((row) => {
      const budget = VITAL_BUDGETS[row.name] ?? null;
      const p75 = Number(row.p75);
      const samples = Number(row.samples);

      return {
        budget,
        name: row.name,
        over: budget !== null && budget < p75,
        p75,
        poorRate: samples > 0 ? Number(row.poor) / samples : 0,
        samples,
      };
    }),
  };
};

export type PerfProblem = {
  detail: string;
  /** Stable identity, so a decision made about a finding survives the finding
   *  being re-derived on the next page load. */
  fingerprint: string;
  kind: "query" | "resource" | "route" | "route-errors" | "vital";
  severity: "high" | "medium";
  subject: string;
  value: number;
};

export type DecidedPerfProblem = PerfProblem & {
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  fixedAt: Date | null;
  note: string | null;
};

export type PerformanceThresholds = {
  /** Mean response time at which a route is a problem. Default 500ms. */
  slowRouteMeanMs?: number;
  /** Mean load time at which a static asset is a problem. Default 1500ms. */
  slowResourceMs?: number;
  /** Mean execution time at which a query is a problem. Default 500ms. */
  slowQueryMeanMs?: number;
  /** Share of 5xx that makes a route a problem. Default 2%. */
  errorRateLimit?: number;
  /** Share of poor samples that raises a vital from medium to high. Default
   *  25%. */
  poorRateLimit?: number;
  /** Calls a route needs before its average means anything. Default 20. */
  minRouteCalls?: number;
  /** Samples a page × metric needs before it is judged. Default 5. */
  minVitalSamples?: number;
};

const DEFAULT_THRESHOLDS: Required<PerformanceThresholds> = {
  errorRateLimit: 0.02,
  minRouteCalls: 20,
  minVitalSamples: 5,
  poorRateLimit: 0.25,
  slowQueryMeanMs: 500,
  slowResourceMs: 1500,
  slowRouteMeanMs: 500,
};

/**
 * Everything currently over budget, from all four measurements, in one list.
 *
 * Severity is deliberately coarse — high and medium, no numeric score. A score
 * invites tuning the score; two buckets ask the only question that matters,
 * which is whether this is worth stopping for.
 */
export const performanceProblems = async (
  db: AnyPgDatabase,
  days = DEFAULT_DAYS,
  thresholds: PerformanceThresholds = {},
): Promise<DecidedPerfProblem[]> => {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const [matrix, routes, resources, health, decisions] = await Promise.all([
    webVitalMatrix(db, days),
    routeLatency(db, days),
    resourceTimings(db, days),
    databaseHealth(db),
    db.select().from(perfIssues),
  ]);

  const problems: PerfProblem[] = [];

  for (const cell of matrix) {
    if (cell.samples < limits.minVitalSamples || !cell.over) continue;
    problems.push({
      detail: `p75 ${Math.round(cell.p75)} against a budget of ${cell.budget}`,
      fingerprint: `vital:${cell.name}:${cell.path}`,
      kind: "vital",
      severity: cell.poorRate > limits.poorRateLimit ? "high" : "medium",
      subject: `${cell.name} on ${cell.path}`,
      value: cell.p75,
    });
  }

  for (const route of routes) {
    if (route.calls < limits.minRouteCalls) continue;
    if (route.meanMs > limits.slowRouteMeanMs)
      problems.push({
        detail: `${Math.round(route.meanMs)}ms average over ${route.calls} calls`,
        fingerprint: `route:${route.method}:${route.route}`,
        kind: "route",
        severity: route.meanMs > limits.slowRouteMeanMs * 2 ? "high" : "medium",
        subject: `${route.method} ${route.route}`,
        value: route.meanMs,
      });
    if (route.errorRate > limits.errorRateLimit)
      problems.push({
        detail: `${(route.errorRate * PERCENT).toFixed(1)}% of calls returned 5xx`,
        fingerprint: `route-errors:${route.method}:${route.route}`,
        kind: "route-errors",
        severity: "high",
        subject: `${route.method} ${route.route}`,
        value: route.errorRate,
      });
  }

  for (const resource of resources)
    if (resource.meanMs > limits.slowResourceMs)
      problems.push({
        detail: `${Math.round(resource.meanMs)}ms average across ${resource.loads} loads`,
        fingerprint: `resource:${resource.target}`,
        kind: "resource",
        severity: "medium",
        subject: resource.target,
        value: resource.meanMs,
      });

  for (const query of health.slowQueries)
    if (query.meanMs > limits.slowQueryMeanMs)
      problems.push({
        detail: `${query.meanMs}ms average over ${query.calls} calls`,
        fingerprint: `query:${query.queryid}`,
        kind: "query",
        severity: "high",
        subject: query.query.replace(/\s+/gu, " ").slice(0, QUERY_SUBJECT_MAX),
        value: query.meanMs,
      });

  const byFingerprint = new Map(
    decisions.map((row) => [row.fingerprint, row] as const),
  );

  return problems
    .map((problem) => {
      const decision = byFingerprint.get(problem.fingerprint);

      return {
        ...problem,
        acknowledgedAt: decision?.acknowledged_at ?? null,
        acknowledgedBy: decision?.acknowledged_by ?? null,
        fixedAt: decision?.fixed_at ?? null,
        note: decision?.note ?? null,
      };
    })
    .sort((left, right) => {
      if (left.severity !== right.severity)
        return left.severity === "high" ? -1 : 1;

      return right.value - left.value;
    });
};

export type PerfDecisionInput = {
  by: string;
  fingerprint: string;
  kind: string;
  note?: string | null;
  /** `open` deletes the decision, putting the finding back on the list as it
   *  was — the only honest way to undo an acknowledgement. */
  state: "acknowledged" | "fixed" | "open";
  subject: string;
};

export const setPerfDecision = async (
  db: AnyPgDatabase,
  input: PerfDecisionInput,
) => {
  if (input.state === "open") {
    await db
      .delete(perfIssues)
      .where(eq(perfIssues.fingerprint, input.fingerprint));

    return { ok: true as const };
  }
  const now = new Date();
  const values = {
    acknowledged_at: now,
    acknowledged_by: input.by,
    fingerprint: input.fingerprint,
    fixed_at: input.state === "fixed" ? now : null,
    fixed_by: input.state === "fixed" ? input.by : null,
    kind: input.kind,
    note: input.note ?? null,
    subject: input.subject.slice(0, SUBJECT_MAX),
    updated_at: now,
  };
  await db
    .insert(perfIssues)
    .values(values)
    .onConflictDoUpdate({
      set: {
        acknowledged_at: values.acknowledged_at,
        acknowledged_by: values.acknowledged_by,
        fixed_at: values.fixed_at,
        fixed_by: values.fixed_by,
        note: values.note,
        updated_at: now,
      },
      target: perfIssues.fingerprint,
    });

  return { ok: true as const };
};

export type StartRollupOptions = {
  /** How often the rollup runs. Default 15 minutes. */
  intervalMs?: number;
  /** Delay before the first pass. Default 60s. */
  warmupMs?: number;
  /** Anything else worth running on the same timer — expiring bundles,
   *  pruning raw samples. Failures are swallowed like the rollup's own. */
  alsoRun?: readonly (() => Promise<unknown>)[];
};

/**
 * Keep the daily table current without anything outside the process having to
 * remember to do it.
 *
 * An endpoint a host scheduler calls is the usual arrangement, but a console
 * that is only correct when a crontab exists is a console that quietly goes
 * stale — the one failure a health dashboard cannot afford. The rollup is
 * idempotent, so running it here as well costs a duplicate scan and nothing
 * else.
 *
 * The first pass waits rather than firing at boot: a deploy restarts the
 * process, and a percentile scan does not belong in front of the first requests
 * after one.
 */
export const startPerformanceRollup = (
  db: AnyPgDatabase,
  options: StartRollupOptions = {},
) => {
  const {
    alsoRun = [],
    intervalMs = ROLLUP_MS,
    warmupMs = ROLLUP_WARMUP_MS,
  } = options;
  const run = () => {
    void rollUpWebVitals(db).catch(() => undefined);
    for (const task of alsoRun) void task().catch(() => undefined);
  };
  const timer = setInterval(run, intervalMs);
  // Telemetry must never hold the process open.
  timer.unref?.();
  const warmup = setTimeout(run, warmupMs);
  warmup.unref?.();

  return () => {
    clearInterval(timer);
    clearTimeout(warmup);
  };
};
