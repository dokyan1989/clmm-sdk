import { describe, expect, it, vi } from "vitest";
import {
  Address,
  Assets,
  Data,
  ScriptHash,
  TransactionHash,
  TransactionInput,
  UTxO,
} from "@evolution-sdk/evolution";
import type { SigningClient } from "@evolution-sdk/evolution/sdk/client/Client";
import { InlineDatum } from "@evolution-sdk/evolution/InlineDatum";
import * as PlutusV3 from "@evolution-sdk/evolution/PlutusV3";
import { fromScript } from "@evolution-sdk/evolution/ScriptHash";
import DanogoClmm from "../src/sdk.js";
import {
  ADA_UNIT,
  POOL_SCRIPT_HASH_MAINNET,
  POOL_SCRIPT_OUT_REF_MAINNET,
  PROTOCOL_CONFIG_OUT_REF_MAINNET,
} from "../src/constants.js";

// This SDK now verifies the pool-script UTxO's real hash against
// POOL_SCRIPT_HASH_MAINNET, which no fixture bytes can be made to hash to.
// POOL_SCRIPT (bytes [1,2,3,4] below) stands in for that one fixed policy;
// STAKE_SCRIPT ([9,9,9,9]) still hashes for real.
vi.mock("@evolution-sdk/evolution/ScriptHash", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@evolution-sdk/evolution/ScriptHash")>();
  return {
    ...actual,
    fromScript: (script: unknown) => {
      const bytes = (script as { bytes?: Uint8Array }).bytes;
      if (bytes && bytes.length === 4 && bytes[0] === 1 && bytes[1] === 2) {
        return actual.fromHex(POOL_SCRIPT_HASH_MAINNET);
      }
      return actual.fromScript(script as never);
    },
  };
});
import { parseDatum, transformPoolDatum, type PoolDatum } from "../src/datum.js";
import { getEpoch } from "../src/utils.js";
import { getPolicyIdAssetNameFromUnit } from "../src/multiAssets.js";

const POOL_TX = "a".repeat(64);
const POOL_OUT_REF = `${POOL_TX}#0`;
const POOL_SCRIPT_TX = POOL_SCRIPT_OUT_REF_MAINNET.split("#")[0];
const CONFIG_TX = PROTOCOL_CONFIG_OUT_REF_MAINNET.split("#")[0];
const TOKEN_Y =
  "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456.55534441";

const CLOCK_EPOCH = getEpoch(Date.now(), 1);
const BUILD_REACHED = "BUILD_REACHED";

const POOL_SCRIPT = new PlutusV3.PlutusV3({ bytes: new Uint8Array([1, 2, 3, 4]) });
const STAKE_SCRIPT = new PlutusV3.PlutusV3({ bytes: new Uint8Array([9, 9, 9, 9]) });

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

const utxoAt = (
  txId: string,
  assets: Assets.Assets,
  extras: {
    datumOption?: InlineDatum;
    scriptRef?: PlutusV3.PlutusV3;
    stakingCredential?: ScriptHash.ScriptHash;
  } = {},
) =>
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(txId),
    index: 0n,
    address: new Address.Address({
      networkId: 1,
      paymentCredential: ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
      stakingCredential: extras.stakingCredential,
    }),
    assets,
    datumOption: extras.datumOption,
    scriptRef: extras.scriptRef,
  });

const poolUtxo = (lastWithdrawEpoch: number) => {
  const nft = getPolicyIdAssetNameFromUnit(
    `${POOL_SCRIPT_HASH_MAINNET}.aabbccdd`,
  );
  const tokenY = getPolicyIdAssetNameFromUnit(TOKEN_Y);
  return utxoAt(
    POOL_TX,
    Assets.merge(
      Assets.fromAsset(nft.policyId!, nft.assetName!, 1n, 10_000_000n),
      Assets.fromAsset(tokenY.policyId!, tokenY.assetName!, 20_000_000n),
    ),
    {
      datumOption: transformPoolDatum(poolDatum(lastWithdrawEpoch)),
      stakingCredential: fromScript(STAKE_SCRIPT),
    },
  );
};

