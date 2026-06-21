# Performance Analysis

This guide details the non-functional performance testing of the system, focusing specifically on response times, caching efficiency, and database load reduction via batching. The recorded metrics are derived from a live local cluster environment.

```bash
docker compose up --build          # Spin up the cluster
bun run benchmark                  # Start the load testing suite
bun run demo:recency               # Watch the recency ranking in action
```

## Testing Setup

- **Flow:** Every request travels through the complete architecture: API Gateway -> App Server -> Redis / Postgres / Sync Daemon. All traffic enters via the `http://localhost:8080` entrypoint.
- **Hardware:** Tests were executed in Docker containers on a local workstation. Due to negligible network latency, these results highlight the core application overhead.
- **Dataset:** Contains 93,387 distinct query strings accounting for over 1.72 million individual searches.
- **Execution Strategy:** The `scripts/benchmark.ts` script fires 4,000 HTTP calls at a concurrency of 32, following a brief 200-request warmup period.

## 1. Autocomplete Latency (`GET /suggest`)

Measurements taken across 4,000 diverse queries:

| Strategy           | Mean   | Median (P50) | P90    | P95        | P99    | Max    | Requests/sec |
| ------------------ | ------ | ------------ | ------ | ---------- | ------ | ------ | ------------ |
| `basic`            | 0.63ms | 0.52ms       | 1.05ms | **1.21ms** | 2.26ms | 2.77ms | ~50,400 rps  |
| `recency`          | 0.63ms | 0.52ms       | 1.12ms | **1.35ms** | 2.49ms | 3.31ms | ~50,800 rps  |

**Conclusion:** Implementing recency-based ranking adds virtually zero overhead during reads. This is because the heavy lifting for scoring is done asynchronously by the Sync Daemon, keeping the read operation to a lightning-fast Redis `ZREVRANGE`.

## 2. Cache Effectiveness

The system queries Redis first and only falls back to PostgreSQL if the data is missing. A database fallback automatically queues a background job to rebuild that specific prefix cache.

- Benchmark Result: **100% Hit Rate** (4,000 hits / 0 misses).
- Testing the fallback behavior manually:

  ```text
  /suggest?q=goo            -> Data Origin: cache    # Served by Redis partition 3
  [Terminal] redis-cli DEL q:goo                     # Wipe the cache entry
  /suggest?q=goo            -> Data Origin: db       # Data pulled from Postgres
  …Sync Daemon kicks in and repopulates Redis…
  /suggest?q=goo            -> Data Origin: cache    # Served by Redis again
  ```

Because our `init.ts` script pre-warms the cache during startup, maintaining a 100% hit rate under normal conditions is expected.

## 3. Minimizing Database Writes

Application nodes pool incoming searches locally and flush them to the PostgreSQL database in chunks of 100.

| Metric                          | Value     |
| ------------------------------- | --------- |
| Total Searches Received         | 2,000     |
| DB Commit Transactions          | 22        |
| **Write Optimization Factor**   | **90.9×** |
| Unique Rows Touched             | 410       |

By utilizing an in-memory buffer, we processed 2,000 searches using only 22 database transactions. This approach drastically minimizes disk I/O and prevents database locks.

## 4. Hash Ring Distribution

During the startup phase, over 1.35 million top-K cache objects were distributed across three Redis shards:

| Shard Node | Cached Objects Handled   | Total Redis Keys |
| ---------- | ------------------------ | ---------------- |
| 1          | 431,490                  | 602,437          |
| 2          | 334,549                  | 470,035          |
| 3          | 586,736                  | 793,371          |

Note: The differences in node load are caused by the natural clustering of English vocabulary (some prefixes have vastly more valid combinations than others), rather than an imbalance in the hashing function itself.

## Running the Tests

```bash
bun run benchmark                               # Run standard benchmark
BENCH_RANK=recency bun run benchmark            # Benchmark the recency ranker
bun run demo:recency                            # Demo the recency logic
curl -s localhost:8080/metrics | jq             # View cluster health stats
```
