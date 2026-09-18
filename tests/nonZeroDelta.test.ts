import { describe, expect, it } from "vitest";
import type { SigningClient } from "@evolution-sdk/evolution/sdk/client/Client";
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

describe("zero deltaAmount is rejected before the request reaches the network", () => {
  const sdk = new DanogoClmm();

  it("rejects a single pool with deltaAmount 0", async () => {
    await expect(
      sdk.submitSwap(networkTripwire(), {
        pools: [
          { poolOutRef: POOL_A, deltaAmount: 0n, minOutChangeAmount: 1n },
        ],
      }),
    ).rejects.toThrow(`Pool 0 (${POOL_A}) has deltaAmount 0`);
  });

  it("names the offending pool when it is not the first one", async () => {
    await expect(
      sdk.submitSwap(networkTripwire(), {
        pools: [
          { poolOutRef: POOL_A, deltaAmount: 500_000n, minOutChangeAmount: 1n },
          { poolOutRef: POOL_B, deltaAmount: 0n, minOutChangeAmount: 1n },
        ],
      }),
    ).rejects.toThrow(`Pool 1 (${POOL_B}) has deltaAmount 0`);
  });

  it("rejects a zero delta in calculateSwapOut too, so quotes and swaps agree", async () => {
    await expect(
      sdk.calculateSwapOut(networkTripwire(), {
        pools: [{ poolOutRef: POOL_A, deltaAmount: 0n }],
      }),
    ).rejects.toThrow(`Pool 0 (${POOL_A}) has deltaAmount 0`);
  });

  it("lets a request through when every pool moves a non-zero amount", async () => {
    await expect(
      sdk.submitSwap(networkTripwire(), {
        pools: [
          { poolOutRef: POOL_A, deltaAmount: 500_000n, minOutChangeAmount: 1n },
          { poolOutRef: POOL_B, deltaAmount: -500_000n, minOutChangeAmount: 1n },
        ],
      }),
    ).rejects.toThrow("NETWORK_REACHED");
  });
});
