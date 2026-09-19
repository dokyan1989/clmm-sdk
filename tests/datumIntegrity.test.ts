import { describe, expect, it, vi } from "vitest";
import {
  Address,
  Assets,
  Data,
  DatumHash,
  ScriptHash,
  TransactionHash,
  TransactionInput,
  UTxO,
} from "@evolution-sdk/evolution";
import type { SigningClient } from "@evolution-sdk/evolution/sdk/client/Client";
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

const poolDatum: PoolDatum = {
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
  minXChange: 1n,
  minYChange: 1n,
  circulatingLPToken: 997_000_000n,
  lastWithdrawEpoch: 640,
};
const POOL_DATUM_DATA = transformPoolDatum(poolDatum).data;
const POOL_DATUM_HASH = Data.toDatumHash(POOL_DATUM_DATA);

// What a compromised or buggy provider might hand back for that hash: data
// for a different, more favorable pool state than the one actually on chain.
const TAMPERED_DATUM_DATA = transformPoolDatum({
  ...poolDatum,
  lpFeeRate: 0,
}).data;

const configUtxo = (): UTxO.UTxO =>
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(CONFIG_TX),
    index: 0n,
    address: new Address.Address({
      networkId: 1,
      paymentCredential: ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
    }),
    assets: Assets.fromLovelace(5_000_000n),
    datumOption: new InlineDatum({
      data: Data.constr(0n, [3_000n, 2_000_000n]),
    }),
  });

const poolUtxoWithHashDatum = (): UTxO.UTxO => {
  const nft = getPolicyIdAssetNameFromUnit(
    `${POOL_SCRIPT_HASH_MAINNET}.${NFT_NAME}`,
  );
  const tokenY = getPolicyIdAssetNameFromUnit(TOKEN_Y);
  return new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(POOL_TX),
    index: 0n,
    address: new Address.Address({
      networkId: 1,
      paymentCredential: ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
    }),
    assets: Assets.merge(
      Assets.fromAsset(nft.policyId!, nft.assetName!, 1n, 10_000_000n),
      Assets.fromAsset(tokenY.policyId!, tokenY.assetName!, 20_000_000n),
    ),
    datumOption: POOL_DATUM_HASH,
  });
};

describe("datum hash integrity", () => {
  it("rejects data from getDatum that does not actually hash to the UTxO's datum hash", async () => {
    const client = {
      address: async () => ({ networkId: 1 }),
      getUtxosByOutRef: async (refs: TransactionInput.TransactionInput[]) => {
        const txId = TransactionHash.toHex(refs[0].transactionId);
        if (txId === POOL_TX) return [poolUtxoWithHashDatum()];
        if (txId === CONFIG_TX) return [configUtxo()];
        return [];
      },
      // A malicious or buggy provider: returns data for the requested hash,
      // but it isn't actually the data that hashes to it.
      getDatum: vi.fn(async () => TAMPERED_DATUM_DATA),
    } as unknown as SigningClient;

    await expect(
      new DanogoClmm().calculateSwapOut(client, {
        pools: [{ poolOutRef: POOL_OUT_REF, deltaAmount: 500_000n }],
      }),
    ).rejects.toThrow(/datum hash mismatch/);
  });

  it("accepts data from getDatum that hashes to the UTxO's datum hash", async () => {
    const client = {
      address: async () => ({ networkId: 1 }),
      getUtxosByOutRef: async (refs: TransactionInput.TransactionInput[]) => {
        const txId = TransactionHash.toHex(refs[0].transactionId);
        if (txId === POOL_TX) return [poolUtxoWithHashDatum()];
        if (txId === CONFIG_TX) return [configUtxo()];
        return [];
      },
      getDatum: vi.fn(async (hash: DatumHash.DatumHash) => {
        if (DatumHash.toHex(hash) === DatumHash.toHex(POOL_DATUM_HASH)) {
          return POOL_DATUM_DATA;
        }
        throw new Error("unexpected hash");
      }),
    } as unknown as SigningClient;

    const result = await new DanogoClmm().calculateSwapOut(client, {
      pools: [{ poolOutRef: POOL_OUT_REF, deltaAmount: 500_000n }],
    });
    expect(result[0]).toBeGreaterThan(0n);
  });
});
