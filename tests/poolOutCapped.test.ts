import { describe, expect, it } from "vitest";
import { calculateConcentratedPoolSwap } from "../src/utils.js";
import { ADA_UNIT } from "../src/constants.js";
import type { PoolDatum } from "../src/datum.js";

const datum: PoolDatum = {
  tokenX: ADA_UNIT,
  tokenY: "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456.55534441",
  sqrtLowerPriceNum: 4472135954999579n,
  sqrtLowerPriceDen: 10000000000000000n,
  sqrtUpperPriceNum: 6324555320336759n,
  sqrtUpperPriceDen: 10000000000000000n,
  lpFeeRate: 30,
  platformFeeX: 0n,
  platformFeeY: 0n,
  totalSwapFee: 0n,
  minXChange: 1n,
  minYChange: 1n,
  circulatingLPToken: 997_000_000n,
  lastWithdrawEpoch: 640,
};

const TOKEN_A_RESERVE = 10_000_000n;
const TOKEN_B_RESERVE = 20_000_000n;
// tokenX is ADA, so 3_000_000n (plus the zero totalSwapFee) is held back from
// the active reserve — see calculateConcentratedPoolSwap's excludedADA.
const ACTIVE_RESERVE_X = TOKEN_A_RESERVE - 3_000_000n;
const ACTIVE_RESERVE_Y = TOKEN_B_RESERVE;

const HUGE_AMOUNT = 10_000_000_000n;

const swapFor = (deltaAmount: bigint) =>
  calculateConcentratedPoolSwap(
    TOKEN_A_RESERVE,
    TOKEN_B_RESERVE,
    datum,
    deltaAmount,
    0n,
    500n,
  );

describe("pool out capped instead of exceeded", () => {
  it("caps a sell of X at the pool's real Y reserve instead of throwing", () => {
    const result = swapFor(HUGE_AMOUNT);
    expect(result.outputAmount).toBe(ACTIVE_RESERVE_Y);
  });

  it("caps a sell of Y at the pool's real X reserve instead of throwing", () => {
    const result = swapFor(-HUGE_AMOUNT);
    expect(result.outputAmount).toBe(ACTIVE_RESERVE_X);
  });

  it("shrinks the input to what the capped output actually needs, keeping the requested direction", () => {
    const sell = swapFor(HUGE_AMOUNT);
    expect(sell.deltaAmount).toBeGreaterThan(0n);
    expect(sell.deltaAmount).toBeLessThan(HUGE_AMOUNT);

    const buy = swapFor(-HUGE_AMOUNT);
    expect(buy.deltaAmount).toBeLessThan(0n);
    expect(-buy.deltaAmount).toBeLessThan(HUGE_AMOUNT);
  });

  it("charges the platform fee on the shrunk input, not the amount originally offered", () => {
    const uncapped = swapFor(1_000_000n);
    const capped = swapFor(HUGE_AMOUNT);

    // The capped input is far smaller than the huge one requested, so its fee
    // must be far smaller than a fee computed on the full, unadjusted amount
    // would be — this is what "on the shrunk input" is actually checking for.
    expect(capped.platformFee).toBeLessThan(
      (HUGE_AMOUNT * 30n * 500n) / (10_000n * 10_000n),
    );
    expect(uncapped.platformFee).toBeGreaterThan(0n);
  });
});
