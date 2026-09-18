import { describe, expect, it } from "vitest";
import {
  Address,
  Assets,
  Data,
  ScriptHash,
  SigningClient,
  TransactionHash,
  TransactionInput,
  UTxO,
} from "@evolution-sdk/evolution";
import { InlineDatum } from "@evolution-sdk/evolution/InlineDatum";
import DanogoClmm from "../src/sdk.js";
import {
  ADA_UNIT,
  POOL_SCRIPT_HASH_MAINNET,
  PROTOCOL_CONFIG_OUT_REF_MAINNET,
} from "../src/constants.js";
import { transformPoolDatum, type PoolDatum } from "../src/datum.js";
import { getPolicyIdAssetNameFromUnit } from "../src/multiAssets.js";

const POOL_TX = "a".repeat(64);
const POOL_OUT_REF = `${POOL_TX}#0`;
const CONFIG_TX = PROTOCOL_CONFIG_OUT_REF_MAINNET.split("#")[0];
const TOKEN_Y =
  "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456.55534441";
const NFT_NAME = "aabbccdd";

const MIN_X = 1_000_000n;
const MIN_Y = 2_000_000n;

/** Thrown once the request has cleared validation and reached the swap maths. */
const PAST_VALIDATION = /Expected swap output at least/;

const datum: PoolDatum = {
  tokenX: ADA_UNIT,
  tokenY: TOKEN_Y,
  sqrtLowerPriceNum: 4472135954999579n,
  sqrtLowerPriceDen: 10000000000000000n,
  sqrtUpperPriceNum: 6324555320336759n,
  sqrtUpperPriceDen: 10000000000000000n,
  lpFeeRate: 30,
  platformFeeX: 0n,
  platformFeeY: 0n,
  totalSwapFee: 0n,
  minXChange: MIN_X,
  minYChange: MIN_Y,
  circulatingLPToken: 997_000_000n,
  lastWithdrawEpoch: 640,
};

const utxoAt = (txId: string, assets: Assets.Assets, datumOption?: InlineDatum) =>
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(txId),
    index: 0n,
    address: new Address.Address({
      networkId: 1,
      paymentCredential: ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
    }),
    assets,
    datumOption,
  });

const poolUtxo = () => {
  const nft = getPolicyIdAssetNameFromUnit(
    `${POOL_SCRIPT_HASH_MAINNET}.${NFT_NAME}`,
  );
  const tokenY = getPolicyIdAssetNameFromUnit(TOKEN_Y);
  return utxoAt(
    POOL_TX,
    Assets.merge(
      Assets.fromAsset(nft.policyId!, nft.assetName!, 1n, 10_000_000n),
      Assets.fromAsset(tokenY.policyId!, tokenY.assetName!, 20_000_000n),
    ),
    transformPoolDatum(datum),
  );
};

const client = (): SigningClient =>
  ({
    address: async () => ({ networkId: 1 }),
    getUtxosByOutRef: async (refs: TransactionInput.TransactionInput[]) => {
      const txId = TransactionHash.toHex(refs[0].transactionId);
      if (txId === POOL_TX) return [poolUtxo()];
      if (txId === CONFIG_TX) {
        return [
          utxoAt(
            CONFIG_TX,
            Assets.fromLovelace(5_000_000n),
            new InlineDatum({ data: Data.constr(0n, [3_000n, 2_000_000n]) }),
          ),
        ];
      }
      return [utxoAt("c".repeat(64), Assets.fromLovelace(5_000_000n))];
    },
  }) as unknown as SigningClient;

const swap = (deltaAmount: bigint) =>
  new DanogoClmm().submitSwap(client(), {
    pools: [
      {
        poolOutRef: POOL_OUT_REF,
        deltaAmount,
        // Forces a deterministic stop once the minimum has been checked.
        minOutChangeAmount: 10n ** 18n,
      },
    ],
  });

const quote = (deltaAmount: bigint) =>
  new DanogoClmm().calculateSwapOut(client(), {
    pools: [{ poolOutRef: POOL_OUT_REF, deltaAmount }],
  });

describe("pool minimum change", () => {
  it("refuses a sell of X below the pool's minXChange", async () => {
    await expect(swap(MIN_X - 1n)).rejects.toThrow(
      `Pool ${POOL_OUT_REF} moves at least ${MIN_X} at a time, but the request offers ${MIN_X - 1n}`,
    );
  });

  it("refuses a sell of Y below the pool's minYChange", async () => {
    await expect(swap(-(MIN_Y - 1n))).rejects.toThrow(
      `moves at least ${MIN_Y} at a time, but the request offers ${MIN_Y - 1n}`,
    );
  });

  it("holds each side to its own minimum", async () => {
    // Fine as a sell of X, short as a sell of Y.
    await expect(swap(MIN_X)).rejects.toThrow(PAST_VALIDATION);
    await expect(swap(-MIN_X)).rejects.toThrow(/moves at least/);
  });

  it("accepts an amount above the minimum", async () => {
    await expect(swap(MIN_X * 2n)).rejects.toThrow(PAST_VALIDATION);
  });

  it("holds quotes to the same minimum as swaps", async () => {
    await expect(quote(MIN_X - 1n)).rejects.toThrow(/moves at least/);
    await expect(quote(MIN_X)).resolves.toHaveLength(1);
  });
});
