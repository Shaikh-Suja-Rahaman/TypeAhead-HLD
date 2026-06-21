### **Blueprint: Distributed Search Typeahead System**

#### **Phase 1: Foundation & Data Ingestion**

- **Step 1: Traffic Routing & Hashing (`src/router.ts`)**
- Establish a consistent hashing ring to ensure data is distributed evenly across our cluster, utilizing virtual nodes.
- Expose a routing utility that deterministically maps any given text (like a prefix or full query) to a specific application shard (e.g., `app1`, `app2`, or `app3`).

- **Step 2: Database Initialization Script (`scripts/init.ts`)**
- Read the provided raw dataset (such as `data/search_frequencies.json`).
- Iterate through each query and compute all of its possible prefixes.
- Route each prefix through our hashing algorithm to find its designated Redis instance (`redis1`, `redis2`, or `redis3`).
- Utilize Redis pipelines to efficiently pre-load all these prefixes into the cache layer before the web servers even start.

#### **Phase 2: App Nodes & Write Buffering (`src/app-node.ts`)**

- **Step 3: Web Endpoints & Request Queuing**
- Boot up lightweight Bun servers, each paired directly with a dedicated Redis cache.
- **`GET /suggest?q=<prefix>`:** Fetch autocomplete options directly from the local Redis store for maximum speed.
- **`POST /search`:** Handle incoming search events by pushing them into a local memory queue instead of writing directly to PostgreSQL. Respond immediately with `202 Accepted`.

- **Step 4: Batch Persistence Strategy**
- Actively monitor the size of the in-memory queue.
- Once the queue reaches exactly **100 unprocessed queries**, initiate a bulk flush:
1. Drain the queue completely.
2. Calculate all prefixes for the 100 captured queries.
3. Consolidate and deduplicate frequency counts in memory.
4. Execute a batched Redis Pipeline to apply these updates across the cache nodes all at once.

#### **Phase 3: Trending Analytics & Score Decay**

- **Step 5: Monitoring Global Trends**
- While persisting batch updates, simultaneously record the actual completed queries into a Redis Sorted Set (`ZSET`) that tracks global popularity.
- Create a **`GET /trending`** endpoint that pulls the top entries from this sorted set to display popular searches.

- **Step 6: Gradual Score Decay**
- Set up a scheduled task or background loop that runs periodically (e.g., every 24 hours).
- This background process will sweep the trending `ZSET` and multiply every query's score by `0.9` (a **10% reduction**). This allows older popular searches to slowly fade out, making room for new viral trends.

#### **Phase 4: Gateway & User Interface**

- **Step 7: The API Gateway (`src/proxy.ts`)**
- Deploy a high-performance reverse proxy using Bun.
- Catch all incoming `/suggest` and `/search` requests, hash the incoming prefix or query, and forward the request to the correct application node. Ensure all routing decisions are logged.

- **Step 8: Infrastructure Topology**
- Spin up the ecosystem using Docker Compose: 1 Gateway, 3 App Nodes, 3 Redis instances, plus Postgres and the Sync Daemon. Ensure strict internal networking so components only talk to what they need to.

- **Step 9: Frontend Implementation (`public/index.html`)**
- Construct a clean, Google-like UI in vanilla JavaScript. Include a **150ms debounce** on the search input to prevent overwhelming the backend API.
- Render dynamic suggestions as the user types (via `/suggest`), and populate a trending queries section (via `/trending`) when the page loads.
