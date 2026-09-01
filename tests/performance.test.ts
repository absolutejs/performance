/**
 * Tests against real Postgres (PGlite, in-process).
 *
 * Almost everything here is an aggregate — percentiles, summed counters, a
 * conflict target that has to add rather than overwrite. A mock would agree
 * with whatever the code said, so these run the actual SQL.
 */
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import {
  createRouteTimingCollector,
  databaseHealth,
  performanceOverview,
  performanceProblems,
  ratingFor,
  recordResourceTimings,
  recordWebVital,
  resourceTimings,
  rollUpWebVitals,
  routeLatency,
  routeShape,
  routeTrend,
  setPerfDecision,
  webVitalMatrix,
  webVitalTrend,
} from "../src/index";
import { routeLatencyWindows } from "../src/drizzle";

const SCHEMA = `
  CREATE TABLE web_vitals (
    id bigserial PRIMARY KEY, at bigint NOT NULL, attribution jsonb,
    environment varchar(40), metric_id varchar(64), name varchar(8) NOT NULL,
    navigation_type varchar(32), path varchar(512) NOT NULL,
    rating varchar(20) NOT NULL, release varchar(160),
    value double precision NOT NULL
  );
  CREATE TABLE web_vital_daily (
    id bigserial PRIMARY KEY, day timestamp NOT NULL, name varchar(8) NOT NULL,
    p50 double precision NOT NULL, p75 double precision NOT NULL,
    p95 double precision NOT NULL, path varchar(512) NOT NULL,
    poor_rate double precision NOT NULL, samples integer NOT NULL
  );
  CREATE UNIQUE INDEX web_vital_daily_path_name_day_idx
    ON web_vital_daily (path, name, day);
  CREATE TABLE resource_performance (
    id bigserial PRIMARY KEY, at bigint NOT NULL,
    cache_hit boolean NOT NULL DEFAULT false,
    duration_ms double precision NOT NULL, environment varchar(40),
    initiator_type varchar(40) NOT NULL, page varchar(512) NOT NULL,
    protocol varchar(20), release varchar(160), target varchar(512) NOT NULL,
    transfer_size bigint NOT NULL DEFAULT 0
  );
  CREATE TABLE route_latency_windows (
    id bigserial PRIMARY KEY, count integer NOT NULL DEFAULT 0,
    error_count integer NOT NULL DEFAULT 0,
    max_ms double precision NOT NULL DEFAULT 0, method varchar(10) NOT NULL,
    release varchar(160), route varchar(256) NOT NULL,
    sum_ms double precision NOT NULL DEFAULT 0, window_start timestamp NOT NULL
  );
  CREATE UNIQUE INDEX route_latency_route_method_window_idx
    ON route_latency_windows (route, method, window_start);
  CREATE TABLE perf_issues (
    fingerprint varchar(128) PRIMARY KEY, acknowledged_at timestamp,
    acknowledged_by varchar(255), fixed_at timestamp, fixed_by varchar(255),
    kind varchar(40) NOT NULL, note text, subject varchar(512) NOT NULL,
    updated_at timestamp NOT NULL DEFAULT now()
  );
`;

let db: ReturnType<typeof drizzle>;

beforeEach(async () => {
  const client = new PGlite();
  await client.exec(SCHEMA);
  db = drizzle({ client });
});

describe("routeShape", () => {
  test("collapses the arguments and keeps the endpoint", () => {
    expect(
      routeShape("/admin/support/75942bbb-1f2e-4c3d-9a8b-0c1d2e3f4a5b"),
    ).toBe("/admin/support/:id");
    expect(routeShape("/orders/1042/items")).toBe("/orders/:id/items");
    expect(routeShape("/checkout/cs_test_a1B2c3D4")).toBe("/checkout/:id");
    expect(routeShape("/")).toBe("/");
    expect(routeShape("/about")).toBe("/about");
  });

  test("takes application-specific id shapes", () => {
    expect(
      routeShape("/quote/QT-88-XZ", { idPatterns: [/^QT-\d+-[A-Z]+$/u] }),
    ).toBe("/quote/:id");
  });
});

describe("route timing collector", () => {
  test("aggregates in memory, then sums into the window on flush", async () => {
    const collector = createRouteTimingCollector();
    collector.record({
      durationMs: 100,
      method: "GET",
      pathname: "/orders/1",
      status: 200,
    });
    collector.record({
      durationMs: 300,
      method: "GET",
      pathname: "/orders/2",
      status: 500,
    });
    expect(collector.pending()).toBe(1);
    expect(await collector.flush(db)).toEqual({ flushed: 1 });

    // A second flush in the same minute must add to the first, not replace it —
    // otherwise a second process, or a drain on shutdown, silently discards
    // everything already written for that window.
    collector.record({
      durationMs: 500,
      method: "GET",
      pathname: "/orders/3",
      status: 200,
    });
    await collector.flush(db);

    const [row] = await db.select().from(routeLatencyWindows);
    expect(row?.count).toBe(3);
    expect(row?.error_count).toBe(1);
    expect(row?.sum_ms).toBe(900);
    expect(row?.max_ms).toBe(500);
    expect(row?.route).toBe("/orders/:id");
  });

  test("flushing nothing writes nothing", async () => {
    const collector = createRouteTimingCollector();
    expect(await collector.flush(db)).toEqual({ flushed: 0 });
    expect(await db.select().from(routeLatencyWindows)).toHaveLength(0);
  });

  test("stops tracking rather than growing without bound", () => {
    const collector = createRouteTimingCollector({ maxTrackedRoutes: 2 });
    for (const path of ["/a", "/b", "/c", "/d"])
      collector.record({
        durationMs: 1,
        method: "GET",
        pathname: path,
        status: 200,
      });
    expect(collector.pending()).toBe(2);
  });
});

