/**
 * @absolutejs/performance — the server half of a performance console.
 *
 * Four measurements of one question: is this fast enough to use? Vitals are
 * what a person's browser felt, resources are what the page had to download,
 * routes are what the server took, and the database numbers are where server
 * time usually goes. Each is collected, stored and read differently, because
 * the fix for each is different.
 *
 * The browser half lives at `@absolutejs/performance/client`.
 */
export {
  perfIssues,
  performanceDrizzleSchema,
  resourcePerformance,
  routeLatencyWindows,
  webVitalDaily,
  webVitals,
} from "./drizzle";

export {
  databaseHealth,
  type AnyPgDatabase,
  type ConnectionState,
  type DatabaseHealth,
  type SlowQuery,
  type TableScan,
  type UnusedIndex,
} from "./database";

export {
  ratingFor,
  recordWebVital,
  rollUpWebVitals,
  VITAL_BUDGETS,
  VITAL_THRESHOLDS,
  webVitalMatrix,
  webVitalTrend,
  type VitalCell,
  type VitalRating,
  type WebVitalInput,
} from "./vitals";

export {
  createRouteTimingCollector,
  routeLatency,
  routeShape,
  routeTrend,
  type CreateRouteTimingOptions,
  type RouteLatencyRow,
  type RouteShapeOptions,
  type RouteTimingCollector,
  type RouteTimingInput,
} from "./routes";

export {
  recordResourceTimings,
  resourceTimings,
  type ResourceRow,
  type ResourceTimingInput,
} from "./resources";

export {
  performanceOverview,
  performanceProblems,
  setPerfDecision,
  startPerformanceRollup,
  type DecidedPerfProblem,
  type PerfDecisionInput,
  type PerfProblem,
  type PerformanceOverview,
  type PerformanceThresholds,
  type StartRollupOptions,
} from "./console";
