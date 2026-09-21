import { AssetName, PolicyId, UTxO } from "@evolution-sdk/evolution";
import { quantityOf } from "@evolution-sdk/evolution/Assets";
import * as ScriptHash from "@evolution-sdk/evolution/ScriptHash";
import { fromScript, toHex as toScriptHashHex } from "@evolution-sdk/evolution/ScriptHash";
import * as TxOut from "@evolution-sdk/evolution/TxOut";
import { PoolDatum } from "./datum.js";

/** poolScriptOutRef and poolScriptHash are separate constants kept in sync by hand; this catches them drifting apart. @internal */
export function assertPoolScriptMatches(
  poolScriptUtxo: UTxO.UTxO,
  scriptHash: string,
  outRef: string,
): ScriptHash.ScriptHash {
  if (!poolScriptUtxo.scriptRef) {
    throw new Error(`Pool script reference ${outRef} carries no script.`);
  }
  const credential = fromScript(poolScriptUtxo.scriptRef);
  const resolvedHash = toScriptHashHex(credential);
  if (resolvedHash !== scriptHash) {
    throw new Error(
      `Pool script reference ${outRef} resolves to ${resolvedHash}, but the configured pool script hash is ${scriptHash}.`,
    );
  }
  return credential;
}

/** Same rationale as assertPoolScriptMatches — protocolScriptOutRef/protocolConfigScriptHash are also hand-kept constants. @internal */
export function assertProtocolConfigMatches(
  protocolConfigUtxo: UTxO.UTxO,
  scriptHash: string,
  outRef: string,
): void {
  const credential = protocolConfigUtxo.address.paymentCredential;
  if (
    credential._tag !== "ScriptHash" ||
    toScriptHashHex(credential) !== scriptHash
  ) {
    throw new Error(
      `Protocol config ${outRef} is not locked by the expected script ${scriptHash}.`,
    );
  }
}

/**
 * The redeemer tells the validator which output re-creates each pool, and that
 * index is decided before the transaction is assembled. This re-reads the built
 * transaction to confirm each pool's validity NFT really did land where its
 * redeemer says, rather than trusting the ordering to hold.
 * @internal
 */
export function assertPoolOutputsAt(
  outputs: readonly TxOut.TransactionOutput[],
  pools: { validityNft: AssetName.AssetName; outRef: string }[],
  outputIndices: number[],
  scriptHash: string,
): void {
  const policyId = PolicyId.fromHex(scriptHash);

  pools.forEach((pool, index) => {
    const outputIndex = outputIndices[index];
    if (outputIndex < 0) return;

    const output = outputs[outputIndex];
    const held = output
      ? quantityOf(output.assets, policyId, pool.validityNft)
      : 0n;
    if (held !== 1n) {
      throw new Error(
        `Pool ${pool.outRef} is declared at output ${outputIndex} of the built transaction, but that output does not hold its validity NFT.`,
      );
    }
  });
}

/** Below its minimum the validator moves the pool by that minimum instead, taking more from the wallet than the caller offered. @internal */
export function assertMeetsPoolMinimum(
  datum: PoolDatum,
  deltaAmount: bigint,
  outRef: string,
): void {
  const offered = deltaAmount > 0n ? deltaAmount : -deltaAmount;
  const minimum = deltaAmount > 0n ? datum.minXChange : datum.minYChange;
  if (offered < minimum) {
    throw new Error(
      `Pool ${outRef} moves at least ${minimum} at a time, but the request offers ${offered}.`,
    );
  }
}

/** An omitted floor leaves the swap with no price protection at all, which is an oversight rather than a choice; `0n` says it on purpose. @internal */
export function assertSlippageFloors(
  pools: readonly { poolOutRef: string; minOutChangeAmount?: bigint }[],
): void {
  pools.forEach((pool, index) => {
    if (pool.minOutChangeAmount === undefined) {
      throw new Error(
        `Pool ${index} (${pool.poolOutRef}) has no minOutChangeAmount. Set the least output you accept, or 0n to swap at any price.`,
      );
    }
    if (pool.minOutChangeAmount < 0n) {
      throw new Error(
        `Pool ${index} (${pool.poolOutRef}) has a negative minOutChangeAmount.`,
      );
    }
  });
}

/** A zero-delta pool is dropped from the swap results, desyncing the pool indices the redeemer is built from. @internal */
export function assertNonZeroDeltas(
  pools: readonly { poolOutRef: string; deltaAmount: bigint }[],
): void {
  pools.forEach((pool, index) => {
    if (pool.deltaAmount === 0n) {
      throw new Error(
        `Pool ${index} (${pool.poolOutRef}) has deltaAmount 0. Remove it from the request instead.`,
      );
    }
  });
}

/** @internal */
export function assertStakingRefMatches(
  stakingRefUtxo: UTxO.UTxO,
  stakingCredential: ScriptHash.ScriptHash,
  outRef: string,
): void {
  if (!stakingRefUtxo.scriptRef) {
    throw new Error(
      `Staking reference for pool ${outRef} carries no script.`,
    );
  }
  const referenced = toScriptHashHex(fromScript(stakingRefUtxo.scriptRef));
  const expected = toScriptHashHex(stakingCredential);
  if (referenced !== expected) {
    throw new Error(
      `Staking reference for pool ${outRef} holds script ${referenced}, but the pool delegates to ${expected}.`,
    );
  }
}
