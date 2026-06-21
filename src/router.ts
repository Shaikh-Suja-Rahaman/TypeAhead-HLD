/**
 * Consistent Hashing Router (Phase 1)
 *
 * Maps search prefixes or queries to specific partitions using a consistent ring.
 * Used identically across:
 * - data seeding
 * - load balancing
 * - batch writing
 */

export const PARTITIONS = ["1", "2", "3"] as const;
export type PartitionId = (typeof PARTITIONS)[number];

export const REPLICAS = 150;

/** FNV-1a 32-bit hash implementation */
export function hashString32(input: string): number {
  let hashVal = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hashVal ^= input.charCodeAt(i);
    hashVal +=
      (hashVal << 1) + (hashVal << 4) + (hashVal << 7) + (hashVal << 8) + (hashVal << 24);
  }
  return hashVal >>> 0;
}

interface RingNode {
  hashValue: number;
  partition: PartitionId;
}

export class ConsistentRing {
  private readonly nodes: RingNode[] = [];

  constructor(
    parts: readonly string[] = PARTITIONS,
    private readonly vNodes: number = REPLICAS,
  ) {
    for (const p of parts) {
      for (let i = 0; i < this.vNodes; i++) {
        this.nodes.push({ hashValue: hashString32(`${p}#${i}`), partition: p as PartitionId });
      }
    }
    this.nodes.sort((x, y) => x.hashValue - y.hashValue);
  }

  getPartition(key: string): PartitionId {
    const h = hashString32(key);
    let low = 0;
    let high = this.nodes.length - 1;
    
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.nodes[mid]!.hashValue < h) low = mid + 1;
      else high = mid;
    }
    
    const target = this.nodes[low]!;
    return target.hashValue >= h ? target.partition : this.nodes[0]!.partition;
  }
}

export const globalRing = new ConsistentRing();

export function getPartitionTarget(key: string): PartitionId {
  return globalRing.getPartition(key);
}
