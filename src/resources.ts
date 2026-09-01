/**
 * Static asset timing.
 *
 * Everything is sampled rather than only what crossed a threshold. A threshold
 * can tell you a file was slow; it can never tell you a file was slow
 * *relative to everything else*, or that a fast file loaded on every page is
 * the one worth caching.
 */
import { avg, desc, gte, sql } from "drizzle-orm";
import type { AnyPgDatabase } from "./database";
import { resourcePerformance } from "./drizzle";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 7;
const MAX_ROWS = 50;
const INITIATOR_MAX = 40;
const URL_MAX = 512;
const PROTOCOL_MAX = 20;

export type ResourceTimingInput = {
  at?: number;
  cacheHit?: boolean;
  durationMs: number;
  environment?: string;
  initiatorType: string;
  page: string;
  protocol?: string;
  release?: string;
  target: string;
  transferSize?: number;
};

export const recordResourceTimings = async (
  db: AnyPgDatabase,
  inputs: readonly ResourceTimingInput[],
) => {
  if (inputs.length === 0) return { recorded: 0 };
  await db.insert(resourcePerformance).values(
    inputs.map((input) => ({
      at: input.at ?? Date.now(),
      cache_hit: input.cacheHit ?? false,
      duration_ms: input.durationMs,
      environment: input.environment ?? null,
      initiator_type: input.initiatorType.slice(0, INITIATOR_MAX),
      page: input.page.slice(0, URL_MAX),
      protocol: input.protocol?.slice(0, PROTOCOL_MAX) ?? null,
      release: input.release ?? null,
      target: input.target.slice(0, URL_MAX),
      transfer_size: Math.round(input.transferSize ?? 0),
    })),
  );

  return { recorded: inputs.length };
};

export type ResourceRow = {
  bytes: number;
  /** A low cache rate on an asset loaded on every page is free speed left on
   *  the table. */
  cacheRate: number;
  initiator: string;
  loads: number;
  meanMs: number;
  slowestMs: number;
  target: string;
};

export const resourceTimings = async (
  db: AnyPgDatabase,
  days = DEFAULT_DAYS,
): Promise<ResourceRow[]> => {
  const since = Date.now() - days * DAY_MS;
  const rows = await db
    .select({
      bytes: sql<number>`avg(${resourcePerformance.transfer_size})`,
      cached: sql<number>`sum(case when ${resourcePerformance.cache_hit} then 1 else 0 end)::int`,
      initiator: resourcePerformance.initiator_type,
      loads: sql<number>`count(*)::int`,
      meanMs: avg(resourcePerformance.duration_ms),
      slowestMs: sql<number>`max(${resourcePerformance.duration_ms})`,
      target: resourcePerformance.target,
    })
    .from(resourcePerformance)
    .where(gte(resourcePerformance.at, since))
    .groupBy(resourcePerformance.target, resourcePerformance.initiator_type)
    .orderBy(desc(sql`avg(${resourcePerformance.duration_ms})`))
    .limit(MAX_ROWS);

  return rows.map((row) => {
    const loads = Number(row.loads);

    return {
      bytes: Math.round(Number(row.bytes ?? 0)),
      cacheRate: loads > 0 ? Number(row.cached) / loads : 0,
      initiator: row.initiator,
      loads,
      meanMs: Number(row.meanMs ?? 0),
      slowestMs: Number(row.slowestMs),
      target: row.target,
    };
  });
};
