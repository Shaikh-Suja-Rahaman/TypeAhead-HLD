/**
 * App Node (Stateless)
 * Manages queries, buffers writes, and syncs suggestions from database.
 */

import { RedisClient } from "bun";
import { getPartitionTarget } from "./router";
import {
  pgClient,
  commitCountsAndMarkDirty,
  getTopSuggestionsForPrefix,
  getTopSuggestionsBlended,
  flagDirty,
} from "./store";
import {
  FLUSH_THRESHOLD,
  MAX_BUFFER_AGE_MS,
  AUTOCOMPLETE_MAX_RESULTS,
  MAX_TRENDING,
  DECAY_MULTIPLIER,
  DECAY_CRON_MS,
  TRENDING_SET_KEY,
  formatQuery,
  generatePrefixes,
  getSuggestKey,
  getRecencyKey,
  parseSortMode,
  getRedisConnStr,
  type PartitionId,
} from "./settings";

const PARTITION_ID = (process.env.SHARD_ID ?? "1") as PartitionId;
const NODE_PORT = Number(process.env.PORT ?? 3000 + Number(PARTITION_ID));
const REDIS_CONNECTION = process.env.REDIS_URL ?? getRedisConnStr(PARTITION_ID);

const localRedis = new RedisClient(REDIS_CONNECTION);

const pendingQueries: string[] = [];
let processPendingPromise: Promise<void> | null = null;

const observabilityStats = {
  searchesReceived: 0,
  batchesFlushed: 0,
  rowsUpserted: 0,
  cacheHits: 0,
  cacheMisses: 0,
};

async function flushBatchToDB(batchPayload: string[]): Promise<void> {
  const aggregated = new Map<string, number>();
  for (const item of batchPayload) aggregated.set(item, (aggregated.get(item) ?? 0) + 1);

  const affectedPrefixes = new Set<string>();
  for (const q of aggregated.keys()) {
    for (const pref of generatePrefixes(q)) affectedPrefixes.add(pref);
  }

  const ops: Promise<unknown>[] = [];
  for (const [q, val] of aggregated) {
    ops.push(localRedis.send("ZINCRBY", [TRENDING_SET_KEY, String(val), q]));
  }
  await Promise.all(ops);

  await commitCountsAndMarkDirty(aggregated, affectedPrefixes);

  observabilityStats.batchesFlushed++;
  observabilityStats.rowsUpserted += aggregated.size;
  console.log(
    `[partition-${PARTITION_ID}] committed ${batchPayload.length} operations ` +
      `(${aggregated.size} unique keys, ${affectedPrefixes.size} dirty markers) ` +
      `[flush index: ${observabilityStats.batchesFlushed}]`,
  );
}

async function processPendingBuffer(): Promise<void> {
  while (pendingQueries.length > 0) {
    const chunk = pendingQueries.splice(0, FLUSH_THRESHOLD);
    try {
      await flushBatchToDB(chunk);
    } catch (e) {
      console.error(`[partition-${PARTITION_ID}] commit failed, retrying chunk:`, e);
      pendingQueries.unshift(...chunk);
      return;
    }
  }
}

function triggerFlush(): Promise<void> {
  if (!processPendingPromise) processPendingPromise = processPendingBuffer().finally(() => (processPendingPromise = null));
  return processPendingPromise;
}

setInterval(() => {
  if (pendingQueries.length > 0) void triggerFlush();
}, MAX_BUFFER_AGE_MS);

const APPLY_DECAY_LUA = `
local k = KEYS[1]
local f = tonumber(ARGV[1])
local zdata = redis.call('ZRANGE', k, 0, -1, 'WITHSCORES')
for idx = 1, #zdata, 2 do
  redis.call('ZADD', k, tonumber(zdata[idx + 1]) * f, zdata[idx])
end
return #zdata / 2
`;

async function applyDecayFactor(): Promise<void> {
  try {
    const totalProcessed = await localRedis.send("EVAL", [
      APPLY_DECAY_LUA,
      "1",
      TRENDING_SET_KEY,
      String(DECAY_MULTIPLIER),
    ]);
    console.log(`[partition-${PARTITION_ID}] decay ${DECAY_MULTIPLIER}x applied to ${totalProcessed} trending keys`);
  } catch (err) {
    console.error(`[partition-${PARTITION_ID}] decay operation failed:`, err);
  }
}

