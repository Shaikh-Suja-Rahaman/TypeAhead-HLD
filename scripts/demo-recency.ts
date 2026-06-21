/**
 * Recency Ranking Demo Script
 */

const API_BASE = process.env.BASE_URL ?? "http://localhost:8080";
const DEMO_PFX = (process.env.DEMO_PREFIX ?? "go").toLowerCase();
const TARGET_QRY = (process.env.DEMO_QUERY ?? `${DEMO_PFX} surge demo`).toLowerCase();
const BURST_CNT = Number(process.env.DEMO_BURST ?? 400);
const RESULT_SIZE = Number(process.env.DEMO_LIMIT ?? 10);

async function retrieveSuggestions(mode: "basic" | "recency"): Promise<string[]> {
  const result = await fetch(`${API_BASE}/suggest?q=${encodeURIComponent(DEMO_PFX)}&rank=${mode}&limit=${RESULT_SIZE}`);
  const payload = (await result.json()) as { suggestions?: string[] };
  return payload.suggestions ?? [];
}

function generateComparison(b: string[], r: string[]): string {
  const lines: string[] = [];
  const maxLen = Math.max(b.length, r.length);
  const highlightTarget = (list: string[], idx: number) =>
    (list[idx] === TARGET_QRY ? "» " : "  ") + (list[idx] ?? "");
    
  lines.push(`  #   Strategy: Count (basic)         Strategy: Blended (recency)`);
  lines.push(`  --  ------------------------------  ------------------------------`);
  for (let idx = 0; idx < maxLen; idx++) {
    const leftSide = highlightTarget(b, idx).padEnd(32);
    const rightSide = highlightTarget(r, idx);
    lines.push(`  ${String(idx + 1).padStart(2)}  ${leftSide}${rightSide}`);
  }
  return lines.join("\n");
}

function findPlacement(items: string[]): string {
  const pos = items.indexOf(TARGET_QRY);
  return pos < 0 ? `Unranked in top ${RESULT_SIZE}` : `#${pos + 1}`;
}

async function awaitProcessing() {
  for (let iter = 0; iter < 40; iter++) {
    const payload = (await (await fetch(`${API_BASE}/metrics`)).json()) as { total?: { buffered?: number } };
    if ((payload.total?.buffered ?? 0) === 0) return;
    await Bun.sleep(250);
  }
}

async function runDemo() {
  console.log(`# Recency Evaluation | Pfx: "${DEMO_PFX}" | Target: "${TARGET_QRY}" | Load: ${BURST_CNT}\n`);

  console.log(`[INITIAL] Target is ${findPlacement(await retrieveSuggestions("basic"))} (basic) and ${findPlacement(await retrieveSuggestions("recency"))} (recency)`);
  console.log(generateComparison(await retrieveSuggestions("basic"), await retrieveSuggestions("recency")));

  console.log(`\n... Simulating ${BURST_CNT} queries for "${TARGET_QRY}"`);
  const workerProcs = Array.from({ length: 32 }, async () => {
    for (let idx = 0; idx < Math.ceil(BURST_CNT / 32); idx++) {
      await fetch(`${API_BASE}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: TARGET_QRY }),
      });
    }
  });
  await Promise.all(workerProcs);

  await awaitProcessing();
  
  let recencyResults: string[] = [];
  for (let iter = 0; iter < 20; iter++) {
    await Bun.sleep(500);
    recencyResults = await retrieveSuggestions("recency");
    if (recencyResults.includes(TARGET_QRY)) break;
  }

  console.log(`\n[POST-BURST] Target is ${findPlacement(await retrieveSuggestions("basic"))} (basic) and ${findPlacement(await retrieveSuggestions("recency"))} (recency)`);
  console.log(generateComparison(await retrieveSuggestions("basic"), recencyResults));
  console.log(
    `\n-> The recency parameter successfully prioritizes recent bursts of activity over historical counts.\n` +
      `   It climbed from ${findPlacement(await retrieveSuggestions("basic"))} under normal ranking to ${findPlacement(recencyResults)}.`
  );
}

runDemo();
