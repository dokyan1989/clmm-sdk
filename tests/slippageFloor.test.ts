import { describe, expect, it } from "vitest";
import type { SigningClient } from "@evolution-sdk/evolution";
import DanogoClmm from "../src/sdk.js";

const POOL_A = `${"a".repeat(64)}#0`;
const POOL_B = `${"b".repeat(64)}#1`;

/** Fails on the first network-touching call, so a guard that never ran is distinguishable from one that did. */
const networkTripwire = () =>
  ({
    address: () => {
      throw new Error("NETWORK_REACHED");
    },
  }) as unknown as SigningClient;

const swap = (pools: unknown[]) =>
  new DanogoClmm().submitSwap(networkTripwire(), {
    pools,
  } as Parameters<DanogoClmm["submitSwap"]>[1]);

describe("slippage floor", () => {
  it("refuses a pool with no minOutChangeAmount", async () => {
    await expect(
      swap([{ poolOutRef: POOL_A, deltaAmount: 500_000n }]),
    ).rejects.toThrow(`Pool 0 (${POOL_A}) has no minOutChangeAmount`);
  });

  it("names the offending pool when it is not the first one", async () => {
    await expect(
      swap([
        { poolOutRef: POOL_A, deltaAmount: 500_000n, minOutChangeAmount: 1n },
        { poolOutRef: POOL_B, deltaAmount: 500_000n },
      ]),
    ).rejects.toThrow(`Pool 1 (${POOL_B}) has no minOutChangeAmount`);
  });

  it("refuses a negative floor", async () => {
    await expect(
      swap([{ poolOutRef: POOL_A, deltaAmount: 500_000n, minOutChangeAmount: -1n }]),
    ).rejects.toThrow(`Pool 0 (${POOL_A}) has a negative minOutChangeAmount`);
  });

  it("accepts an explicit 0n as swapping at any price", async () => {
    await expect(
      swap([{ poolOutRef: POOL_A, deltaAmount: 500_000n, minOutChangeAmount: 0n }]),
    ).rejects.toThrow("NETWORK_REACHED");
  });

  it("accepts a real floor", async () => {
    await expect(
      swap([
        { poolOutRef: POOL_A, deltaAmount: 500_000n, minOutChangeAmount: 900_000n },
      ]),
    ).rejects.toThrow("NETWORK_REACHED");
  });
});
