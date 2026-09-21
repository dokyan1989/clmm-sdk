import { describe, expect, it, vi } from "vitest";
import { ADA_UNIT } from "../src/constants.js";
import { transformPoolDatum, parseDatum, type PoolDatum } from "../src/datum.js";

const TOKEN_Y =
  "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456.55534441";

const adaPoolDatum: PoolDatum = {
  tokenX: ADA_UNIT,
  tokenY: TOKEN_Y,
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

describe("ADA's AssetClass encoding", () => {
  it("round-trips to the empty policy id and asset name parseDatum expects for ADA_UNIT", () => {
    const result = parseDatum(transformPoolDatum(adaPoolDatum).data);
    expect(result.tokenX).toBe(ADA_UNIT);
  });

  it("does not rely on Buffer.from silently truncating invalid hex to get there", () => {
    // "lovelace" happens to produce an empty buffer under Node's lenient hex
    // decoder (it stops at the first invalid nibble, 'l', which is nibble 0).
    // A stricter decoder — a different Buffer polyfill, a browser bundle —
    // would throw instead. Simulate that here: encoding ADA_UNIT must not go
    // through Buffer.from('hex') on "lovelace" at all.
    const realFrom = Buffer.from.bind(Buffer);
    const strictFrom = ((input: unknown, encoding?: unknown) => {
      if (
        encoding === "hex" &&
        typeof input === "string" &&
        !/^[0-9a-fA-F]*$/.test(input)
      ) {
        throw new Error("strict hex decoder: invalid hex string");
      }
      return (realFrom as (...args: unknown[]) => Buffer)(input, encoding);
    }) as typeof Buffer.from;
    const spy = vi.spyOn(Buffer, "from").mockImplementation(strictFrom);

    try {
      expect(() => transformPoolDatum(adaPoolDatum)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
