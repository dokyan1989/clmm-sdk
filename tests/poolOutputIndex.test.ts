import { describe, expect, it } from "vitest";
import {
  AssetName,
  MultiAsset,
  TransactionOutput,
  Value,
} from "@evolution-sdk/evolution";
import DanogoClmm from "../src/sdk.js";
import { POOL_SCRIPT_HASH_MAINNET } from "../src/constants.js";
import { getPolicyIdAssetNameFromUnit } from "../src/multiAssets.js";

const POOL_A_OUT_REF = `${"a".repeat(64)}#0`;
const POOL_B_OUT_REF = `${"b".repeat(64)}#0`;
const NFT_A = "aabbccdd";
const NFT_B = "11223344";

const nftName = (name: string): AssetName.AssetName =>
  getPolicyIdAssetNameFromUnit(`${POOL_SCRIPT_HASH_MAINNET}.${name}`).assetName!;

const outputHolding = (
  ...nfts: string[]
): TransactionOutput.TransactionOutput => {
  const { policyId } = getPolicyIdAssetNameFromUnit(
    `${POOL_SCRIPT_HASH_MAINNET}.${NFT_A}`,
  );
  const assets = nfts.reduce(
    (acc, name) => MultiAsset.addAsset(acc, policyId!, nftName(name), 1n),
    MultiAsset.empty(),
  );
  return {
    amount: Value.withAssets(8_000_000n, assets),
  } as TransactionOutput.TransactionOutput;
};

const walletOutput = (): TransactionOutput.TransactionOutput =>
  ({ amount: Value.onlyCoin(5_000_000n) }) as TransactionOutput.TransactionOutput;

const poolA = { validityNft: nftName(NFT_A), outRef: POOL_A_OUT_REF };
const poolB = { validityNft: nftName(NFT_B), outRef: POOL_B_OUT_REF };

const verify = (
  outputs: TransactionOutput.TransactionOutput[],
  pools: { validityNft: AssetName.AssetName; outRef: string }[],
  indices: number[],
) =>
  (
    new DanogoClmm() as unknown as {
      assertPoolOutputsAt: (
        outputs: TransactionOutput.TransactionOutput[],
        pools: { validityNft: AssetName.AssetName; outRef: string }[],
        indices: number[],
        scriptHash: string,
      ) => void;
    }
  ).assertPoolOutputsAt(outputs, pools, indices, POOL_SCRIPT_HASH_MAINNET);

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
