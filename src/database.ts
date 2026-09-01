/**
 * Database health, read from Postgres' own statistics.
 *
 * No application-side query wrapping and no instrumentation on the hot path:
 * these views are already being maintained, so this costs nothing at all until
 * somebody opens the page.
 */
import { sql } from "drizzle-orm";
import type { PgAsyncDatabase } from "drizzle-orm/pg-core";

export type AnyPgDatabase = PgAsyncDatabase<any, any>;

const SLOW_QUERY_LIMIT = 25;
const QUERY_TEXT_MAX = 200;
const TABLE_SCAN_LIMIT = 15;
const UNUSED_INDEX_LIMIT = 20;
const BUSY_TABLE_ROWS = 1000;

export type ConnectionState = {
  count: number;
  longestSec: number | null;
  state: string;
};

export type SlowQuery = {
  calls: number;
  maxMs: number;
  meanMs: number;
  query: string;
  queryid: string;
  totalMs: number;
};

export type TableScan = {
  idxScan: number;
  liveRows: number;
  relname: string;
  seqScan: number;
  seqTupRead: number;
};

export type UnusedIndex = {
  indexrelname: string;
  relname: string;
  scans: number;
};

export type DatabaseHealth = {
  connections: ConnectionState[];
  slowQueries: SlowQuery[];
  /** False when `pg_stat_statements` is not installed — the slow-query list is
   *  empty because nothing is recording, not because nothing is slow. */
  statementStatsEnabled: boolean;
  tableScans: TableScan[];
  unusedIndexes: UnusedIndex[];
};

/** Drivers disagree about whether `execute` returns rows or `{ rows }`. */
const rowsOf = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  const { rows } = result as { rows?: unknown };

  return Array.isArray(rows) ? (rows as T[]) : [];
};

/**
 * Each read is independently guarded.
 *
 * `pg_stat_statements` is an extension a managed provider may not have enabled,
 * and the `pg_stat_user_*` views can be restricted by role. One unavailable
 * view must not blank the whole page — the other three still answer.
 */
const readRows = <T>(db: AnyPgDatabase, statement: ReturnType<typeof sql>) =>
  db
    .execute(statement)
    .then((result) => rowsOf<T>(result))
    .catch(() => [] as T[]);

/**
 * Where server time goes.
 *
 * Slow queries are ordered by mean time, but `mean × calls` is reported too:
 * that column is what exposes an N+1, where a 2ms query called forty thousand
 * times is the actual problem and no single call looks slow.
 */
export const databaseHealth = async (
  db: AnyPgDatabase,
): Promise<DatabaseHealth> => {
  const connections = await readRows<ConnectionState>(
    db,
    sql`
      select coalesce(state, 'unknown') as state,
        count(*)::int as count,
        max(extract(epoch from (now() - query_start)))::int as "longestSec"
      from pg_stat_activity
      where datname = current_database()
      group by state
      order by count desc
    `,
  );

  const slowQueries = await readRows<SlowQuery>(
    db,
    sql`
      select queryid::text as queryid,
        calls::int as calls,
        round(mean_exec_time::numeric, 1)::float8 as "meanMs",
        round(max_exec_time::numeric, 1)::float8 as "maxMs",
        round(total_exec_time::numeric, 1)::float8 as "totalMs",
        left(query, ${QUERY_TEXT_MAX}) as query
      from pg_stat_statements
      where query not ilike '%pg_stat_statements%'
      order by mean_exec_time desc
      limit ${SLOW_QUERY_LIMIT}
    `,
  );

  // A big table read sequentially, over and over, is a missing index.
  const tableScans = await readRows<TableScan>(
    db,
    sql`
      select relname,
        seq_scan::int as "seqScan",
        seq_tup_read::int as "seqTupRead",
        coalesce(idx_scan, 0)::int as "idxScan",
        n_live_tup::int as "liveRows"
      from pg_stat_user_tables
      where seq_scan > 0 and n_live_tup > ${BUSY_TABLE_ROWS}
      order by seq_tup_read desc
      limit ${TABLE_SCAN_LIMIT}
    `,
  );

  // An index nothing reads still costs a write on every insert.
  const unusedIndexes = await readRows<UnusedIndex>(
    db,
    sql`
      select relname, indexrelname, idx_scan::int as scans
      from pg_stat_user_indexes
      where idx_scan = 0
      order by relname
      limit ${UNUSED_INDEX_LIMIT}
    `,
  );

  return {
    connections,
    slowQueries,
    statementStatsEnabled: slowQueries.length > 0,
    tableScans,
    unusedIndexes,
  };
};
