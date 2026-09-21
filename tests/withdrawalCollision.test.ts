import { describe, expect, it, vi } from "vitest";
import {
  Address,
  Assets,
  Credential,
  Data,
  ScriptHash,
  TransactionHash,
  TransactionInput,
  UTxO,
} from "@evolution-sdk/evolution";
import type { SigningClient } from "@evolution-sdk/evolution/sdk/client/Client";
import { InlineDatum } from "@evolution-sdk/evolution/InlineDatum";
import * as PlutusV3 from "@evolution-sdk/evolution/PlutusV3";
import { fromScript, toHex as toScriptHashHex } from "@evolution-sdk/evolution/ScriptHash";
import DanogoClmm from "../src/sdk.js";
import {
  ADA_UNIT,
  POOL_SCRIPT_HASH_MAINNET,
  POOL_SCRIPT_OUT_REF_MAINNET,
  PROTOCOL_CONFIG_OUT_REF_MAINNET,
  PROTOCOL_CONFIG_SCRIPT_HASH_MAINNET,
} from "../src/constants.js";

// This SDK now verifies the pool-script UTxO's real hash against
// POOL_SCRIPT_HASH_MAINNET, which no fixture bytes can be made to hash to.
// POOL_SCRIPT (bytes [1,2,3,4] below) stands in for that one fixed policy;
// SEPARATE_STAKE_SCRIPT ([9,9,9,9]) still hashes for real.
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
import { transformPoolDatum, type PoolDatum } from "../src/datum.js";
import { getEpoch } from "../src/utils.js";
import { getPolicyIdAssetNameFromUnit } from "../src/multiAssets.js";

const POOL_TX = "a".repeat(64);
const STAKING_TX = "b".repeat(64);
const POOL_OUT_REF = `${POOL_TX}#0`;
const STAKING_OUT_REF = `${STAKING_TX}#0`;
const POOL_SCRIPT_TX = POOL_SCRIPT_OUT_REF_MAINNET.split("#")[0];
const CONFIG_TX = PROTOCOL_CONFIG_OUT_REF_MAINNET.split("#")[0];
const TOKEN_Y =
  "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456.55534441";

/** The transaction builder stops here, once every withdrawal has been queued. */
const BUILD_REACHED = "BUILD_REACHED";

const POOL_SCRIPT = new PlutusV3.PlutusV3({ bytes: new Uint8Array([1, 2, 3, 4]) });
const SEPARATE_STAKE_SCRIPT = new PlutusV3.PlutusV3({
  bytes: new Uint8Array([9, 9, 9, 9]),
});

const poolDatum = (): PoolDatum => ({
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
  lastWithdrawEpoch: getEpoch(Date.now(), 1) - 1,
});

const poolUtxo = (stakingCredential: Credential.Credential): UTxO.UTxO => {
  const nft = getPolicyIdAssetNameFromUnit(
    `${POOL_SCRIPT_HASH_MAINNET}.aabbccdd`,
  );
  const tokenY = getPolicyIdAssetNameFromUnit(TOKEN_Y);
  return new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(POOL_TX),
    index: 0n,
    address: new Address.Address({
      networkId: 1,
      paymentCredential: ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
      stakingCredential,
    }),
    assets: Assets.merge(
      Assets.fromAsset(nft.policyId!, nft.assetName!, 1n, 10_000_000n),
      Assets.fromAsset(tokenY.policyId!, tokenY.assetName!, 20_000_000n),
    ),
    datumOption: transformPoolDatum(poolDatum()),
  });
};

const scriptUtxo = (txId: string, script: PlutusV3.PlutusV3): UTxO.UTxO =>
  new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(txId),
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
    transactionId: TransactionHash.fromHex(CONFIG_TX),
    index: 0n,
    address: new Address.Address({
      networkId: 1,
      paymentCredential: ScriptHash.fromHex(PROTOCOL_CONFIG_SCRIPT_HASH_MAINNET),
    }),
    assets: Assets.fromLovelace(5_000_000n),
    datumOption: new InlineDatum({ data: Data.constr(0n, [3_000n, 2_000_000n]) }),
  });

/** Records every withdrawal the SDK queues, then stops at build time. */
const recordingClient = (
  pool: UTxO.UTxO,
  stakeScript: PlutusV3.PlutusV3,
  rewards: bigint,
) => {
  const withdrawals: { credential: string; amount: bigint }[] = [];
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    readFrom: () => builder,
    payToAddress: () => builder,
    collectFrom: () => builder,
    attachMetadata: () => builder,
    setValidity: () => builder,
    withdraw: ({
      stakeCredential,
      amount,
    }: {
      stakeCredential: ScriptHash.ScriptHash;
      amount: bigint;
    }) => {
      withdrawals.push({ credential: toScriptHashHex(stakeCredential), amount });
      return builder;
    },
    build: async () => {
      throw new Error(BUILD_REACHED);
    },
  });

  const client = {
    address: async () => ({ networkId: 1 }),
    newTx: () => builder,
    getDelegation: async () => ({ rewards }),
    getUtxosByOutRef: async (refs: TransactionInput.TransactionInput[]) => {
      const txId = TransactionHash.toHex(refs[0].transactionId);
      if (txId === POOL_TX) return [pool];
      if (txId === POOL_SCRIPT_TX) return [scriptUtxo(POOL_SCRIPT_TX, POOL_SCRIPT)];
      if (txId === CONFIG_TX) return [configUtxo()];
      return [scriptUtxo(STAKING_TX, stakeScript)];
    },
  } as unknown as SigningClient;

  return { client, withdrawals };
};

const swap = (client: SigningClient) =>
  new DanogoClmm().submitSwap(client, {
    pools: [
      {
        poolOutRef: POOL_OUT_REF,
        deltaAmount: 500_000n,
        minOutChangeAmount: 0n,
        stakingOutRef: STAKING_OUT_REF,
      },
    ],
  });

describe("staking withdrawal that shares the pool script's reward account", () => {
  it("emits a separate withdrawal when the stake script is its own", async () => {
    const { client, withdrawals } = recordingClient(
      poolUtxo(fromScript(SEPARATE_STAKE_SCRIPT)),
      SEPARATE_STAKE_SCRIPT,
      1_500_000n,
    );

    await expect(swap(client)).rejects.toThrow(BUILD_REACHED);
    expect(withdrawals).toEqual([
      { credential: toScriptHashHex(fromScript(POOL_SCRIPT)), amount: 0n },
      {
        credential: toScriptHashHex(fromScript(SEPARATE_STAKE_SCRIPT)),
        amount: 1_500_000n,
      },
    ]);
  });

  it("does not queue a second entry for the account it already withdraws from", async () => {
    const { client, withdrawals } = recordingClient(
      poolUtxo(fromScript(POOL_SCRIPT)),
      POOL_SCRIPT,
      0n,
    );

    await expect(swap(client)).rejects.toThrow(BUILD_REACHED);
    expect(withdrawals).toEqual([
      { credential: toScriptHashHex(fromScript(POOL_SCRIPT)), amount: 0n },
    ]);
  });

  it("refuses when rewards are due on that shared account", async () => {
    const { client } = recordingClient(
      poolUtxo(fromScript(POOL_SCRIPT)),
      POOL_SCRIPT,
      1_500_000n,
    );

    await expect(swap(client)).rejects.toThrow(
      `Pool ${POOL_OUT_REF} delegates to its own spend script and has 1500000 lovelace of rewards`,
    );
  });
});
