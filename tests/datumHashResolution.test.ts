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
const CONFIG_DATUM_DATA = Data.constr(0n, [3_000n, 2_000_000n]);
/** Real Danogo pool and protocol-config UTxOs carry a datum hash, not inline data — this is that shape. */
const POOL_DATUM_HASH = Data.toDatumHash(POOL_DATUM_DATA);
const CONFIG_DATUM_HASH = Data.toDatumHash(CONFIG_DATUM_DATA);

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

const configUtxoWithHashDatum = (): UTxO.UTxO =>
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(CONFIG_TX),
    index: 0n,
    address: new Address.Address({
      networkId: 1,
      paymentCredential: ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
    }),
    assets: Assets.fromLovelace(5_000_000n),
    datumOption: CONFIG_DATUM_HASH,
  });

const getDatum = vi.fn(async (hash: DatumHash.DatumHash) => {
  if (DatumHash.toHex(hash) === DatumHash.toHex(POOL_DATUM_HASH)) return POOL_DATUM_DATA;
  if (DatumHash.toHex(hash) === DatumHash.toHex(CONFIG_DATUM_HASH)) return CONFIG_DATUM_DATA;
  throw new Error(`getDatum called with an unexpected hash: ${DatumHash.toHex(hash)}`);
});

const client = (): SigningClient =>
  ({
    address: async () => ({ networkId: 1 }),
    getUtxosByOutRef: async (refs: TransactionInput.TransactionInput[]) => {
      const txId = TransactionHash.toHex(refs[0].transactionId);
      if (txId === POOL_TX) return [poolUtxoWithHashDatum()];
      if (txId === CONFIG_TX) return [configUtxoWithHashDatum()];
      return [];
    },
    getDatum,
  }) as unknown as SigningClient;

describe("resolving a datum that the ledger stores as a hash", () => {
  it("quotes a pool whose datum is hash-referenced, matching the same pool inline", async () => {
    getDatum.mockClear();
    const sdk = new DanogoClmm();

    const hashResult = await sdk.calculateSwapOut(client(), {
      pools: [{ poolOutRef: POOL_OUT_REF, deltaAmount: 500_000n }],
    });

    expect(getDatum).toHaveBeenCalledTimes(2); // pool datum + protocol config datum
    expect(hashResult).toHaveLength(1);
    expect(hashResult[0]).toBeGreaterThan(0n);
  });

  it("calls getDatum with the exact hash the UTxO carries", async () => {
    getDatum.mockClear();
    await new DanogoClmm().calculateSwapOut(client(), {
      pools: [{ poolOutRef: POOL_OUT_REF, deltaAmount: 500_000n }],
    });

    const calledWith = getDatum.mock.calls.map(([hash]) => DatumHash.toHex(hash));
    expect(calledWith.sort()).toEqual(
      [DatumHash.toHex(POOL_DATUM_HASH), DatumHash.toHex(CONFIG_DATUM_HASH)].sort(),
    );
  });

  it("produces the same quote whether the datum arrived inline or by hash", async () => {
    getDatum.mockClear();
    const hashBased = await new DanogoClmm().calculateSwapOut(client(), {
      pools: [{ poolOutRef: POOL_OUT_REF, deltaAmount: 500_000n }],
    });

    const inlineClient = {
      address: async () => ({ networkId: 1 }),
      getUtxosByOutRef: async (refs: TransactionInput.TransactionInput[]) => {
        const txId = TransactionHash.toHex(refs[0].transactionId);
        if (txId === POOL_TX) {
          const utxo = poolUtxoWithHashDatum();
          return [
            new UTxO.UTxO({
              ...utxo,
              datumOption: new InlineDatum({ data: POOL_DATUM_DATA }),
            } as unknown as ConstructorParameters<typeof UTxO.UTxO>[0]),
          ];
        }
        if (txId === CONFIG_TX) {
          const utxo = configUtxoWithHashDatum();
          return [
            new UTxO.UTxO({
              ...utxo,
              datumOption: new InlineDatum({ data: CONFIG_DATUM_DATA }),
            } as unknown as ConstructorParameters<typeof UTxO.UTxO>[0]),
          ];
        }
        return [];
      },
    } as unknown as SigningClient;
    const inlineBased = await new DanogoClmm().calculateSwapOut(inlineClient, {
      pools: [{ poolOutRef: POOL_OUT_REF, deltaAmount: 500_000n }],
    });

    expect(hashBased).toEqual(inlineBased);
  });

  it("still refuses a UTxO with no datum at all", async () => {
    const noDatumClient = {
      address: async () => ({ networkId: 1 }),
      getUtxosByOutRef: async (refs: TransactionInput.TransactionInput[]) => {
        const txId = TransactionHash.toHex(refs[0].transactionId);
        if (txId === POOL_TX) {
          const utxo = poolUtxoWithHashDatum();
          return [
            new UTxO.UTxO({
              ...utxo,
              datumOption: undefined,
            } as unknown as ConstructorParameters<typeof UTxO.UTxO>[0]),
          ];
        }
        return [configUtxoWithHashDatum()];
      },
      getDatum,
    } as unknown as SigningClient;

    await expect(
      new DanogoClmm().calculateSwapOut(noDatumClient, {
        pools: [{ poolOutRef: POOL_OUT_REF, deltaAmount: 500_000n }],
      }),
    ).rejects.toThrow(/does not contain a datum/);
  });
});
