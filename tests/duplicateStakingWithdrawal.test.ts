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
import { fromScript, toHex as toScriptHashHex } from "@evolution-sdk/evolution/ScriptHash";
import DanogoClmm from "../src/sdk.js";
import {
  ADA_UNIT,
  POOL_SCRIPT_HASH_MAINNET,
  POOL_SCRIPT_OUT_REF_MAINNET,
  PROTOCOL_CONFIG_OUT_REF_MAINNET,
} from "../src/constants.js";

// Same fixture-hash workaround as withdrawalCollision.test.ts: the pool
// script UTxO is checked against the real POOL_SCRIPT_HASH_MAINNET, which no
// fixture bytes can be made to hash to.
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

const POOL_TX_A = "a".repeat(64);
const POOL_TX_B = "c".repeat(64);
const STAKING_TX = "b".repeat(64);
const POOL_OUT_REF_A = `${POOL_TX_A}#0`;
const POOL_OUT_REF_B = `${POOL_TX_B}#0`;
const STAKING_OUT_REF = `${STAKING_TX}#0`;
const POOL_SCRIPT_TX = POOL_SCRIPT_OUT_REF_MAINNET.split("#")[0];
const CONFIG_TX = PROTOCOL_CONFIG_OUT_REF_MAINNET.split("#")[0];
const TOKEN_Y =
  "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456.55534441";

const BUILD_REACHED = "BUILD_REACHED";

const POOL_SCRIPT = new PlutusV3.PlutusV3({ bytes: new Uint8Array([1, 2, 3, 4]) });
// Two different pools that both delegate to this one, unrelated staking
// script — distinct from the pool script itself.
const SHARED_STAKE_SCRIPT = new PlutusV3.PlutusV3({
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

const poolUtxo = (txId: string, nftName: string): UTxO.UTxO => {
  const nft = getPolicyIdAssetNameFromUnit(`${POOL_SCRIPT_HASH_MAINNET}.${nftName}`);
  const tokenY = getPolicyIdAssetNameFromUnit(TOKEN_Y);
  return new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(txId),
    index: 0n,
    address: new Address.Address({
      networkId: 1,
      paymentCredential: ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
      stakingCredential: fromScript(SHARED_STAKE_SCRIPT),
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
      paymentCredential: ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
    }),
    assets: Assets.fromLovelace(5_000_000n),
    datumOption: new InlineDatum({ data: Data.constr(0n, [3_000n, 2_000_000n]) }),
  });

/** Records every withdrawal the SDK queues, then stops at build time. */
const recordingClient = (rewards: bigint) => {
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
      if (txId === POOL_TX_A) return [poolUtxo(POOL_TX_A, "aabbccdd")];
      if (txId === POOL_TX_B) return [poolUtxo(POOL_TX_B, "eeff0011")];
      if (txId === POOL_SCRIPT_TX) return [scriptUtxo(POOL_SCRIPT_TX, POOL_SCRIPT)];
      if (txId === CONFIG_TX) return [configUtxo()];
      return [scriptUtxo(STAKING_TX, SHARED_STAKE_SCRIPT)];
    },
  } as unknown as SigningClient;

  return { client, withdrawals };
};

const swap = (client: SigningClient) =>
  new DanogoClmm().submitSwap(client, {
    pools: [
      {
        poolOutRef: POOL_OUT_REF_A,
        deltaAmount: 500_000n,
        minOutChangeAmount: 0n,
        stakingOutRef: STAKING_OUT_REF,
      },
      {
        poolOutRef: POOL_OUT_REF_B,
        deltaAmount: 500_000n,
        minOutChangeAmount: 0n,
        stakingOutRef: STAKING_OUT_REF,
      },
    ],
  });

describe("two pools sharing one staking script in the same swap", () => {
  it("refuses instead of queueing two withdrawals against the same reward account", async () => {
    const { client } = recordingClient(1_500_000n);

    await expect(swap(client)).rejects.toThrow(
      /shares its staking credential with another pool in this swap/,
    );
  });
});
