/**
 * Global Configuration & Utilities
 */

import { PARTITIONS, type PartitionId } from "./router";

export const FLUSH_THRESHOLD = Number(process.env.BATCH_SIZE ?? 100);
export const MAX_BUFFER_AGE_MS = Number(process.env.FLUSH_INTERVAL_MS ?? 5000);

export const AUTOCOMPLETE_MAX_RESULTS = Number(process.env.SUGGEST_LIMIT ?? 10);
export const MAX_TRENDING = Number(process.env.TRENDING_LIMIT ?? 10);
export const ZSET_DEPTH = Number(process.env.CACHE_K ?? 50);
export const MAX_QUERY_PREFIX = Number(process.env.MAX_PREFIX_LEN ?? 32);

export const DECAY_MULTIPLIER = Number(process.env.DECAY_FACTOR ?? 0.9);
export const DECAY_CRON_MS = Number(
  process.env.DECAY_INTERVAL_MS ?? 24 * 60 * 60 * 1000,
);

export const HISTORICAL_WEIGHT = Number(process.env.RECENCY_HIST_WEIGHT ?? 1);
export const RECENT_ACTIVITY_WEIGHT = Number(process.env.RECENCY_WEIGHT ?? 3);
export const RECENT_DECAY_MULTIPLIER = Number(process.env.RECENCY_DECAY_FACTOR ?? 0.5);
export const RECENT_DECAY_CRON_MS = Number(
  process.env.RECENCY_DECAY_INTERVAL_MS ?? 60 * 60 * 1000,
);

export const SUGGEST_PREFIX = "q:";
export const RECENCY_PREFIX = "qr:";
export const TRENDING_SET_KEY = "trending";

export function formatQuery(input: string): string {
  return input.trim().toLowerCase();
}

export function generatePrefixes(q: string): string[] {
  const limit = Math.min(q.length, MAX_QUERY_PREFIX);
  const result: string[] = new Array(limit);
  for (let idx = 1; idx <= limit; idx++) result[idx - 1] = q.slice(0, idx);
  return result;
}

export function getSuggestKey(p: string): string {
  return SUGGEST_PREFIX + p;
}

export function getRecencyKey(p: string): string {
  return RECENCY_PREFIX + p;
}

export type SortMode = "basic" | "recency";

export function parseSortMode(val: string | null): SortMode {
  return val === "recency" ? "recency" : "basic";
}

export function getRedisConnStr(part: PartitionId): string {
  const envVar = process.env[`REDIS_URL_${part}`];
  if (envVar) return envVar;
  return `redis://localhost:6379/${Number(part) - 1}`;
}

export function getAppHost(part: PartitionId): string {
  return process.env[`APP_URL_${part}`] ?? `http://localhost:${3000 + Number(part)}`;
}

export { PARTITIONS, type PartitionId };
