import { describe, expect, it } from "vitest";
import {
  Address,
  Assets,
  KeyHash,
  ScriptHash,
  SigningClient,
  TransactionHash,
  UTxO,
} from "@evolution-sdk/evolution";
import DanogoClmm from "../src/sdk.js";
import { POOL_SCRIPT_HASH_MAINNET } from "../src/constants.js";
import { getPolicyIdAssetNameFromUnit } from "../src/multiAssets.js";

const POOL_OUT_REF = `${"a".repeat(64)}#0`;
const OTHER_HASH = "d8b69fc53637bcfadbc4469083f706bc293f4d9d2296646c5ca1ffff";
const NFT_NAME = "aabbccdd";

/** Thrown by the next UTxO fetch, so reaching it proves the pool passed validation. */
const PAST_VALIDATION = "PAST_POOL_VALIDATION";

const nft = (policyHex: string, quantity: bigint): Assets.Assets => {
  const { policyId, assetName } = getPolicyIdAssetNameFromUnit(
    `${policyHex}.${NFT_NAME}`,
  );
  return Assets.fromAsset(policyId!, assetName!, quantity, 8_000_000n);
};

const poolUtxo = (
  paymentCredential: Address.Address["paymentCredential"],
  assets: Assets.Assets,
): UTxO.UTxO =>
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex("a".repeat(64)),
    index: 0n,
    address: new Address.Address({ networkId: 1, paymentCredential }),
    assets,
  });

const clientServing = (utxo: UTxO.UTxO): SigningClient => {
  let fetches = 0;
  return {
    address: async () => ({ networkId: 1 }),
    getUtxosByOutRef: async () => {
      fetches += 1;
      if (fetches === 1) return [utxo];
      throw new Error(PAST_VALIDATION);
    },
  } as unknown as SigningClient;
};

const swap = (utxo: UTxO.UTxO) =>
  new DanogoClmm().submitSwap(clientServing(utxo), {
    pools: [
      { poolOutRef: POOL_OUT_REF, deltaAmount: 500_000n, minOutChangeAmount: 1n },
    ],
  });

describe("pool UTxO authenticity", () => {
  it("rejects a UTxO sitting at a wallet address", async () => {
    const utxo = poolUtxo(
      KeyHash.fromHex(OTHER_HASH),
      nft(POOL_SCRIPT_HASH_MAINNET, 1n),
    );

    await expect(swap(utxo)).rejects.toThrow(
      `Pool input ${POOL_OUT_REF} is not locked by the pool script`,
    );
  });

  it("rejects a UTxO locked by some other script", async () => {
    const utxo = poolUtxo(
      ScriptHash.fromHex(OTHER_HASH),
      nft(POOL_SCRIPT_HASH_MAINNET, 1n),
    );

    await expect(swap(utxo)).rejects.toThrow(
      `Pool input ${POOL_OUT_REF} is not locked by the pool script`,
    );
  });

  it("rejects a decoy parked at the pool address without the validity NFT", async () => {
    const utxo = poolUtxo(
      ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
      nft(OTHER_HASH, 1n),
    );

    await expect(swap(utxo)).rejects.toThrow(
      `Pool input ${POOL_OUT_REF} carries no validity NFT`,
    );
  });

  it("rejects a token of the pool policy that is not a single-quantity NFT", async () => {
    const utxo = poolUtxo(
      ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
      nft(POOL_SCRIPT_HASH_MAINNET, 2n),
    );

    await expect(swap(utxo)).rejects.toThrow(
      `Pool input ${POOL_OUT_REF} carries no validity NFT`,
    );
  });

  it("accepts a UTxO at the pool address carrying its validity NFT", async () => {
    const utxo = poolUtxo(
      ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
      nft(POOL_SCRIPT_HASH_MAINNET, 1n),
    );

    await expect(swap(utxo)).rejects.toThrow(PAST_VALIDATION);
  });
});
