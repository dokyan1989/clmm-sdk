import { describe, expect, it } from "vitest";
import { Data } from "@evolution-sdk/evolution";
import { InlineDatum } from "@evolution-sdk/evolution/InlineDatum";
import { parseDatum, transformPoolDatum, type PoolDatum } from "../src/datum.js";
import { ADA_UNIT } from "../src/constants.js";

const TOKEN_Y =
  "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456.55534441";

const datum: PoolDatum = {
  tokenX: ADA_UNIT,
  tokenY: TOKEN_Y,
  sqrtLowerPriceNum: 4472135954999579n,
  sqrtLowerPriceDen: 10000000000000000n,
  sqrtUpperPriceNum: 6324555320336759n,
  sqrtUpperPriceDen: 10000000000000000n,
  lpFeeRate: 30,
  platformFeeX: 104495n,
  platformFeeY: 6826n,
  totalSwapFee: 2_200_000n,
  minXChange: 1n,
  minYChange: 1n,
  circulatingLPToken: 997_000_000n,
  lastWithdrawEpoch: 640,
};

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));

/** The on-chain field list, in order, so individual fields can be bent out of shape. */
const fields = (): Data.Data[] => [
  [new Uint8Array(0), new Uint8Array(0)],
  [hex(TOKEN_Y.slice(0, 56)), hex(TOKEN_Y.slice(57))],
  30n,
  104495n,
  6826n,
  2_200_000n,
  Data.constr(0n, [4472135954999579n, 10000000000000000n]),
  Data.constr(0n, [6324555320336759n, 10000000000000000n]),
  1n,
  1n,
  997_000_000n,
  640n,
];

const asDatum = (data: Data.Data) => new InlineDatum({ data });

describe("pool datum", () => {
  it("round-trips a datum the SDK itself encoded", () => {
    expect(parseDatum(transformPoolDatum(datum))).toEqual(datum);
  });

  it("parses the hand-built field list identically", () => {
    expect(parseDatum(asDatum(Data.constr(0n, fields())))).toEqual(datum);
  });

  it("rejects a closed pool's constructor", () => {
    expect(() => parseDatum(asDatum(Data.constr(1n, [])))).toThrow(
      /must be constructor 0/,
    );
  });

  it("rejects a datum carrying more fields than it knows how to re-encode", () => {
    // What an options-carrying pool datum would look like: re-encoding this as
    // twelve fields would drop the rest on the floor.
    const wide = Data.constr(0n, [...fields(), 0n, 0n]);

    expect(() => parseDatum(asDatum(wide))).toThrow(
      /must have 12 fields, got 14/,
    );
  });

  it("rejects a truncated datum instead of reading a missing epoch as NaN", () => {
    const short = Data.constr(0n, fields().slice(0, 11));

    expect(() => parseDatum(asDatum(short))).toThrow(
      /must have 12 fields, got 11/,
    );
  });

  it("rejects a non-integer field instead of coercing it to zero", () => {
    // Number([]) is 0 and BigInt([]) is 0n, so a bare coercion would read these
    // as a zero fee rate and a zero epoch.
    const bentRate = fields();
    bentRate[2] = [];
    const bentEpoch = fields();
    bentEpoch[11] = [];

    expect(() => parseDatum(asDatum(Data.constr(0n, bentRate)))).toThrow(
      /lpFeeRate must be an integer/,
    );
    expect(() => parseDatum(asDatum(Data.constr(0n, bentEpoch)))).toThrow(
      /lastWithdrawEpoch must be an integer/,
    );
  });

  it("rejects a non-integer inside a price ratio", () => {
    const bentRatio = fields();
    bentRatio[6] = Data.constr(0n, [[], 10000000000000000n]);

    expect(() => parseDatum(asDatum(Data.constr(0n, bentRatio)))).toThrow(
      /sqrtLowerPrice numerator must be an integer/,
    );
  });
});
