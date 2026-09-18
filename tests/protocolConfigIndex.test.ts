import { describe, expect, it } from "vitest";
import { TransactionHash, TransactionInput } from "@evolution-sdk/evolution";
import { getPoolProtocolConfigIdx, outRefKey } from "../src/utils.js";

const ref = (id: string, index: bigint) =>
  new TransactionInput.TransactionInput({
    transactionId: TransactionHash.fromHex(id.repeat(32)),
    index,
  });

const CONFIG = ref("bb", 0n);
const POOL_SCRIPT = ref("dd", 0n);
const STAKING = ref("aa", 0n);

describe("protocol config reference-input index", () => {
  it("indexes by the ledger's canonical order, not insertion order", () => {
    // Added config first, but "aa" sorts ahead of it.
    expect(
      getPoolProtocolConfigIdx(CONFIG, [CONFIG, POOL_SCRIPT, STAKING]),
    ).toBe(1n);
  });

  it("orders several references from the same transaction by output index", () => {
    const first = ref("cc", 1n);
    const second = ref("cc", 2n);
    // 10n must sort after 2n; a string comparison would put it first.
    const tenth = ref("cc", 10n);

    expect(getPoolProtocolConfigIdx(tenth, [tenth, second, first])).toBe(2n);
  });

  it("finds the config by output reference rather than by object identity", () => {
    // What the built transaction hands back: equal references, different objects.
    const rebuilt = ref("bb", 0n);

    expect(rebuilt).not.toBe(CONFIG);
    expect(getPoolProtocolConfigIdx(CONFIG, [STAKING, rebuilt])).toBe(1n);
  });

  it("refuses to guess when the config is absent", () => {
    expect(() => getPoolProtocolConfigIdx(CONFIG, [STAKING, POOL_SCRIPT])).toThrow(
      /not found in reference inputs/,
    );
  });

  it("keys a reference by its output reference", () => {
    expect(outRefKey(ref("aa", 3n))).toBe(`${"aa".repeat(32)}#3`);
  });

  it("gives the index the transaction settles on once duplicates collapse", () => {
    // Two pools sharing a staking script queue it twice; the transaction holds one.
    const queued = [CONFIG, POOL_SCRIPT, STAKING, STAKING];
    const deduped = [
      ...new Map(queued.map((input) => [outRefKey(input), input])).values(),
    ];

    expect(getPoolProtocolConfigIdx(CONFIG, queued)).toBe(2n);
    expect(getPoolProtocolConfigIdx(CONFIG, deduped)).toBe(1n);
  });
});
