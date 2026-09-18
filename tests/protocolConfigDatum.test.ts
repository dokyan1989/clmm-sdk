import { describe, expect, it } from "vitest";
import { Data } from "@evolution-sdk/evolution";
import { parseProtocolConfigDatum } from "../src/datum.js";

const datumOf = (...fields: Data.Data[]) => Data.constr(0n, fields);

describe("protocol config datum", () => {
  it("parses a well-formed config", () => {
    expect(parseProtocolConfigDatum(datumOf(3_000n, 2_000_000n))).toEqual({
      platformFeeRate: 3_000n,
      swapFee: 2_000_000n,
    });
  });

  it("accepts the basis-point boundaries", () => {
    expect(parseProtocolConfigDatum(datumOf(0n, 0n)).platformFeeRate).toBe(0n);
    expect(parseProtocolConfigDatum(datumOf(10_000n, 0n)).platformFeeRate).toBe(
      10_000n,
    );
  });

  it("rejects a platformFeeRate above one hundred percent of the LP fee", () => {
    expect(() => parseProtocolConfigDatum(datumOf(10_001n, 2_000_000n))).toThrow(
      /platformFeeRate must be between 0 and 10000/,
    );
  });

  it("rejects a negative platformFeeRate", () => {
    expect(() => parseProtocolConfigDatum(datumOf(-1n, 2_000_000n))).toThrow(
      /platformFeeRate must be between 0 and 10000/,
    );
  });

  it("rejects a negative swapFee, which would drain the pool", () => {
    expect(() => parseProtocolConfigDatum(datumOf(3_000n, -1n))).toThrow(
      /swapFee must not be negative/,
    );
  });

  it("rejects a truncated datum", () => {
    expect(() => parseProtocolConfigDatum(datumOf(3_000n))).toThrow(
      /at least 2 fields, got 1/,
    );
  });

  it("rejects non-integer fields instead of coercing them", () => {
    const bytes = new Uint8Array([1, 2, 3]);

    expect(() => parseProtocolConfigDatum(datumOf(bytes, 2_000_000n))).toThrow(
      /platformFeeRate must be an integer/,
    );
    expect(() => parseProtocolConfigDatum(datumOf(3_000n, bytes))).toThrow(
      /swapFee must be an integer/,
    );
  });

  it("rejects an empty list where an integer belongs", () => {
    // BigInt([]) is 0n, so a bare coercion would silently read a zero fee here.
    expect(() => parseProtocolConfigDatum(datumOf([], 2_000_000n))).toThrow(
      /platformFeeRate must be an integer/,
    );
  });
});