describe("route timing shutdown", () => {
  test("start does not take over the process's response to a signal", async () => {
    const before = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };
    const stop = createRouteTimingCollector().start(db);
    try {
      // Registering a signal listener REPLACES the default terminate
      // behaviour: unless the handler exits, the process survives the signal.
      // A library that does that quietly turns every kill, orchestrator stop
      // and build step that signals the app into a hang.
      expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
      expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    } finally {
      stop();
    }
  });
});

describe("route reads", () => {
  const flushOne = async (
    route: string,
    calls: { durationMs: number; status?: number }[],
  ) => {
    const collector = createRouteTimingCollector();
    for (const call of calls)
      collector.record({
        durationMs: call.durationMs,
        method: "GET",
        pathname: route,
        status: call.status ?? 200,
      });
    await collector.flush(db);
  };

  test("reports mean and max together, and orders by total cost", async () => {
    await flushOne("/slow", [{ durationMs: 4000 }]);
    await flushOne(
      "/busy",
      Array.from({ length: 50 }, () => ({ durationMs: 200 })),
    );
    const rows = await routeLatency(db);

    // /busy costs 10s in total against /slow's 4s: the biggest number here is
    // what to fix first, not the slowest single call.
    expect(rows[0]?.route).toBe("/busy");
    expect(rows[0]?.meanMs).toBe(200);
    expect(rows[1]?.route).toBe("/slow");
    expect(rows[1]?.maxMs).toBe(4000);
  });

  test("an error rate is calls, not windows", async () => {
    await flushOne("/api", [
      { durationMs: 10 },
      { durationMs: 10 },
      { durationMs: 10, status: 500 },
      { durationMs: 10 },
    ]);
    const [row] = await routeLatency(db);

    expect(row?.errors).toBe(1);
    expect(row?.errorRate).toBeCloseTo(0.25, 5);
  });

  test("a trend buckets by hour", async () => {
    await flushOne("/api", [{ durationMs: 100 }, { durationMs: 300 }]);
    const trend = await routeTrend(db, "/api");

    expect(trend).toHaveLength(1);
    expect(trend[0]?.calls).toBe(2);
    expect(trend[0]?.meanMs).toBe(200);
  });
});

describe("web vitals", () => {
  test("scores against the published thresholds", () => {
    expect(ratingFor("LCP", 2000)).toBe("good");
    expect(ratingFor("LCP", 2500)).toBe("good");
    expect(ratingFor("LCP", 3000)).toBe("needs-improvement");
    expect(ratingFor("LCP", 5000)).toBe("poor");
    expect(ratingFor("CLS", 0.05)).toBe("good");
    // An unknown metric is not evidence of a problem.
    expect(ratingFor("XYZ", 99_999)).toBe("good");
  });

  test("an ingested sample without a rating is scored on the way in", async () => {
    await recordWebVital(db, { name: "LCP", path: "/", value: 6000 });
    const [cell] = await webVitalMatrix(db);

    expect(cell?.poorRate).toBe(1);
    expect(cell?.over).toBe(true);
    expect(cell?.budget).toBe(2500);
  });

  test("the matrix is p75, not an average", async () => {
    // Three fast samples and one very slow one: a mean would call this bad.
    for (const value of [100, 100, 100, 10_000])
      await recordWebVital(db, { name: "LCP", path: "/shop", value });
    const [cell] = await webVitalMatrix(db);

    expect(cell?.p75).toBeLessThan(3000);
    expect(cell?.samples).toBe(4);
  });

  test("the rollup is idempotent and feeds the trend", async () => {
    for (const value of [1000, 2000, 3000, 9000])
      await recordWebVital(db, { name: "LCP", path: "/", value });
    expect((await rollUpWebVitals(db)).rolled).toBe(1);
    // Running it again recomputes the same day rather than doubling it.
    expect((await rollUpWebVitals(db)).rolled).toBe(1);

    const trend = await webVitalTrend(db, "LCP", "/");
    expect(trend).toHaveLength(1);
    expect(trend[0]?.samples).toBe(4);
    expect(Number(trend[0]?.poorRate)).toBeCloseTo(0.25, 5);
  });

  test("nothing to roll up is not an error", async () => {
    expect(await rollUpWebVitals(db)).toEqual({ rolled: 0 });
  });
});

