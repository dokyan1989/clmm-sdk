import { describe, expect, it } from "vitest";
import { ADA_UNIT } from "../src/constants.js";
import type { PoolDatum } from "../src/datum.js";
import { calculateConcentratedPoolSwap } from "../src/utils.js";

const LP_FEE_RATE = 30n;
const BASE = 10_000n;

/** The rate every protocol-config fixture in the indexer carries. */
const LIVE_RATE = 500n;

const datum: PoolDatum = {
  tokenX: ADA_UNIT,
  tokenY: "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456.55534441",
  sqrtLowerPriceNum: 4472135954999579n,
  sqrtLowerPriceDen: 10000000000000000n,
  sqrtUpperPriceNum: 6324555320336759n,
  sqrtUpperPriceDen: 10000000000000000n,
  lpFeeRate: Number(LP_FEE_RATE),
  platformFeeX: 0n,
  platformFeeY: 0n,
  totalSwapFee: 0n,
  minXChange: 1n,
  minYChange: 1n,
  circulatingLPToken: 997_000_000n,
  lastWithdrawEpoch: 640,
};

const feeFor = (amountIn: bigint, platformFeeRate: bigint): bigint =>
  calculateConcentratedPoolSwap(
    10_000_000n,
    20_000_000n,
    datum,
    amountIn,
    0n,
    platformFeeRate,
  ).platformFee;

/** What this SDK used to compute: the LP fee rounded first, its share rounded second. */
const roundedTwice = (amountIn: bigint, platformFeeRate: bigint): bigint =>
  (((amountIn * LP_FEE_RATE) / BASE) * platformFeeRate) / BASE;

/** What the reference implementation computes: one rounding over the product. */
const roundedOnce = (amountIn: bigint, platformFeeRate: bigint): bigint =>
  (amountIn * LP_FEE_RATE * platformFeeRate) / (BASE * BASE);

describe("platform fee rounding", () => {
  it("is unchanged at the rate the protocol runs today", () => {
    for (let amountIn = 1n; amountIn <= 20_000n; amountIn += 1n) {
      expect(feeFor(amountIn, LIVE_RATE)).toBe(roundedTwice(amountIn, LIVE_RATE));
    }
  });

  it("rounds once where the two forms part company", () => {
    const rate = 3_000n;
    const amountIn = 1_112n;

    // The two forms genuinely disagree here, which is what makes this a choice.
    expect(roundedTwice(amountIn, rate)).toBe(0n);
    expect(roundedOnce(amountIn, rate)).toBe(1n);

    expect(feeFor(amountIn, rate)).toBe(1n);
  });

  it("follows the reference form across a sweep of diverging rates", () => {
    for (const rate of [3_000n, 7_000n, 9_000n]) {
      for (let amountIn = 1n; amountIn <= 5_000n; amountIn += 1n) {
        expect(feeFor(amountIn, rate)).toBe(roundedOnce(amountIn, rate));
      }
    }
  });

  it("never charges more than the LP fee it is a share of", () => {
    for (const rate of [500n, 3_000n, 10_000n]) {
      for (let amountIn = 1n; amountIn <= 5_000n; amountIn += 1n) {
        expect(feeFor(amountIn, rate)).toBeLessThanOrEqual(
          (amountIn * LP_FEE_RATE) / BASE,
        );
      }
    }
  });
});
