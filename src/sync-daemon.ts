/**
 * Sync Daemon
 * Polls dirty prefixes and propagates updates to App nodes.
 */

import { getPartitionTarget } from "./router";
import {
  pgClient,
  getTopSuggestionsForPrefix,
  getTopSuggestionsBlended,
  applyRecentActivityDecay,
  flagDirty,
  type FrequencyRow,
} from "./store";
import {
  ZSET_DEPTH,
  PARTITIONS,
  getAppHost,
  generatePrefixes,
  RECENT_DECAY_MULTIPLIER,
  RECENT_DECAY_CRON_MS,
  type PartitionId,
} from "./settings";

const POLL_CRON_MS = Number(process.env.CACHE_POLL_INTERVAL_MS ?? 1000);
const UPDATE_CHUNK_SIZE = Number(process.env.CACHE_DIRTY_BATCH ?? 200);

interface PrefixCacheUpdate {
  prefix: string;
  topK: FrequencyRow[];
  topKRecency: FrequencyRow[];
}

async function syncWithPartition(part: PartitionId, changes: PrefixCacheUpdate[]): Promise<void> {
  const result = await fetch(`${getAppHost(part)}/internal/cache`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ updates: changes }),
  });
  if (!result.ok) throw new Error(`app${part} /internal/cache returned ${result.status}`);
}

async function processDirtyPrefixesBatch(): Promise<number> {
  const retrievedItems = (await pgClient`
    DELETE FROM dirty_prefixes
    WHERE prefix IN (
      SELECT prefix FROM dirty_prefixes ORDER BY dirty_at ASC LIMIT ${UPDATE_CHUNK_SIZE}
    )
    RETURNING prefix
  `) as { prefix: string }[];

  if (retrievedItems.length === 0) return 0;
  const targetPrefixes = retrievedItems.map((record) => record.prefix);

  const payload = await Promise.all(
    targetPrefixes.map(async (pref) => ({
      prefix: pref,
      topK: await getTopSuggestionsForPrefix(pref, ZSET_DEPTH),
      topKRecency: await getTopSuggestionsBlended(pref, ZSET_DEPTH),
    })),
  );

  const categorizedData = new Map<PartitionId, PrefixCacheUpdate[]>();
  for (const item of payload) {
    const part = getPartitionTarget(item.prefix);
    let arr = categorizedData.get(part);
    if (!arr) categorizedData.set(part, (arr = []));
    arr.push(item);
  }

  await Promise.all(
    [...categorizedData].map(async ([part, items]) => {
      try {
        await syncWithPartition(part, items);
      } catch (e) {
        console.error(
          `[daemon] sync error for partition ${part}, returning ${items.length} to queue:`,
          (e as Error).message,
        );
        await flagDirty(items.map((i) => i.prefix));
      }
    }),
  );

  return retrievedItems.length;
}

let isSyncing = false;
async function updaterLoop(): Promise<void> {
  if (isSyncing) return;
  isSyncing = true;
  try {
    let processedCount: number;
    do {
      processedCount = await processDirtyPrefixesBatch();
      if (processedCount > 0) console.log(`[daemon] synchronized ${processedCount} prefixes successfully`);
    } while (processedCount === UPDATE_CHUNK_SIZE);
  } catch (error) {
    console.error("[daemon] error during sync loop:", error);
  } finally {
    isSyncing = false;
  }
}

const syncTimer = setInterval(() => void updaterLoop(), POLL_CRON_MS);

async function applySystemDecay(): Promise<void> {
  try {
    const modifiedQueries = await applyRecentActivityDecay(RECENT_DECAY_MULTIPLIER);
    if (modifiedQueries.length === 0) return;
    const dirtySet = new Set<string>();
    for (const mq of modifiedQueries) for (const pf of generatePrefixes(mq)) dirtySet.add(pf);
    await flagDirty([...dirtySet]);
    console.log(
      `[daemon] executed recency decay for ${modifiedQueries.length} items; ` +
        `marked ${dirtySet.size} prefixes for synchronization`,
    );
  } catch (err) {
    console.error("[daemon] decay failure:", err);
  }
}

const systemDecayTimer = setInterval(() => void applySystemDecay(), RECENT_DECAY_CRON_MS);

const handleProcessEnd = async () => {
  console.log("[daemon] terminating...");
  clearInterval(syncTimer);
  clearInterval(systemDecayTimer);
  while (isSyncing) await new Promise((res) => setTimeout(res, 20));
  await pgClient.close({ timeout: 5 });
  process.exit(0);
};

process.on("SIGTERM", handleProcessEnd);
process.on("SIGINT", handleProcessEnd);

console.log(
  `⚙️  Daemon active: poll=${POLL_CRON_MS}ms chunkSize=${UPDATE_CHUNK_SIZE} depth=${ZSET_DEPTH} ` +
    `-> app nodes [${PARTITIONS.map((pId) => getAppHost(pId)).join(", ")}]`,
);