describe("resources", () => {
  test("groups by asset and reports the cache rate", async () => {
    await recordResourceTimings(db, [
      {
        cacheHit: false,
        durationMs: 400,
        initiatorType: "script",
        page: "/",
        target: "/app.js",
        transferSize: 90_000,
      },
      {
        cacheHit: true,
        durationMs: 20,
        initiatorType: "script",
        page: "/shop",
        target: "/app.js",
        transferSize: 0,
      },
    ]);
    const [row] = await resourceTimings(db);

    expect(row?.target).toBe("/app.js");
    expect(row?.loads).toBe(2);
    expect(row?.cacheRate).toBe(0.5);
    expect(row?.slowestMs).toBe(400);
    expect(row?.meanMs).toBe(210);
  });

  test("an empty batch writes nothing", async () => {
    expect(await recordResourceTimings(db, [])).toEqual({ recorded: 0 });
  });
});

describe("databaseHealth", () => {
  test("survives a database without pg_stat_statements", async () => {
    const health = await databaseHealth(db);

    // The extension is not installed here, which is exactly the managed-provider
    // case: the page must still render the other three sections.
    expect(health.statementStatsEnabled).toBe(false);
    expect(health.slowQueries).toEqual([]);
    expect(Array.isArray(health.tableScans)).toBe(true);
    expect(Array.isArray(health.unusedIndexes)).toBe(true);
  });
});

describe("problems", () => {
  const slowRoute = async () => {
    const collector = createRouteTimingCollector();
    for (let index = 0; index < 30; index += 1)
      collector.record({
        durationMs: 900,
        method: "GET",
        pathname: "/slow",
        status: 200,
      });
    await collector.flush(db);
  };

  test("derives findings from every measurement and sorts by severity", async () => {
    await slowRoute();
    for (let index = 0; index < 6; index += 1)
      await recordWebVital(db, { name: "LCP", path: "/", value: 9000 });
    await recordResourceTimings(db, [
      {
        durationMs: 4000,
        initiatorType: "img",
        page: "/",
        target: "/hero.png",
        transferSize: 2_000_000,
      },
    ]);
    const problems = await performanceProblems(db);
    const kinds = problems.map((problem) => problem.kind);

    expect(kinds).toContain("vital");
    expect(kinds).toContain("route");
    expect(kinds).toContain("resource");
    expect(problems[0]?.severity).toBe("high");
  });

  test("a route with too few calls is not judged on its average", async () => {
    const collector = createRouteTimingCollector();
    collector.record({
      durationMs: 5000,
      method: "GET",
      pathname: "/rare",
      status: 200,
    });
    await collector.flush(db);

    expect(await performanceProblems(db)).toHaveLength(0);
  });

  test("thresholds are the caller's to set", async () => {
    await slowRoute();
    expect(
      await performanceProblems(db, 7, { slowRouteMeanMs: 2000 }),
    ).toHaveLength(0);
  });

  test("an acknowledged finding stays on the list, marked", async () => {
    await slowRoute();
    const [before] = await performanceProblems(db);
    expect(before?.acknowledgedAt).toBeNull();

    await setPerfDecision(db, {
      by: "alex",
      fingerprint: before!.fingerprint,
      kind: before!.kind,
      note: "third-party call, known",
      state: "acknowledged",
      subject: before!.subject,
    });
    const [after] = await performanceProblems(db);
    expect(after?.acknowledgedBy).toBe("alex");
    expect(after?.note).toBe("third-party call, known");

    // Reopening removes the decision entirely rather than leaving a tombstone
    // that would keep the finding looking handled.
    await setPerfDecision(db, {
      by: "alex",
      fingerprint: before!.fingerprint,
      kind: before!.kind,
      state: "open",
      subject: before!.subject,
    });
    expect((await performanceProblems(db))[0]?.acknowledgedAt).toBeNull();
  });
});

describe("overview", () => {
  test("reports the headline numbers across all four", async () => {
    const collector = createRouteTimingCollector();
    collector.record({
      durationMs: 100,
      method: "GET",
      pathname: "/",
      status: 200,
    });
    collector.record({
      durationMs: 300,
      method: "GET",
      pathname: "/x",
      status: 500,
    });
    await collector.flush(db);
    await recordWebVital(db, { name: "LCP", path: "/", value: 1000 });
    await recordResourceTimings(db, [
      {
        durationMs: 10,
        initiatorType: "css",
        page: "/",
        target: "/a.css",
      },
    ]);
    const overview = await performanceOverview(db);

    expect(overview.routes.calls).toBe(2);
    expect(overview.routes.meanMs).toBe(200);
    expect(overview.routes.errorRate).toBe(0.5);
    expect(overview.resourceSamples).toBe(1);
    expect(overview.vitals[0]).toMatchObject({ name: "LCP", over: false });
  });

  test("an empty database reports zeroes rather than throwing", async () => {
    const overview = await performanceOverview(db);

    expect(overview.routes).toEqual({ calls: 0, errorRate: 0, meanMs: 0 });
    expect(overview.vitals).toEqual([]);
  });
});
