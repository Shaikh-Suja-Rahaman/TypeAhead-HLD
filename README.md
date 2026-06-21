# Typeahead Autocomplete Engine

A highly available and scalable search autocomplete service built on a distributed backend. This architecture relies on **PostgreSQL as the authoritative data store** to persistently track search query frequencies, paired with a **sharded Redis cluster** that caches prefix-to-suggestion mappings for lightning-fast reads. A custom load balancer utilizes a consistent hashing ring to intelligently route traffic to the appropriate nodes. A dedicated background daemon continually syncs the cache layer with the database without blocking the primary application servers. The entire ecosystem is powered natively by `Bun`.

![Architecture Layout](https://raw.githubusercontent.com/Shaikh-Suja-Rahaman/TypeAhead-HLD/main/High%20Level%20Design.png)

## Core Features & Grading Checklist

| Feature Requirement | Technical Implementation |
| --- | --- |
| **Autocomplete Suggestions (60)** | Bootstrapped by `scripts/init.ts` and managed via `src/router.ts` for distributed caching. Incorporates seamless failovers directly to Postgres. |
| **Trending & Recency (20)** | Activated using the `?rank=recency` query parameter. It features a natural time-decay algorithm to highlight emerging trends. Run `bun run demo:recency` to see it in action. |
| **Write Batching (20)** | Employs an in-memory queue inside `src/app-node.ts` to dramatically slash database commit overhead by grouping writes. |

Available Endpoints (Exposed via Gateway):
- `GET /suggest?q={query}&rank={mode}`
- `POST /search`
- `GET /trending`
- `GET /metrics`

## System Architecture

1. **Intelligent Routing**: `src/router.ts` predictably maps search terms to specific partitions, ensuring perfect cache locality.
2. **Persistent Storage**: `src/store.ts` handles all Postgres interactions, persisting `query_counts` while tagging modified data in the `dirty_prefixes` table.
3. **Asynchronous Writes**: The `POST /search` endpoint instantly acknowledges requests (202 Accepted) by queuing them in memory. These are later flushed to the database in efficient batches.
4. **Cache Reconciliation**: The `src/sync-daemon.ts` constantly polls for dirty prefixes and pushes the newly computed top-K results to the corresponding Redis shards via internal routes.
5. **Trend Decay**: Over time, older search counts are algorithmically diminished to ensure fresh, viral queries can surface.

## Storage Models
- **PostgreSQL Database**: Contains `query_counts` (query string, historical count, recent hits) alongside `dirty_prefixes` (prefix string, timestamp).
- **Redis Shards**: Maintains `q:<prefix>` (Sorted Sets for all-time counts), `qr:<prefix>` (Sorted Sets for recency-adjusted scores), and a global `trending` list.

## Setup & Deployment

### Quickstart with Docker
To boot the full ecosystem effortlessly:
```bash
docker compose up --build
```
This orchestrates the Postgres DB, Redis shards, the application mesh, and the gateway proxy. The UI is available at `http://localhost:8080`.

### Running Locally (Manual)
If you prefer running services directly:
```bash
# Boot the necessary databases
docker run -d -p 6379:6379 redis:7-alpine
docker run -d -p 5432:5432 -e POSTGRES_USER=typeahead -e POSTGRES_PASSWORD=typeahead -e POSTGRES_DB=typeahead postgres:16-alpine

# Seed the initial data
bun run init

# Boot the node cluster
bun run dev:app1 & bun run dev:app2 & bun run dev:app3 &
bun run dev:daemon &
bun run dev:lb
```

### Performance Testing
To stress-test the architecture, run:
```bash
bun run benchmark
```
Live cluster telemetry and hit-rates can be monitored by visiting `localhost:8080/metrics`.
