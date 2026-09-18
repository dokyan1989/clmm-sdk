import { describe, expect, it } from "vitest";
import type { UTxO } from "@evolution-sdk/evolution";
import type {
  BatchRedeemerBuilder,
  IndexedInput,
} from "@evolution-sdk/evolution/sdk/builders/RedeemerBuilder";
import { swapTokensRedeemer } from "../src/redeemer.js";

const poolUtxo = (txId: string): UTxO.UTxO =>
  ({ transactionId: txId, index: 0n }) as unknown as UTxO.UTxO;

const POOL_A = poolUtxo("a".repeat(64));
const POOL_B = poolUtxo("b".repeat(64));
const POOL_C = poolUtxo("c".repeat(64));

const indexed = (utxo: UTxO.UTxO, index: number): IndexedInput => ({
  index,
  utxo,
});

const toSigned256 = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value >= 1n << 255n ? value - (1n << 256n) : value;
};

const parsePayload = (payload: unknown) => {
  const bytes = payload as Uint8Array;
  const entries: Array<{ poolIn: number; poolOut: number; delta: bigint }> = [];
  for (let pos = 2; pos < bytes.length; pos += 34) {
    entries.push({
      poolIn: bytes[pos],
      poolOut: bytes[pos + 1],
      delta: toSigned256(bytes.slice(pos + 2, pos + 34)),
    });
  }
  return { inIndex: bytes[0], action: bytes[1], entries };
};

const resolve = (
  target: UTxO.UTxO | null,
  indexedInputs: IndexedInput[],
  deltaAmounts: bigint[],
  protocolConfigIdx = 0n,
  poolOutputIndices = [0, 1, 2],
) => {
  const builder = swapTokensRedeemer(
    target,
    [POOL_A, POOL_B, POOL_C],
    deltaAmounts,
    poolOutputIndices,
    protocolConfigIdx,
  ) as BatchRedeemerBuilder;
  return parsePayload(builder.all(indexedInputs));
};

describe("swap redeemer pool params", () => {
  // As the transaction builder hands them over: ascending by input index.
  const indexedInputs = [
    indexed(POOL_B, 2),
    indexed(POOL_C, 5),
    indexed(POOL_A, 7),
  ];
  const deltaAmounts = [100n, -200n, 300n];

  it("orders params by pool input index, not by request order", () => {
    const { entries } = resolve(null, indexedInputs, deltaAmounts);

    expect(entries.map((entry) => entry.poolIn)).toEqual([2, 5, 7]);
  });

  it("keeps each param's output index and delta bound to its own pool", () => {
    const { entries } = resolve(null, indexedInputs, deltaAmounts);

    expect(entries).toEqual([
      { poolIn: 2, poolOut: 1, delta: -200n },
      { poolIn: 5, poolOut: 2, delta: 300n },
      { poolIn: 7, poolOut: 0, delta: 100n },
    ]);
  });

  it("names the output index it is given rather than the pool's request position", () => {
    const { entries } = resolve(
      null,
      indexedInputs,
      deltaAmounts,
      0n,
      [5, 6, 7],
    );

    // Still sorted by input index (2, 5, 7 → pools B, C, A), each carrying the
    // output index supplied for that pool.
    expect(entries.map((entry) => entry.poolOut)).toEqual([6, 7, 5]);
  });

  it("refuses a pool with no output index in the transaction", () => {
    expect(() => resolve(null, indexedInputs, deltaAmounts, 0n, [0, -1, 1])).toThrow(
      /Pool UTxO at 1 has no output index/,
    );
  });

  it("heads the withdrawal redeemer with the protocol config index", () => {
    const { inIndex, action } = resolve(null, indexedInputs, deltaAmounts, 4n);

    expect(inIndex).toBe(4);
    expect(action).toBe(3);
  });

  it("heads a spend redeemer with its own pool's input index", () => {
    const { inIndex } = resolve(POOL_C, indexedInputs, deltaAmounts, 4n);

    expect(inIndex).toBe(5);
  });
});
