/**
 * Database Ingestion & Cache Seeding Script
 */

import { RedisClient } from "bun";
import { PARTITIONS, getPartitionTarget, type PartitionId } from "../src/router";
import { formatQuery, getRedisConnStr, getSuggestKey, getRecencyKey, ZSET_DEPTH } from "../src/settings";
import { pgClient, initDbSchema, ingestRawCounts, computeColdStartCache } from "../src/store";

function isValidSearch(s: string): boolean {
  return /[a-z0-9]/i.test(s);
}

const DATASET_FILE = process.env.DATA_PATH ?? "data/search_frequencies.json";
const CHUNK_SIZE = Number(process.env.SEED_CHUNK ?? 5000);
const WIPE_OLD_DATA = process.env.SEED_FLUSH !== "0";

interface RawEntry {
  query: string;
  count: number;
}

async function executeSeeder() {
  await initDbSchema();
  console.log("[seeder] database schema verified");

  const redisConnections: Record<PartitionId, RedisClient> = {} as Record<PartitionId, RedisClient>;
  for (const p of PARTITIONS) {
    redisConnections[p] = new RedisClient(getRedisConnStr(p));
    await redisConnections[p].connect();
  }

  if (WIPE_OLD_DATA) {
    console.log("[seeder] clearing existing DB and Redis state...");
    await pgClient`TRUNCATE query_counts, dirty_prefixes`;
    await Promise.all(PARTITIONS.map((p) => redisConnections[p].send("FLUSHDB", [])));
  }

  console.log(`[seeder] parsing file: ${DATASET_FILE}`);
  const payload: RawEntry[] = JSON.parse(await Bun.file(DATASET_FILE).text());

  const aggregateCounts = new Map<string, number>();
  let discardedCount = 0;
  for (const { query, count } of payload) {
    const formatted = formatQuery(query);
    if (!formatted || !isValidSearch(formatted)) {
      discardedCount++;
      continue;
    }
    aggregateCounts.set(formatted, (aggregateCounts.get(formatted) ?? 0) + count);
  }
  console.log(
    `[seeder] loaded ${payload.length.toLocaleString()} total rows -> ${aggregateCounts.size.toLocaleString()} ` +
      `unique strings (${discardedCount.toLocaleString()} skipped)`,
  );

  let currentBatch: { query: string; count: number }[] = [];
  let processedQueries = 0;
  for (const [q, c] of aggregateCounts) {
    currentBatch.push({ query: q, count: c });
    if (currentBatch.length >= CHUNK_SIZE) {
      await ingestRawCounts(currentBatch);
      processedQueries += currentBatch.length;
      currentBatch = [];
      if (processedQueries % 50000 < CHUNK_SIZE) console.log(`[seeder] wrote ${processedQueries.toLocaleString()} records to Postgres`);
    }
  }
  if (currentBatch.length) {
    await ingestRawCounts(currentBatch);
    processedQueries += currentBatch.length;
  }
  console.log(`[seeder] phase 1 complete: ${processedQueries.toLocaleString()} records saved`);

  console.log(`[seeder] phase 2: building top-${ZSET_DEPTH} caches for redis partitions...`);
  const partitionStats: Record<PartitionId, number> = { "1": 0, "2": 0, "3": 0 };
  let pendingRedisOps: Promise<unknown>[] = [];
  let cacheEntriesWritten = 0;

  const commitRedisBatch = async () => {
    if (pendingRedisOps.length === 0) return;
    const ops = pendingRedisOps;
    pendingRedisOps = [];
    await Promise.all(ops);
  };

  for await (const chunk of computeColdStartCache(ZSET_DEPTH)) {
    for (const { prefix, query, count, recency_score } of chunk) {
      const target = getPartitionTarget(prefix);
      pendingRedisOps.push(redisConnections[target].send("ZADD", [getSuggestKey(prefix), count, query]));
      pendingRedisOps.push(redisConnections[target].send("ZADD", [getRecencyKey(prefix), String(recency_score), query]));
      partitionStats[target]++;
      cacheEntriesWritten++;
      if (pendingRedisOps.length >= CHUNK_SIZE) await commitRedisBatch();
    }
    await commitRedisBatch();
    console.log(`[seeder] progress -> generated ${cacheEntriesWritten.toLocaleString()} cache items`);
  }
  await commitRedisBatch();

  console.log(`[seeder] phase 2 complete. ${cacheEntriesWritten.toLocaleString()} items written.`);
  for (const p of PARTITIONS) {
    console.log(`[seeder]   partition ${p} -> ${partitionStats[p].toLocaleString()} keys`);
  }

  for (const p of PARTITIONS) redisConnections[p].close();
  await pgClient.close();
}

executeSeeder().catch((e) => {
  console.error("[seeder] process aborted with error:", e);
  process.exit(1);
});