setInterval(() => void applyDecayFactor(), DECAY_CRON_MS);

const SYNC_CACHE_LUA = `
redis.call('DEL', KEYS[1])
for idx = 1, #ARGV, 2 do
  redis.call('ZADD', KEYS[1], ARGV[idx], ARGV[idx + 1])
end
return 1
`;

interface ScoreRow {
  query: string;
  count: string | number;
}

interface CacheSyncData {
  prefix: string;
  topK: ScoreRow[];
  topKRecency?: ScoreRow[];
}

function serializeToLuaArgv(records: ScoreRow[]): string[] {
  const arr: string[] = [];
  for (const { query, count } of records) arr.push(String(count), query);
  return arr;
}

async function executeCacheSync(
  syncs: CacheSyncData[],
): Promise<{ success: number; skipped: number }> {
  const operations: Promise<unknown>[] = [];
  let successCount = 0;
  let skipCount = 0;
  
  for (const { prefix, topK, topKRecency } of syncs) {
    if (getPartitionTarget(prefix) !== PARTITION_ID) {
      skipCount++;
      continue;
    }
    operations.push(
      localRedis.send("EVAL", [SYNC_CACHE_LUA, "1", getSuggestKey(prefix), ...serializeToLuaArgv(topK)]),
    );
    if (topKRecency) {
      operations.push(
        localRedis.send("EVAL", [SYNC_CACHE_LUA, "1", getRecencyKey(prefix), ...serializeToLuaArgv(topKRecency)]),
      );
    }
    successCount++;
  }
  await Promise.all(operations);
  return { success: successCount, skipped: skipCount };
}

const sendJson = (obj: unknown, code = 200) =>
  Response.json(obj, { status: code, headers: { "access-control-allow-origin": "*" } });

