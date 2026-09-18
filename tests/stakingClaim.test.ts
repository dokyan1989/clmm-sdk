import { describe, expect, it } from "vitest";
import {
  Address,
  Assets,
  Credential,
  Data,
  ScriptHash,
  SigningClient,
  TransactionHash,
  UTxO,
} from "@evolution-sdk/evolution";
import { InlineDatum } from "@evolution-sdk/evolution/InlineDatum";
import * as PlutusV3 from "@evolution-sdk/evolution/PlutusV3";
import { fromScript } from "@evolution-sdk/evolution/ScriptHash";
import DanogoClmm from "../src/sdk.js";
import { ADA_UNIT, POOL_SCRIPT_HASH_MAINNET } from "../src/constants.js";
import { transformPoolDatum, type PoolDatum } from "../src/datum.js";
import { getEpoch } from "../src/utils.js";
import { getPolicyIdAssetNameFromUnit } from "../src/multiAssets.js";

const POOL_OUT_REF = `${"a".repeat(64)}#0`;
const STAKING_OUT_REF = `${"b".repeat(64)}#0`;
const TOKEN_Y =
  "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456.55534441";
const NFT_NAME = "aabbccdd";

const CURRENT_EPOCH = getEpoch(Date.now(), 1);

/** The pool's own staking sub-validator. */
const POOL_STAKING_SCRIPT = new PlutusV3.PlutusV3({
  bytes: new Uint8Array([1, 2, 3, 4]),
});
const POOL_STAKING_HASH = fromScript(POOL_STAKING_SCRIPT);

/** Some other script a caller might point stakingOutRef at. */
const FOREIGN_STAKING_SCRIPT = new PlutusV3.PlutusV3({
  bytes: new Uint8Array([9, 9, 9, 9]),
});

const poolDatum = (lastWithdrawEpoch: number): PoolDatum => ({
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
  lastWithdrawEpoch,
});

const poolAssets = (): Assets.Assets => {
  const nft = getPolicyIdAssetNameFromUnit(
    `${POOL_SCRIPT_HASH_MAINNET}.${NFT_NAME}`,
  );
  const tokenY = getPolicyIdAssetNameFromUnit(TOKEN_Y);
  return Assets.merge(
    Assets.fromAsset(nft.policyId!, nft.assetName!, 1n, 10_000_000n),
    Assets.fromAsset(tokenY.policyId!, tokenY.assetName!, 20_000_000n),
  );
};

const poolUtxo = (
  lastWithdrawEpoch: number,
  stakingCredential?: Credential.Credential,
): UTxO.UTxO =>
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex("a".repeat(64)),
    index: 0n,
    address: new Address.Address({
      networkId: 1,
      paymentCredential: ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
      stakingCredential,
    }),
    assets: poolAssets(),
    datumOption: transformPoolDatum(poolDatum(lastWithdrawEpoch)),
  });

const scriptUtxo = (script?: PlutusV3.PlutusV3): UTxO.UTxO =>
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex("c".repeat(64)),
    index: 0n,
    address: new Address.Address({
      networkId: 1,
      paymentCredential: ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
    }),
    assets: Assets.fromLovelace(5_000_000n),
    scriptRef: script,
  });

const configUtxo = (): UTxO.UTxO =>
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex("d".repeat(64)),
    index: 0n,
    address: new Address.Address({
      networkId: 1,
      paymentCredential: ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
    }),
    assets: Assets.fromLovelace(5_000_000n),
    datumOption: new InlineDatum({ data: Data.constr(0n, [3_000n, 2_000_000n]) }),
  });

/** Serves pool, pool script, protocol config, then the staking reference, in the order submitSwap asks for them. */
const clientFor = (pool: UTxO.UTxO, staking: UTxO.UTxO): SigningClient => {
  let fetches = 0;
  return {
    address: async () => ({ networkId: 1 }),
    getUtxosByOutRef: async () => {
      fetches += 1;
      if (fetches === 1) return [pool];
      if (fetches === 2) return [scriptUtxo()];
      if (fetches === 3) return [configUtxo()];
      return [staking];
    },
    getDelegation: async () => ({ rewards: 1_500_000n }),
  } as unknown as SigningClient;
};

const swap = (
  pool: UTxO.UTxO,
  opts: { stakingOutRef?: string; staking?: UTxO.UTxO } = {},
) =>
  new DanogoClmm().submitSwap(
    clientFor(pool, opts.staking ?? scriptUtxo(POOL_STAKING_SCRIPT)),
    {
      pools: [
        {
          poolOutRef: POOL_OUT_REF,
          deltaAmount: 500_000n,
          stakingOutRef: opts.stakingOutRef,
          // Forces a deterministic stop after the staking logic has run.
          minOutChangeAmount: 10n ** 18n,
        },
      ],
    },
  );

describe("per-epoch staking claim", () => {
  it("refuses to swap without the staking reference when a claim is due", async () => {
    await expect(swap(poolUtxo(CURRENT_EPOCH - 1, POOL_STAKING_HASH))).rejects.toThrow(
      /has not claimed its staking rewards this epoch.*Provide its stakingOutRef/s,
    );
  });

  it("refuses a staking reference holding a script the pool does not delegate to", async () => {
    await expect(
      swap(poolUtxo(CURRENT_EPOCH - 1, POOL_STAKING_HASH), {
        stakingOutRef: STAKING_OUT_REF,
        staking: scriptUtxo(FOREIGN_STAKING_SCRIPT),
      }),
    ).rejects.toThrow(/but the pool delegates to/);
  });

  it("refuses a staking reference that carries no script at all", async () => {
    await expect(
      swap(poolUtxo(CURRENT_EPOCH - 1, POOL_STAKING_HASH), {
        stakingOutRef: STAKING_OUT_REF,
        staking: scriptUtxo(),
      }),
    ).rejects.toThrow(/carries no script/);
  });

  it("accepts the staking reference the pool actually delegates to", async () => {
    await expect(
      swap(poolUtxo(CURRENT_EPOCH - 1, POOL_STAKING_HASH), {
        stakingOutRef: STAKING_OUT_REF,
      }),
    ).rejects.toThrow(/Expected swap output at least/);
  });

  it("needs no staking reference once this epoch's claim has been made", async () => {
    await expect(swap(poolUtxo(CURRENT_EPOCH, POOL_STAKING_HASH))).rejects.toThrow(
      /Expected swap output at least/,
    );
  });

  it("needs no staking reference for a pool with no stake credential", async () => {
    await expect(swap(poolUtxo(CURRENT_EPOCH - 1))).rejects.toThrow(
      /Expected swap output at least/,
    );
  });
});
