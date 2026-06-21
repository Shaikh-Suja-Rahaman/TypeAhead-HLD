# API Reference

All external requests must be directed to the **Gateway Proxy** (`http://localhost:8080`), which acts as the singular public entry point. The proxy determines the correct application shard using a consistent hash ring and forwards the request transparently. End-users never communicate directly with internal shards.

| Method | Endpoint                        | Description                              |
| ------ | ------------------------------- | ---------------------------------------- |
| GET    | `/suggest?q=<prefix>`           | Retrieves autocomplete options (§4.1, §7)|
| POST   | `/search`                       | Registers a successful search (§4.2)     |
| GET    | `/trending`                     | Fetches globally popular queries (§7)    |
| GET    | `/cache/debug?prefix=<prefix>`  | Identifies the partition owner and cache state (§5) |
| GET    | `/metrics`                      | Outputs cluster-wide health and throughput stats |

---

## `GET /suggest?q=<prefix>[&rank=basic|recency][&limit=N]`

Fetches up to `limit` (default: 10) autocomplete suggestions matching the provided `<prefix>`. This is read from the designated Redis partition. **If a cache miss occurs, the system queries Postgres directly** (`source: "db"`) and triggers a background task to rebuild the cache (§6).

| Parameter | Default | Description                                                    |
| --------- | ------- | -------------------------------------------------------------- |
| `q`       | —       | The search prefix. Sanitized to lowercase. An empty string yields `[]`. |
| `rank`    | `basic` | `basic` uses historical totals; `recency` uses time-decayed scoring (§7). |
| `limit`   | `10`    | Maximum results to return. Invalid inputs revert to 10.        |

**Example Request**

```bash
curl "http://localhost:8080/suggest?q=go&rank=basic&limit=5"
```

**Example Response** `200 OK`

```json
{
  "shard": "3",
  "prefix": "go",
  "rank": "basic",
  "source": "cache",
  "suggestions": ["google", "google.com", "goggle", "google earth", "google com"]
}
```

- `shard` — The partition ID responsible for handling this prefix.
- `source` — Indicates whether data came from `"cache"` or the `"db"` fallback.
- Selecting `rank=recency` outputs the exact same structure but ordered by the dynamic recency metric, pushing trending queries higher.

Note: Edge cases like empty spaces, mixed casing, or zero-match prefixes gracefully return `200 OK` with an empty `suggestions` array rather than throwing errors.

---

## `POST /search`

Logs a completed user search. To guarantee high throughput, the query is **queued in memory on the app node, and a `202 Accepted` is issued instantly**. The database is not locked synchronously. The placeholder response is `{ "message": "Searched" }`.

**Example Request**

```bash
curl -X POST "http://localhost:8080/search" \
  -H "content-type: application/json" \
  -d '{"query":"google maps"}'
```

**Example Response** `202 Accepted`

```json
{ "message": "Searched", "query": "google maps", "buffered": 1 }
```

These new searches become visible across `/suggest` and `/trending` once the node flushes its queue (triggered either by reaching `FLUSH_THRESHOLD` or passing the `MAX_BUFFER_AGE_MS` timeout), and the sync-daemon rebuilds the Redis caches. Invalid JSON bodies return a `400 Bad Request`.

---

## `GET /trending?[limit=N]`

Displays the most active searches globally. Each partition maintains a localized `trending` Sorted Set that decays over time. The Gateway concurrently **queries all partitions and aggregates the results** to form a global top list.

```bash
curl "http://localhost:8080/trending?limit=3"
```

```json
{ "trending": [
  { "query": "go surge demo", "score": 416 },
  { "query": "myspace demo",  "score": 61 },
  { "query": "dictionary demo","score": 61 }
] }
```

---

## `GET /cache/debug?prefix=<prefix>`

An internal routing and debugging endpoint (§5) that determines exactly which application node is responsible for a prefix, and whether that prefix is currently loaded in Redis. It utilizes the **identical** hashing algorithm as `/suggest`.

```bash
curl "http://localhost:8080/cache/debug?prefix=go"
```

```json
{
  "prefix": "go",
  "node": "app3",
  "shard": "3",
  "status": "hit",
  "cached": 50,
  "recencyCached": 50
}
```

- `node` / `shard` — The authoritative server for this prefix.
- `status` — Returns `hit` if the standard `q:<prefix>` Redis key exists, otherwise `miss`.
- `cached` / `recencyCached` — The total number of items stored in the corresponding Sorted Sets.

---

## `GET /metrics`

Returns aggregated telemetry for the entire cluster. The load balancer collects and sums these values from every individual app node to power the performance reports.

```bash
curl "http://localhost:8080/metrics"
```

```json
{
  "total": {
    "searchesReceived": 2417,
    "batchesFlushed": 29,
    "rowsUpserted": 417,
    "cacheHits": 4211,
    "cacheMisses": 0,
    "buffered": 0,
    "cacheHitRate": 1.0,
    "writeReduction": 83.3
  },
  "partitionStats": [ { "shard": "1", "...": "per-node counters" } ]
}
```

| Metric             | Definition                                             |
| ------------------ | ------------------------------------------------------ |
| `searchesReceived` | Total `POST /search` requests absorbed into memory     |
| `batchesFlushed`   | Number of bulk commit transactions executed            |
| `rowsUpserted`     | Number of unique queries saved to the database         |
| `cacheHits/Misses` | Requests fulfilled by Redis vs Postgres failovers      |
| `cacheHitRate`     | The ratio of `hits / (hits + misses)`                  |
| `writeReduction`   | Efficiency metric: `searchesReceived / batchesFlushed` |

---

## Private Internal Endpoints

| Method | Endpoint           | Description                                                    |
| ------ | ------------------ | -------------------------------------------------------------- |
| POST   | `/internal/cache`  | The sync-daemon pushes fresh top-K data directly into Redis    |
| GET    | `/health`          | Used by Docker Compose to verify Redis and Postgres connections|

*Note: These endpoints are strictly bound to the internal container network and cannot be accessed from the public Gateway proxy.*
