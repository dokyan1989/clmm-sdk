import { describe, expect, it } from "vitest";
import { Address, AssetName, Assets, ScriptHash } from "@evolution-sdk/evolution";
import * as TxOut from "@evolution-sdk/evolution/TxOut";
import { assertPoolOutputsAt } from "../src/assertions.js";
import { POOL_SCRIPT_HASH_MAINNET } from "../src/constants.js";
import { getPolicyIdAssetNameFromUnit } from "../src/multiAssets.js";

const POOL_A_OUT_REF = `${"a".repeat(64)}#0`;
const POOL_B_OUT_REF = `${"b".repeat(64)}#0`;
const NFT_A = "aabbccdd";
const NFT_B = "11223344";

const nftName = (name: string): AssetName.AssetName =>
  getPolicyIdAssetNameFromUnit(`${POOL_SCRIPT_HASH_MAINNET}.${name}`).assetName!;

/** Built the way the transaction builder hands outputs back. */
const outputWith = (assets: Assets.Assets): TxOut.TransactionOutput =>
  new TxOut.TransactionOutput({
    address: new Address.Address({
      networkId: 1,
      paymentCredential: ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
    }),
    assets,
  });

const outputHolding = (nft: string): TxOut.TransactionOutput => {
  const { policyId } = getPolicyIdAssetNameFromUnit(
    `${POOL_SCRIPT_HASH_MAINNET}.${NFT_A}`,
  );
  return outputWith(
    Assets.fromAsset(policyId!, nftName(nft), 1n, 8_000_000n),
  );
};

const walletOutput = (): TxOut.TransactionOutput =>
  outputWith(Assets.fromLovelace(5_000_000n));

const poolA = { validityNft: nftName(NFT_A), outRef: POOL_A_OUT_REF };
const poolB = { validityNft: nftName(NFT_B), outRef: POOL_B_OUT_REF };

const verify = (
  outputs: TxOut.TransactionOutput[],
  pools: { validityNft: AssetName.AssetName; outRef: string }[],
  indices: number[],
) => assertPoolOutputsAt(outputs, pools, indices, POOL_SCRIPT_HASH_MAINNET);

describe("pool output index in the built transaction", () => {
  it("passes when each pool's NFT sits where its redeemer says", () => {
    const outputs = [outputHolding(NFT_A), outputHolding(NFT_B), walletOutput()];

    expect(() => verify(outputs, [poolA, poolB], [0, 1])).not.toThrow();
  });

  it("catches outputs shifted by something added ahead of the pools", () => {
    const outputs = [walletOutput(), outputHolding(NFT_A), outputHolding(NFT_B)];

    expect(() => verify(outputs, [poolA, poolB], [0, 1])).toThrow(
      `Pool ${POOL_A_OUT_REF} is declared at output 0`,
    );
  });

  it("catches two pools' outputs swapped with each other", () => {
    const outputs = [outputHolding(NFT_B), outputHolding(NFT_A)];

    expect(() => verify(outputs, [poolA, poolB], [0, 1])).toThrow(
      `Pool ${POOL_A_OUT_REF} is declared at output 0`,
    );
  });

  it("catches an index past the end of the outputs", () => {
    const outputs = [outputHolding(NFT_A)];

    expect(() => verify(outputs, [poolA], [3])).toThrow(
      `Pool ${POOL_A_OUT_REF} is declared at output 3`,
    );
  });

  it("skips a pool that contributes no output", () => {
    const outputs = [outputHolding(NFT_B)];

    expect(() => verify(outputs, [poolA, poolB], [-1, 0])).not.toThrow();
  });
});
