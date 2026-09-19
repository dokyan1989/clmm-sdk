import { describe, expect, it } from "vitest";
import { Address, Data, KeyHash, ScriptHash } from "@evolution-sdk/evolution";
import type { Transaction } from "@cardano-ogmios/schema";
import DanogoClmm from "../src/sdk.js";
import { transformPoolDatum, type PoolDatum } from "../src/datum.js";
import { ADA_UNIT, POOL_SCRIPT_HASH_MAINNET } from "../src/constants.js";

const TOKEN_Y =
  "fe7c786ab321f41c654ef6c1af7b3250a613c24e4213e0425a7ae456.55534441";
const [TOKEN_Y_POLICY, TOKEN_Y_NAME] = TOKEN_Y.split(".");
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
const datumHex = Data.toCBORHex(transformPoolDatum(poolDatum).data);

// Anyone can send a real validity NFT (once minted, it's a freely transferable
// token) to any address they control, paired with an arbitrary datum.
const decoyAddress = Address.toBech32(
  new Address.Address({
    networkId: 1,
    paymentCredential: KeyHash.fromHex("11".repeat(28)),
  }),
);

const genuinePoolAddress = Address.toBech32(
  new Address.Address({
    networkId: 1,
    paymentCredential: ScriptHash.fromHex(POOL_SCRIPT_HASH_MAINNET),
  }),
);

const fakeOutput = (address: string) => ({
  address,
  value: {
    ada: { lovelace: 5_000_000n },
    [POOL_SCRIPT_HASH_MAINNET]: { [NFT_NAME]: 1n },
    [TOKEN_Y_POLICY]: { [TOKEN_Y_NAME]: 20_000_000n },
  },
  datum: datumHex,
});

const txWith = (address: string): Transaction =>
  ({
    id: "a".repeat(64),
    outputs: [fakeOutput(address)],
  }) as unknown as Transaction;

describe("getPoolsFromOgmiosTx authenticity", () => {
  it("ignores an output carrying the validity NFT but sitting at a different address", () => {
    const pools = new DanogoClmm().getPoolsFromOgmiosTx(txWith(decoyAddress), 1);
    expect(pools).toHaveLength(0);
  });

  it("still accepts the same output when it actually sits at the pool script address", () => {
    const pools = new DanogoClmm().getPoolsFromOgmiosTx(
      txWith(genuinePoolAddress),
      1,
    );
    expect(pools).toHaveLength(1);
    expect(pools[0].tokenA).toBe(ADA_UNIT);
  });
});