/** Captures the datum the pool is re-created with, then stops at build time. */
const recordingClient = (pool: UTxO.UTxO) => {
  const datums: PoolDatum[] = [];
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    readFrom: () => builder,
    withdraw: () => builder,
    collectFrom: () => builder,
    attachMetadata: () => builder,
    setValidity: () => builder,
    payToAddress: ({ datum }: { datum: InlineDatum }) => {
      datums.push(parseDatum(datum.data));
      return builder;
    },
    build: async () => {
      throw new Error(BUILD_REACHED);
    },
  });

  const client = {
    address: async () => ({ networkId: 1 }),
    newTx: () => builder,
    getDelegation: async () => ({ rewards: 0n }),
    getUtxosByOutRef: async (refs: TransactionInput.TransactionInput[]) => {
      const txId = TransactionHash.toHex(refs[0].transactionId);
      if (txId === POOL_TX) return [pool];
      if (txId === POOL_SCRIPT_TX) {
        return [
          utxoAt(POOL_SCRIPT_TX, Assets.fromLovelace(5_000_000n), {
            scriptRef: POOL_SCRIPT,
          }),
        ];
      }
      if (txId === CONFIG_TX) {
        return [
          utxoAt(CONFIG_TX, Assets.fromLovelace(5_000_000n), {
            datumOption: new InlineDatum({
              data: Data.constr(0n, [3_000n, 2_000_000n]),
            }),
          }),
        ];
      }
      return [
        utxoAt("b".repeat(64), Assets.fromLovelace(5_000_000n), {
          scriptRef: STAKE_SCRIPT,
        }),
      ];
    },
  } as unknown as SigningClient;

  return { client, datums };
};

const swap = (
  pool: UTxO.UTxO,
  currentEpoch?: number,
  stakingOutRef?: string,
) => {
  const { client, datums } = recordingClient(pool);
  return {
    datums,
    run: new DanogoClmm().submitSwap(client, {
      pools: [
        {
          poolOutRef: POOL_OUT_REF,
          deltaAmount: 500_000n,
          minOutChangeAmount: 0n,
          stakingOutRef,
        },
      ],
      currentEpoch,
    }),
  };
};

describe("current epoch", () => {
  it("writes the supplied epoch into the pool datum", async () => {
    const supplied = CLOCK_EPOCH + 5;
    const { datums, run } = swap(
      poolUtxo(CLOCK_EPOCH - 1),
      supplied,
      `${"b".repeat(64)}#0`,
    );

    await expect(run).rejects.toThrow(BUILD_REACHED);
    expect(datums).toHaveLength(1);
    expect(datums[0].lastWithdrawEpoch).toBe(supplied);
  });

  it("falls back to this machine's clock when none is supplied", async () => {
    const { datums, run } = swap(
      poolUtxo(CLOCK_EPOCH - 1),
      undefined,
      `${"b".repeat(64)}#0`,
    );

    await expect(run).rejects.toThrow(BUILD_REACHED);
    expect(datums[0].lastWithdrawEpoch).toBe(CLOCK_EPOCH);
  });

  it("lets the supplied epoch decide whether a staking claim is owed", async () => {
    // The clock says a claim is due; the chain, one epoch behind, says it is not.
    const pool = poolUtxo(CLOCK_EPOCH - 1);

    await expect(swap(pool, undefined).run).rejects.toThrow(
      /Provide its stakingOutRef/,
    );
    await expect(swap(pool, CLOCK_EPOCH - 1).run).rejects.toThrow(BUILD_REACHED);
  });

  it("refuses an epoch that is not a whole non-negative number", async () => {
    for (const bad of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(swap(poolUtxo(CLOCK_EPOCH - 1), bad).run).rejects.toThrow(
        /currentEpoch must be a non-negative whole number/,
      );
    }
  });
});
