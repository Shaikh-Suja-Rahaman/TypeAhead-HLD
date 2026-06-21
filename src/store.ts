import { SQL } from "bun";
import { MAX_QUERY_PREFIX, HISTORICAL_WEIGHT, RECENT_ACTIVITY_WEIGHT } from "./settings";

export const PG_CONN_STR =
  process.env.DATABASE_URL ?? "postgres://typeahead:typeahead@localhost:5432/typeahead";

export const pgClient = new SQL(PG_CONN_STR, { max: Number(process.env.PG_POOL_MAX ?? 10) });

export interface FrequencyRow {
  query: string;
  count: string;
}

const HW = Number.isFinite(HISTORICAL_WEIGHT) ? HISTORICAL_WEIGHT : 1;
const RW = Number.isFinite(RECENT_ACTIVITY_WEIGHT) ? RECENT_ACTIVITY_WEIGHT : 3;
export const BLENDED_SCORE_EXPR = `(${HW} * log(2.0, (1 + count)::numeric) + ${RW} * log(2.0, (1 + recent_count)::numeric))`;

export async function initDbSchema(c: SQL = pgClient): Promise<void> {
  await c`
    CREATE TABLE IF NOT EXISTS query_counts (
      query        TEXT PRIMARY KEY,
      count        BIGINT NOT NULL,
      recent_count BIGINT NOT NULL DEFAULT 0
    );
    ALTER TABLE query_counts ADD COLUMN IF NOT EXISTS recent_count BIGINT NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS query_counts_query_pattern_idx
      ON query_counts (query text_pattern_ops);
    CREATE TABLE IF NOT EXISTS dirty_prefixes (
      prefix   TEXT PRIMARY KEY,
      dirty_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.simple();
}

export function sanitizeLikePattern(str: string): string {
  return str.replace(/[\\%_]/g, (ch) => "\\" + ch);
}

export async function commitCountsAndMarkDirty(
  freqs: Map<string, number>,
  prefixSet: Set<string>,
): Promise<void> {
  if (freqs.size === 0) return;
  const countData = [...freqs].map(([query, count]) => ({ query, count, recent_count: count }));
  const dirtyData = [...prefixSet].map((prefix) => ({ prefix }));

  await pgClient.begin(async (t) => {
    await t`
      INSERT INTO query_counts ${t(countData, "query", "count", "recent_count")}
      ON CONFLICT (query) DO UPDATE
        SET count = query_counts.count + EXCLUDED.count,
            recent_count = query_counts.recent_count + EXCLUDED.recent_count
    `;
    if (dirtyData.length > 0) {
      await t`
        INSERT INTO dirty_prefixes ${t(dirtyData, "prefix")}
        ON CONFLICT (prefix) DO UPDATE SET dirty_at = now()
      `;
    }
  });
}

export async function flagDirty(prefixList: string[], c: SQL = pgClient): Promise<void> {
  if (prefixList.length === 0) return;
  const items = prefixList.map((prefix) => ({ prefix }));
  await c`
    INSERT INTO dirty_prefixes ${c(items, "prefix")}
    ON CONFLICT (prefix) DO UPDATE SET dirty_at = now()
  `;
}

export async function getTopSuggestionsForPrefix(
  p: string,
  limit: number,
  c: SQL = pgClient,
): Promise<FrequencyRow[]> {
  return (await c`
    SELECT query, count FROM query_counts
    WHERE query LIKE ${sanitizeLikePattern(p) + "%"} ESCAPE ${"\\"}
    ORDER BY count DESC, query ASC
    LIMIT ${limit}
  `) as FrequencyRow[];
}

export async function getTopSuggestionsBlended(
  p: string,
  limit: number,
  c: SQL = pgClient,
): Promise<FrequencyRow[]> {
  return (await c.unsafe(
    `SELECT query, round(${BLENDED_SCORE_EXPR}, 6)::float8 AS count
       FROM query_counts
      WHERE query LIKE $1 ESCAPE '\\'
      ORDER BY ${BLENDED_SCORE_EXPR} DESC, query ASC
      LIMIT $2`,
    [sanitizeLikePattern(p) + "%", limit],
  )) as FrequencyRow[];
}

export async function applyRecentActivityDecay(
  decayMultiplier: number,
  c: SQL = pgClient,
): Promise<string[]> {
  const res = (await c.unsafe(
    `UPDATE query_counts
        SET recent_count = floor(recent_count * $1)
      WHERE recent_count > 0
      RETURNING query`,
    [decayMultiplier],
  )) as { query: string }[];
  return res.map((r) => r.query);
}

export interface ProcessedRow extends FrequencyRow {
  prefix: string;
  recency_score: number;
}

export async function* computeColdStartCache(
  limit: number,
  c: SQL = pgClient,
): AsyncGenerator<ProcessedRow[]> {
  for (let l = 1; l <= MAX_QUERY_PREFIX; l++) {
    const chunk = (await c.unsafe(
      `WITH expanded AS (
         SELECT query, count, recent_count, left(query, $1) AS prefix
         FROM query_counts
         WHERE length(query) >= $1
       ), ranked AS (
         SELECT prefix, query, count, recent_count,
                row_number() OVER (PARTITION BY prefix ORDER BY count DESC, query ASC) AS rn
         FROM expanded
       )
       SELECT prefix, query, count,
              round(${BLENDED_SCORE_EXPR}, 6)::float8 AS recency_score
       FROM ranked WHERE rn <= $2`,
      [l, limit],
    )) as ProcessedRow[];
    if (chunk.length > 0) yield chunk;
  }
}

export async function ingestRawCounts(
  data: { query: string; count: number }[],
  c: SQL = pgClient,
): Promise<void> {
  if (data.length === 0) return;
  await c`
    INSERT INTO query_counts ${c(data, "query", "count")}
    ON CONFLICT (query) DO UPDATE
      SET count = query_counts.count + EXCLUDED.count
  `;
}
