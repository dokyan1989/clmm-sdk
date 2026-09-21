import { describe, expect, it } from "vitest";
import { KeyHash, ScriptHash, UTxO } from "@evolution-sdk/evolution";
import DanogoClmm from "../src/sdk.js";

const OUT_REF = `${"a".repeat(64)}#0`;
const SCRIPT_HASH = "26ec271e96420bd548932f350e76ea38590da68e12f0f55bd5473f67";
const OTHER_SCRIPT_HASH = "fa991bc2f9c4206e72d713bc3487a72e7901057cabb8d364bebeef8f";

const utxoAt = (
  paymentCredential: ReturnType<typeof ScriptHash.fromHex> | ReturnType<typeof KeyHash.fromHex>,
): UTxO.UTxO => ({ address: { paymentCredential } }) as unknown as UTxO.UTxO;

const check = (utxo: UTxO.UTxO, expectedHash: string) =>
  (
    new DanogoClmm() as unknown as {
      assertProtocolConfigMatches: (
        utxo: UTxO.UTxO,
        scriptHash: string,
        outRef: string,
      ) => void;
    }
  ).assertProtocolConfigMatches(utxo, expectedHash, OUT_REF);

describe("protocol config UTxO vs. configured protocol config script hash", () => {
  it("passes when the UTxO sits at the configured script address", () => {
    expect(() => check(utxoAt(ScriptHash.fromHex(SCRIPT_HASH)), SCRIPT_HASH)).not.toThrow();
  });

  it("refuses a UTxO locked by a different script", () => {
    expect(() => check(utxoAt(ScriptHash.fromHex(OTHER_SCRIPT_HASH)), SCRIPT_HASH)).toThrow(
      `Protocol config ${OUT_REF} is not locked by`,
    );
  });

  it("refuses a UTxO at a plain key-hash address (not a script at all)", () => {
    expect(() => check(utxoAt(KeyHash.fromHex("11".repeat(28))), SCRIPT_HASH)).toThrow(
      `Protocol config ${OUT_REF} is not locked by`,
    );
  });
});
