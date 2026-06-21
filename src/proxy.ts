/**
 * Reverse Proxy / API Gateway (Phase 4)
 *
 * Routes incoming API traffic to the correct application node using consistent hashing.
 */

import { getPartitionTarget } from "./router";
import {
  PARTITIONS,
  MAX_TRENDING,
  getAppHost,
  formatQuery,
  type PartitionId,
} from "./settings";

const PROXY_PORT = Number(process.env.LB_PORT ?? process.env.PORT ?? 8080);

function logRoutingDecision(method: string, p: string, k: string, part: PartitionId) {
  console.log(`[GATEWAY] ${method} ${p} key="${k}" -> app${part}`);
}

async function forwardRequest(part: PartitionId, p: string, config?: RequestInit): Promise<Response> {
  try {
    return await fetch(getAppHost(part) + p, config);
  } catch (e) {
    console.error(`[GATEWAY] upstream app${part} unreachable:`, (e as Error).message);
    return Response.json({ error: `upstream partition ${part} offline` }, { status: 502 });
  }
}

async function fetchGlobalTrending(limit: number): Promise<Response> {
  const reqs = await Promise.allSettled(
    PARTITIONS.map((pId) =>
      fetch(`${getAppHost(pId)}/trending?limit=${limit}`).then(
        (response) => response.json() as Promise<{ trending: { query: string; score: number }[] }>,
      ),
    ),
  );

  const combined: { query: string; score: number }[] = [];
  for (const outcome of reqs) {
    if (outcome.status === "fulfilled") combined.push(...(outcome.value.trending ?? []));
  }
  combined.sort((x, y) => y.score - x.score);

  return Response.json({ trending: combined.slice(0, limit) });
}

async function fetchGlobalMetrics(): Promise<Response> {
  const reqs = await Promise.allSettled(
    PARTITIONS.map((pId) =>
      fetch(`${getAppHost(pId)}/metrics`).then((response) => response.json() as Promise<Record<string, number>>),
    ),
  );

  const partitionStats: Record<string, number>[] = [];
  const globalTotal = {
    searchesReceived: 0,
    batchesFlushed: 0,
    rowsUpserted: 0,
    cacheHits: 0,
    cacheMisses: 0,
    buffered: 0,
  };
  
  for (const outcome of reqs) {
    if (outcome.status !== "fulfilled") continue;
    const stats = outcome.value;
    partitionStats.push(stats);
    for (const key of Object.keys(globalTotal) as (keyof typeof globalTotal)[]) globalTotal[key] += stats[key] ?? 0;
  }

  const requestsTotal = globalTotal.cacheHits + globalTotal.cacheMisses;
  return Response.json({
    total: {
      ...globalTotal,
      cacheHitRate: requestsTotal > 0 ? globalTotal.cacheHits / requestsTotal : null,
      writeReduction:
        globalTotal.batchesFlushed > 0 ? globalTotal.searchesReceived / globalTotal.batchesFlushed : null,
    },
    partitionStats,
  });
}

const gatewayService = Bun.serve({
  port: PROXY_PORT,
  async fetch(request) {
    const parsedUrl = new URL(request.url);
    const { pathname } = parsedUrl;

    if (request.method === "GET" && pathname === "/suggest") {
      const q = formatQuery(parsedUrl.searchParams.get("q") ?? "");
      if (!q) return Response.json({ prefix: "", suggestions: [] });
      const target = getPartitionTarget(q);
      logRoutingDecision("GET", pathname, q, target);
      return forwardRequest(target, `/suggest${parsedUrl.search}`);
    }

    if (request.method === "POST" && pathname === "/search") {
      const payload = await request.text();
      let q = "";
      try {
        q = formatQuery((JSON.parse(payload) as { query?: string }).query ?? "");
      } catch {
        return Response.json({ error: "malformed payload" }, { status: 400 });
      }
      if (!q) return Response.json({ error: "query missing" }, { status: 400 });
      const target = getPartitionTarget(q);
      logRoutingDecision("POST", pathname, q, target);
      return forwardRequest(target, "/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
    }

    if (request.method === "GET" && pathname === "/trending") {
      const count = Number(parsedUrl.searchParams.get("limit"));
      const limit = Number.isInteger(count) && count > 0 ? count : MAX_TRENDING;
      return fetchGlobalTrending(limit);
    }

    if (request.method === "GET" && pathname === "/metrics") {
      return fetchGlobalMetrics();
    }

    if (request.method === "GET" && pathname === "/cache/debug") {
      const q = formatQuery(parsedUrl.searchParams.get("prefix") ?? "");
      if (!q) return Response.json({ error: "prefix missing" }, { status: 400 });
      const target = getPartitionTarget(q);
      logRoutingDecision("GET", pathname, q, target);
      return forwardRequest(target, `/cache/debug${parsedUrl.search}`);
    }

    if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return new Response(Bun.file("public/index.html"));
    }
    if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (request.method === "GET" && pathname === "/script.js") {
      return new Response(Bun.file("public/script.js"));
    }
    if (request.method === "GET" && pathname === "/google-logo-transparent.png") {
      return new Response(Bun.file("public/google-logo-transparent.png"));
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`🌐 Gateway running on port :${gatewayService.port}`);
for (const p of PARTITIONS) console.log(`     app${p} mapped to ${getAppHost(p)}`);
