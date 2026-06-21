import { test, expect } from "bun:test";
import { ConsistentRing, hashString32, globalRing, getPartitionTarget, PARTITIONS } from "../src/router";

test("hashString32 is consistent and produces 32-bit unsigned integers", () => {
  expect(hashString32("amazon")).toBe(hashString32("amazon"));
  expect(hashString32("amazon")).not.toBe(hashString32("netflix"));
  const hashedVal = hashString32("randomString");
  expect(hashedVal).toBeGreaterThanOrEqual(0);
  expect(hashedVal).toBeLessThanOrEqual(0xffffffff);
  expect(Number.isInteger(hashedVal)).toBe(true);
});

test("ConsistentRing targets same partition across isolated instances", () => {
  const instanceOne = new ConsistentRing();
  const instanceTwo = new ConsistentRing();
  for (const k of ["amazon", "a", "am", "netflix.com", "meta", "-", "apple"]) {
    expect(instanceOne.getPartition(k)).toBe(instanceTwo.getPartition(k));
    expect(getPartitionTarget(k)).toBe(instanceOne.getPartition(k));
  }
});

test("getPartitionTarget always resolves to an expected partition", () => {
  for (let idx = 0; idx < 1000; idx++) {
    expect(PARTITIONS).toContain(globalRing.getPartition(`test-${idx}`));
  }
});

test("replicas distribute keys fairly evenly", () => {
  const loadDistribution: Record<string, number> = { "1": 0, "2": 0, "3": 0 };
  const totalItems = 30000;
  for (let idx = 0; idx < totalItems; idx++) loadDistribution[globalRing.getPartition(`item-${idx}`)]!++;

  const targetAvg = totalItems / PARTITIONS.length;
  for (const part of PARTITIONS) {
    expect(loadDistribution[part]).toBeGreaterThan(targetAvg * 0.70);
    expect(loadDistribution[part]).toBeLessThan(targetAvg * 1.30);
  }
});

test("all string prefixes map correctly (verifies bounds)", () => {
  const baseStr = "amazon.com";
  for (let length = 1; length <= baseStr.length; length++) {
    expect(PARTITIONS).toContain(getPartitionTarget(baseStr.slice(0, length)));
  }
});
