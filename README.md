# @absolutejs/performance

Core Web Vitals, server route latency, static asset timing and Postgres health
— the four measurements behind a performance console, Drizzle-native.

Four measurements of one question: **is this fast enough to use?** Vitals are
what a person's browser felt, resources are what the page had to download,
routes are what the server took, and the database numbers are where server time
usually goes. They stay separate because the fix for each is different.

## Install

```bash
bun add @absolutejs/performance
```

Peer: `drizzle-orm` >= 1.0.0-rc.4. Postgres.

## Schema

Five tables, exported as Drizzle definitions — register them in your own schema
so your migrations own them:

```ts
export {
  webVitals,
  webVitalDaily,
  resourcePerformance,
  routeLatencyWindows,
  perfIssues,
} from "@absolutejs/performance";
```

The database section additionally reads `pg_stat_activity`,
`pg_stat_user_tables`, `pg_stat_user_indexes`, and — if the extension is
installed — `pg_stat_statements`. Each read is guarded independently, so a
managed provider without the extension loses the slow-query list and keeps the
rest.

## Server route latency

Every response is timed and folded into a per-route counter. A row per request
would put a database write in the path of every request — making the thing being
measured slower — and leave millions of rows to scan; a counter per route per
minute costs one upsert per flush and answers the same questions.

```ts
const timings = createRouteTimingCollector();
timings.start(db, releaseSha); // periodic flush + drain on SIGTERM/SIGINT

app.request(({ request }) => start.set(request, performance.now()));
app.afterResponse(({ request, response }) => {
  timings.record({
    durationMs: performance.now() - start.get(request)!,
    method: request.method,
    pathname: new URL(request.url).pathname,
    status: response.status,
  });
});
```

`routeShape` collapses ids so `/orders/1042` and `/orders/1043` are one route
rather than two — UUIDs, long hex, numeric segments and prefixed object ids
(`cs_test_…`) out of the box, plus any `idPatterns` you pass.

The flush drains on `SIGTERM`, `SIGINT` and `beforeExit`. A deploy replaces the
process mid-window, and without that drain the last half-minute of traffic is
lost on every release — exactly the window a deploy most wants to compare.

## Web Vitals

```ts
await recordWebVital(db, { name: "LCP", path: "/", value: 2100 });
await rollUpWebVitals(db); // daily p50/p75/p95, idempotent
await webVitalMatrix(db, 7); // every page × metric, scored
await webVitalTrend(db, "LCP", "/"); // the series behind one cell
```

Budgets are Google's published thresholds — the numbers search ranking is scored
against, so they are not yours to invent. `ratingFor` scores a value the same
way the browser does, which is what makes a backfilled or synthetic sample
comparable with a real one.

p75 is the headline because that is what Core Web Vitals is judged on; p50 and
p95 sit either side so a page whose median is fine but whose tail is bad is
visible as what it is.

## Static assets

```ts
// browser
startResourceTiming({ endpoint: "/ingest/resources", ignorePaths: ["/sync"] });
// server
await recordResourceTimings(db, body.resources);
await resourceTimings(db, 7);
```

Everything is sampled, not only what crossed a threshold: a threshold can say a
file was slow, but never that a fast file loaded on every page is the one worth
caching. `cacheRate` is that answer.

## The console

```ts
await performanceOverview(db, 7); // the headline numbers
await performanceProblems(db, 7); // everything over budget, one list
await setPerfDecision(db, {
  fingerprint,
  kind,
  subject,
  state: "acknowledged",
  by,
});
startPerformanceRollup(db); // keeps the daily table current
```

Findings are derived live rather than stored, so nothing on the list can be
stale — a page that got fixed stops appearing because it got fixed. The only
stored half is the human decision, joined on, so a known and accepted slow page
stops shouting without disappearing. `state: "open"` deletes the decision
outright rather than leaving a tombstone that would keep the finding looking
handled.

Thresholds are the caller's: `slowRouteMeanMs`, `slowResourceMs`,
`slowQueryMeanMs`, `errorRateLimit`, `poorRateLimit`, `minRouteCalls`,
`minVitalSamples`.

`startPerformanceRollup` exists because a console that is only correct when a
host crontab exists is a console that quietly goes stale — the one failure a
health dashboard cannot afford. The rollup is idempotent, so an endpoint your
scheduler also calls costs a duplicate scan and nothing else.

## Database health

```ts
const { connections, slowQueries, tableScans, unusedIndexes } =
  await databaseHealth(db);
```

Read from Postgres' own statistics: no query wrapping, nothing on the hot path,
zero cost until the page is opened. Slow queries are ordered by mean time, but
`mean × calls` is reported too — that column is what exposes an N+1, where a 2ms
query called forty thousand times is the actual problem and no single call looks
slow.

## License

BSL-1.1 with a named carveout against hosted APM/RUM services (Datadog APM, New
Relic, Dynatrace, Vercel Speed Insights, Sentry Performance, SpeedCurve,
pganalyze, and similar). Using it to measure your own applications — including
commercial ones — is expressly permitted. Converts to Apache 2.0 on
August 31, 2030. See `LICENSE`.
