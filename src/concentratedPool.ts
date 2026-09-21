import { MultiAsset } from "./multiAssets.js";

export interface ConcentratedPool {
  outRef: string;
  address: string;
  coin: bigint;
  multiAssets: MultiAsset[];
  validityNft: string;
  tokenA: string;
  tokenAReserve: bigint;
  tokenB: string;
  tokenBReserve: bigint;
  lpFeeRate: number;
  priceLowerNum: bigint;
  priceLowerDen: bigint;
  priceUpperNum: bigint;
  priceUpperDen: bigint;
  platformFeeA: bigint;
  platformFeeB: bigint;
  minAChange: bigint;
  minBChange: bigint;
  lpTokenTotalSupply: bigint;
  lastWithdrawEpoch: number;
  totalSwapFee: bigint;
}


export interface SwapRequest {
  pools: {
    /** "txHash#index" of the pool's own UTxO. */
    poolOutRef: string;
    /** Signed input amount: positive sells tokenX (buys tokenY), negative sells tokenY (buys tokenX). */
    deltaAmount: bigint;
    /** Minimum output accepted from this pool. Use `0n` to swap at any price. */
    minOutChangeAmount: bigint;
    /** Reference UTxO for the pool's own staking script; required only if it still owes this epoch's reward claim. */
    stakingOutRef?: string;
  }[];
  /** Current Cardano epoch. Defaults to this machine's clock; pass the chain's own epoch if you have it, to avoid clock skew near a boundary. */
  currentEpoch?: number;
}


export interface QuoteSwapRequest {
  pools: {
    /** "txHash#index" of the pool's own UTxO. */
    poolOutRef: string;
    /** Signed input amount: positive sells tokenX (buys tokenY), negative sells tokenY (buys tokenX). */
    deltaAmount: bigint;
    /** Reference UTxO for the pool's own staking script; required only if it still owes this epoch's reward claim. */
    stakingOutRef?: string;
  }[];
  /** See {@link SwapRequest.currentEpoch}. */
  currentEpoch?: number;
}