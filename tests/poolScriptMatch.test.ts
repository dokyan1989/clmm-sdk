import { describe, expect, it } from "vitest";
import { UTxO } from "@evolution-sdk/evolution";
import * as PlutusV3 from "@evolution-sdk/evolution/PlutusV3";
import { fromScript, toHex as toScriptHashHex } from "@evolution-sdk/evolution/ScriptHash";
import { assertPoolScriptMatches } from "../src/assertions.js";

const OUT_REF = `${"a".repeat(64)}#0`;

const SCRIPT = new PlutusV3.PlutusV3({ bytes: new Uint8Array([1, 2, 3, 4]) });
const OTHER_SCRIPT = new PlutusV3.PlutusV3({ bytes: new Uint8Array([9, 9, 9, 9]) });

// Both sides of the comparison are derived from the same real hash function
// here, so this needs no fixture that hashes to a specific literal value.
const SCRIPT_HASH = toScriptHashHex(fromScript(SCRIPT));

const utxoWithScript = (scriptRef?: PlutusV3.PlutusV3): UTxO.UTxO =>
  ({ scriptRef }) as unknown as UTxO.UTxO;

const check = (utxo: UTxO.UTxO, expectedHash: string) =>
  assertPoolScriptMatches(utxo, expectedHash, OUT_REF);

describe("pool script reference vs. configured pool script hash", () => {
  it("passes when the referenced script hashes to the configured constant", () => {
    expect(() => check(utxoWithScript(SCRIPT), SCRIPT_HASH)).not.toThrow();
  });

  it("catches poolScriptOutRef and poolScriptHash having drifted out of sync", () => {
    expect(() => check(utxoWithScript(OTHER_SCRIPT), SCRIPT_HASH)).toThrow(
      `Pool script reference ${OUT_REF} resolves to`,
    );
  });

  it("refuses a reference that carries no script at all", () => {
    expect(() => check(utxoWithScript(undefined), SCRIPT_HASH)).toThrow(
      `Pool script reference ${OUT_REF} carries no script.`,
    );
  });
});