function extractLimit(val: string | null, fallback: number): number {
  const num = Number(val);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function processZsetResp(data: unknown): { query: string; score: number }[] {
  if (!Array.isArray(data)) return [];
  if (data.length > 0 && Array.isArray(data[0])) {
    return (data as [string, number][]).map(([query, score]) => ({
      query,
      score: Number(score),
    }));
  }
  const parsed: { query: string; score: number }[] = [];
  for (let idx = 0; idx < data.length; idx += 2) {
    parsed.push({ query: String(data[idx]), score: Number(data[idx + 1]) });
  }
  return parsed;
}

const nodeServer = Bun.serve({
  port: NODE_PORT,
  async fetch(req) {
    const parsedUrl = new URL(req.url);

    if (req.method === "GET" && parsedUrl.pathname === "/suggest") {
      const searchPrefix = formatQuery(parsedUrl.searchParams.get("q") ?? "");
      if (!searchPrefix) return sendJson({ prefix: "", suggestions: [], source: "cache" });

      const maxLimit = extractLimit(parsedUrl.searchParams.get("limit"), AUTOCOMPLETE_MAX_RESULTS);
      const sortingMode = parseSortMode(parsedUrl.searchParams.get("rank"));
      const targetKey = sortingMode === "recency" ? getRecencyKey(searchPrefix) : getSuggestKey(searchPrefix);

      let dataPoints = (await localRedis.send("ZREVRANGE", [
        targetKey,
        "0",
        String(maxLimit - 1),
      ])) as string[];
      let dataOrigin = "cache";

      if (dataPoints.length === 0) {
        observabilityStats.cacheMisses++;
        const pgRows =
          sortingMode === "recency"
            ? await getTopSuggestionsBlended(searchPrefix, maxLimit)
            : await getTopSuggestionsForPrefix(searchPrefix, maxLimit);
        dataPoints = pgRows.map((row) => row.query);
        dataOrigin = "db";
        if (dataPoints.length > 0) flagDirty([searchPrefix]).catch(() => {});
      } else {
        observabilityStats.cacheHits++;
      }

      return sendJson({ shard: PARTITION_ID, prefix: searchPrefix, rank: sortingMode, source: dataOrigin, suggestions: dataPoints });
    }

    if (req.method === "POST" && parsedUrl.pathname === "/search") {
      let searchQuery = "";
      try {
        searchQuery = formatQuery(((await req.json()) as { query?: string }).query ?? "");
      } catch {
        return sendJson({ error: "bad json format" }, 400);
      }
      if (!searchQuery) return sendJson({ error: "no query provided" }, 400);

      observabilityStats.searchesReceived++;
      const currentBufSize = pendingQueries.push(searchQuery);
      if (currentBufSize >= FLUSH_THRESHOLD) void triggerFlush();

      return sendJson({ message: "Searched", query: searchQuery, buffered: currentBufSize }, 202);
    }

    if (req.method === "GET" && parsedUrl.pathname === "/trending") {
      const sizeLimit = extractLimit(parsedUrl.searchParams.get("limit"), MAX_TRENDING);
      const zsetRaw = await localRedis.send("ZREVRANGE", [
        TRENDING_SET_KEY,
        "0",
        String(sizeLimit - 1),
        "WITHSCORES",
      ]);
      return sendJson({ shard: PARTITION_ID, trending: processZsetResp(zsetRaw) });
    }

    if (req.method === "GET" && parsedUrl.pathname === "/cache/debug") {
      const searchPrefix = formatQuery(parsedUrl.searchParams.get("prefix") ?? "");
      if (!searchPrefix) return sendJson({ error: "no prefix provided" }, 400);

      const [basicRaw, recencyRaw] = await Promise.all([
        localRedis.send("ZCARD", [getSuggestKey(searchPrefix)]),
        localRedis.send("ZCARD", [getRecencyKey(searchPrefix)]),
      ]);
      const basicCount = Number(basicRaw);
      const recencyCount = Number(recencyRaw);
      return sendJson({
        prefix: searchPrefix,
        node: `app${PARTITION_ID}`,
        shard: PARTITION_ID,
        status: basicCount > 0 ? "hit" : "miss",
        cached: basicCount,
        recencyCached: recencyCount,
      });
    }

    if (req.method === "GET" && parsedUrl.pathname === "/metrics") {
      const overallReqs = observabilityStats.cacheHits + observabilityStats.cacheMisses;
      return sendJson({
        shard: PARTITION_ID,
        buffered: pendingQueries.length,
        searchesReceived: observabilityStats.searchesReceived,
        batchesFlushed: observabilityStats.batchesFlushed,
        rowsUpserted: observabilityStats.rowsUpserted,
        cacheHits: observabilityStats.cacheHits,
        cacheMisses: observabilityStats.cacheMisses,
        cacheHitRate: overallReqs > 0 ? observabilityStats.cacheHits / overallReqs : null,
        writeReduction:
          observabilityStats.batchesFlushed > 0
            ? observabilityStats.searchesReceived / observabilityStats.batchesFlushed
            : null,
      });
    }

    if (req.method === "POST" && parsedUrl.pathname === "/internal/cache") {
      let syncPayload: CacheSyncData[];
      try {
        syncPayload = ((await req.json()) as { updates?: CacheSyncData[] }).updates ?? [];
      } catch {
        return sendJson({ error: "bad format" }, 400);
      }
      const syncResult = await executeCacheSync(syncPayload);
      return sendJson({ shard: PARTITION_ID, ...syncResult });
    }

    if (req.method === "GET" && parsedUrl.pathname === "/health") {
      let cacheDbHealthy = true;
      let pgHealthy = true;
      try {
        await localRedis.send("PING", []);
      } catch {
        cacheDbHealthy = false;
      }
      try {
        await pgClient`SELECT 1`;
      } catch {
        pgHealthy = false;
      }
      return sendJson(
        {
          shard: PARTITION_ID,
          buffered: pendingQueries.length,
          redis: cacheDbHealthy ? "up" : "down",
          postgres: pgHealthy ? "up" : "down",
        },
        cacheDbHealthy ? 200 : 503,
      );
    }

    return sendJson({ error: "endpoint unavailable" }, 404);
  },
});

const handleTermination = async () => {
  console.log(`[partition-${PARTITION_ID}] node stopping, emptying queues...`);
  nodeServer.stop();
  if (processPendingPromise) await processPendingPromise;
  await triggerFlush();
  localRedis.close();
  await pgClient.close({ timeout: 5 });
  process.exit(0);
};

process.on("SIGTERM", handleTermination);
process.on("SIGINT", handleTermination);

console.log(
  `🚀 Server active for partition ${PARTITION_ID} on port :${nodeServer.port} connecting to ${REDIS_CONNECTION} ` +
    `(test partition: "x" maps to ${getPartitionTarget("x")})`,
);
