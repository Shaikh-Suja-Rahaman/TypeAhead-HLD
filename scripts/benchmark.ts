/**
 * Benchmarking Script
 */

import { formatQuery } from "../src/settings";

const BASE_API = process.env.BASE_URL ?? "http://localhost:8080";
const SUGGEST_TEST_COUNT = Number(process.env.BENCH_SUGGEST ?? 3000);
const SEARCH_TEST_COUNT = Number(process.env.BENCH_SEARCH ?? 1000);
const MAX_CONCURRENT = Number(process.env.BENCH_CONCURRENCY ?? 32);
const SORT_STRATEGY = process.env.BENCH_RANK ?? "basic";
const DATASET_FILE = process.env.DATA_PATH ?? "data/search_frequencies.json";

interface RawEntry {
  query: string;
  count: number;
}

async function preparePrefixes(): Promise<string[]> {
  const content: RawEntry[] = JSON.parse(await Bun.file(DATASET_FILE).text());
  const validQueries = content
    .map((e) => formatQuery(e.query))
    .filter((q) => /[a-z0-9]/i.test(q) && q.length >= 2);
  const prefixSet = new Set<string>();
  for (const q of validQueries) {
    const pLen = 2 + (q.length % 3);
    prefixSet.add(q.slice(0, Math.min(pLen, q.length)));
    if (prefixSet.size >= 20000) break;
  }
  return [...prefixSet];
}

async function runWorkerPool<T>(limit: number, maxConc: number, executor: (idx: number) => Promise<T>) {
  let counter = 0;
  const workers = Array.from({ length: maxConc }, async () => {
    while (true) {
      const idx = counter++;
      if (idx >= limit) return;
      await executor(idx);
    }
  });
  await Promise.all(workers);
}

function calculateP(data: number[], p: number): number {
  if (data.length === 0) return 0;
  const i = Math.min(data.length - 1, Math.ceil((p / 100) * data.length) - 1);
  return data[Math.max(0, i)]!;
}

const formatMs = (n: number) => `${n.toFixed(2)}ms`;

async function fetchStats(): Promise<any> {
  const response = await fetch(`${BASE_API}/metrics`);
  return response.json();
}

async function executeSuggestBenchmark(prefixPool: string[]) {
  console.log(`\n▶ Suggest Latency Test (rank=${SORT_STRATEGY}, N=${SUGGEST_TEST_COUNT}, maxConc=${MAX_CONCURRENT})`);

  await runWorkerPool(Math.min(200, SUGGEST_TEST_COUNT), MAX_CONCURRENT, async (idx) => {
    await fetch(`${BASE_API}/suggest?q=${encodeURIComponent(prefixPool[idx % prefixPool.length]!)}&rank=${SORT_STRATEGY}`);
  });

  const latData: number[] = [];
  let cacheOk = 0;
  let cacheDb = 0;
  let failCount = 0;

  const tStart = performance.now();
  await runWorkerPool(SUGGEST_TEST_COUNT, MAX_CONCURRENT, async () => {
    const pf = prefixPool[Math.floor(Math.random() * prefixPool.length)]!;
    const msStart = performance.now();
    try {
      const res = await fetch(`${BASE_API}/suggest?q=${encodeURIComponent(pf)}&rank=${SORT_STRATEGY}`);
      const payload = (await res.json()) as { source?: string };
      latData.push(performance.now() - msStart);
      if (payload.source === "db") cacheDb++;
      else cacheOk++;
    } catch {
      failCount++;
    }
  });
  const tDuration = performance.now() - tStart;

  latData.sort((a, b) => a - b);
  const tSum = latData.reduce((x, y) => x + y, 0);
  console.log(`  Requests    : ${latData.length} valid, ${failCount} failed`);
  console.log(`  Throughput  : ${(latData.length / (tDuration / 1000)).toFixed(0)} req/s (time ${formatMs(tDuration)})`);
  console.log(`  Mean Lat    : ${formatMs(tSum / latData.length)}`);
  console.log(`  P50 Lat     : ${formatMs(calculateP(latData, 50))}`);
  console.log(`  P90 Lat     : ${formatMs(calculateP(latData, 90))}`);
  console.log(`  P95 Lat     : ${formatMs(calculateP(latData, 95))}`);
  console.log(`  P99 Lat     : ${formatMs(calculateP(latData, 99))}`);
  console.log(`  Max Lat     : ${formatMs(latData[latData.length - 1] ?? 0)}`);
  console.log(`  Hit Ratio   : ${cacheOk} / ${cacheOk + cacheDb} (${((cacheOk / (cacheOk + cacheDb)) * 100).toFixed(1)}% this run)`);
}

async function executeWriteBenchmark(prefixPool: string[]) {
  console.log(`\n▶ Write Reduction Test (N=${SEARCH_TEST_COUNT} searches)`);
  const initial = await fetchStats();

  const subset = prefixPool.slice(0, 50).map((p) => `${p} demo`);
  await runWorkerPool(SEARCH_TEST_COUNT, MAX_CONCURRENT, async (idx) => {
    const reqStr = subset[idx % subset.length]!;
    await fetch(`${BASE_API}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: reqStr }),
    });
  });

  for (let idx = 0; idx < 40; idx++) {
    const stats = await fetchStats();
    if ((stats.total?.buffered ?? 0) === 0) break;
    await Bun.sleep(250);
  }
  const finalState = await fetchStats();

  const searchDelta = (finalState.total.searchesReceived ?? 0) - (initial.total.searchesReceived ?? 0);
  const txDelta = (finalState.total.batchesFlushed ?? 0) - (initial.total.batchesFlushed ?? 0);
  const upsertDelta = (finalState.total.rowsUpserted ?? 0) - (initial.total.rowsUpserted ?? 0);
  
  console.log(`  Total searches sent    : ${searchDelta}`);
  console.log(`  Postgres transactions  : ${txDelta}`);
  console.log(`  Total DB rows upserted : ${upsertDelta}`);
  console.log(
    `  Batching efficiency    : ${txDelta > 0 ? (searchDelta / txDelta).toFixed(1) : "n/a"}× ` +
      `(queries per DB write)`,
  );
}

async function startBench() {
  console.log(`# Profiling performance on ${BASE_API}`);
  try {
    await fetch(`${BASE_API}/metrics`);
  } catch {
    console.error(`Cannot connect to ${BASE_API}. Ensure cluster is operational.`);
    process.exit(1);
  }

  const generatedPrefixes = await preparePrefixes();
  console.log(`Dataset sample: ${generatedPrefixes.length} unique prefixes prepared.`);

  await executeSuggestBenchmark(generatedPrefixes);
  await executeWriteBenchmark(generatedPrefixes);

  const finalMetrics = await fetchStats();
  console.log(`\n▶ Cluster Aggregates (Lifetime)`);
  console.log(`  Hit Rate      : ${finalMetrics.total.cacheHitRate != null ? (finalMetrics.total.cacheHitRate * 100).toFixed(1) + "%" : "n/a"}`);
  console.log(`  DB Reduction  : ${finalMetrics.total.writeReduction != null ? finalMetrics.total.writeReduction.toFixed(1) + "×" : "n/a"}`);
  console.log(`  Volume        : queries=${finalMetrics.total.searchesReceived} commits=${finalMetrics.total.batchesFlushed} upserts=${finalMetrics.total.rowsUpserted}`);
  console.log(`  Cache Perf    : hits=${finalMetrics.total.cacheHits} misses=${finalMetrics.total.cacheMisses}`);
}

startBench();
