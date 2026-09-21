import { NetworkId, TransactionHash, TransactionInput, UTxO } from "@evolution-sdk/evolution";
import { ADA_UNIT, EPOCH_LENGTH_MAINNET, EPOCH_LENGTH_PREPROD } from "./constants.js";
import { PoolDatum } from "./datum.js";

/** @internal */
export const getEpoch = (t: number, network: NetworkId.NetworkId): number => {
  let epochLength = EPOCH_LENGTH_MAINNET;
  // A known (timestamp ms, epoch) reference point; epoch = boundary epoch +
  // elapsed epochs since then.
  const epochBoundary = 1647899091000;
  const epochBoundaryAsEpoch = 328;
  if (network !== 1) {
    epochLength = EPOCH_LENGTH_PREPROD;
  }

  return Math.floor((t - epochBoundary) / epochLength) + epochBoundaryAsEpoch;
};

/** Returns the possibly-shrunk deltaAmount (see getPoolChange) alongside the swap's output and fee. @internal */
export function calculateConcentratedPoolSwap(
  tokenAAmount: bigint,
  tokenBAmount: bigint,
  datum: PoolDatum,
  deltaAmount: bigint,
  rewardAmount: bigint = 0n,
  platformFeeRate: bigint
): { deltaAmount: bigint; outputAmount: bigint; platformFee: bigint } {
  const poolInAmount = deltaAmount < 0n ? -deltaAmount : deltaAmount;
  const excludedADA: bigint = datum.tokenX === ADA_UNIT ? 3_000_000n + BigInt(datum.totalSwapFee) : 0n;
  const activeReserveX =
    BigInt(tokenAAmount) - BigInt(datum.platformFeeX) + rewardAmount - excludedADA;
  const activeReserveY = BigInt(tokenBAmount) - BigInt(datum.platformFeeY);

  const liquidity = calcLiquidity(
    activeReserveX,
    activeReserveY,
    [BigInt(datum.sqrtLowerPriceNum), BigInt(datum.sqrtLowerPriceDen)],
    [BigInt(datum.sqrtUpperPriceNum), BigInt(datum.sqrtUpperPriceDen)]
  );
  const xV =
    ceilDiv(
      liquidity[0] * BigInt(datum.sqrtUpperPriceDen),
      liquidity[1] * BigInt(datum.sqrtUpperPriceNum)
    ) + activeReserveX;
  const yV =
    ceilDiv(
      liquidity[0] * BigInt(datum.sqrtLowerPriceNum),
      liquidity[1] * BigInt(datum.sqrtLowerPriceDen)
    ) + activeReserveY;

  const sign = deltaAmount > 0n ? 1n : -1n;
  const [actualIn, outputAmount, platformFee] =
    deltaAmount > 0n
      ? getPoolChange(
          poolInAmount,
          xV,
          yV,
          activeReserveY,
          BigInt(datum.lpFeeRate),
          platformFeeRate
        )
      : getPoolChange(
          poolInAmount,
          yV,
          xV,
          activeReserveX,
          BigInt(datum.lpFeeRate),
          platformFeeRate
        );

  return { deltaAmount: sign * actualIn, outputAmount, platformFee };
}

/**
 * Bonding-curve output with LP fee. When the naive output would meet or
 * exceed the pool's real reserve, caps it there and back-computes the
 * smaller input that actually produces it, instead of refusing the trade.
 * Platform fee is charged on the amount actually taken, not offered.
 * @internal
 */
const getPoolChange = (
  amountIn: bigint,
  tokenInVirtual: bigint,
  tokenOutVirtual: bigint,
  tokenOutReal: bigint,
  lpFeeRate: bigint,
  platformFeeRate: bigint
): [bigint, bigint, bigint] => {
  const BASE = 10_000n;
  const offFee = BASE - lpFeeRate;

  // Real reserve can be zero (or negative, for a corrupt datum) — e.g. an ADA
  // pool whose reserve is entirely tied up in the excluded min-ADA/fee
  // amount. Nothing to cap down to, so reject rather than build a tx that
  // can only fail on-chain. Distinct from a merely tiny amountIn rounding an
  // otherwise-healthy (uncapped) output down to zero, which stays valid.
  if (tokenOutReal <= 0n) {
    throw new Error("pool out exceeded");
  }

  // main math
  const denominator = tokenInVirtual * BASE + amountIn * offFee;
  const virtualProduct = tokenInVirtual * tokenOutVirtual;

  const numerator = tokenOutVirtual * denominator - virtualProduct * BASE;
  const expectedOut = numerator / denominator;

  let actualIn = amountIn;
  let actualOut = expectedOut;
  if (expectedOut >= tokenOutReal) {
    actualOut = tokenOutReal;
    actualIn = ceilDiv(
      tokenInVirtual * actualOut * BASE,
      (tokenOutVirtual - actualOut) * offFee
    );
  }

  // Rounded once over the whole product, as the reference implementation does.
  // Rounding the LP fee first and the platform's share of it second costs a
  // unit whenever both divisions leave a remainder.
  const platformFee = (actualIn * lpFeeRate * platformFeeRate) / (BASE * BASE);

  return [actualIn, actualOut, platformFee];
};

/** @internal */
const calcLiquidity = (
  x: bigint,
  y: bigint,
  pa: [bigint, bigint],
  pb: [bigint, bigint]
): [bigint, bigint] => {
  const denAdenB = pa[1] * pb[1];
  const numAnumB = pa[0] * pb[0];

  const diffSquare =
    (y * denAdenB - x * numAnumB) * (y * denAdenB - x * numAnumB);
  const xy4Term = 4n * x * y * pa[1] * pa[1] * pb[0] * pb[0];
  const bigSqrtInNumerator = sqrtBigInt(diffSquare + xy4Term);
  const numerator = y * denAdenB + x * numAnumB + bigSqrtInNumerator;
  const denominator = 2n * (pb[0] * pa[1] - pb[1] * pa[0]);
  return [numerator, denominator];
};

function sqrtBigInt(value: bigint): bigint {
  if (value < 0n) {
    throw new Error("Square root of negative number");
  }
  if (value < 2n) {
    return value;
  }
  let x0 = value;
  let x1 = (x0 + value / x0) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) >> 1n;
  }
  return x0;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("Division by zero");

  const q = a / b;
  const r = a % b;

  // If a and b have the same sign and remainder is non-zero, add 1n
  return r === 0n || a < 0n !== b < 0n ? q : q + 1n;
}

/** Anything carrying an output reference: a UTxO before the transaction is built, a TransactionInput after. */
interface HasOutRef {
  transactionId: TransactionHash.TransactionHash;
  index: bigint;
}

/** @internal */
export const outRefKey = (input: HasOutRef): string =>
  `${TransactionHash.toHex(input.transactionId)}#${input.index}`;

const compareOutRefs = (a: HasOutRef, b: HasOutRef): number => {
  const aId = TransactionHash.toHex(a.transactionId);
  const bId = TransactionHash.toHex(b.transactionId);
  if (aId !== bId) return aId < bId ? -1 : 1;
  if (a.index === b.index) return 0;
  return a.index < b.index ? -1 : 1;
};

/** @internal */
export function getPoolProtocolConfigIdx(
  protocolConfigUTxO: HasOutRef,
  refInputs: ReadonlyArray<HasOutRef>,
): bigint {
  // The validator reads reference inputs in the ledger's canonical order, not
  // the order they were added in.
  const sortedInputs = [...refInputs].sort(compareOutRefs);
  const wanted = outRefKey(protocolConfigUTxO);
  const idx = sortedInputs.findIndex((input) => outRefKey(input) === wanted);
  if (idx === -1) {
    throw new Error("Protocol config out ref not found in reference inputs");
  }
  return BigInt(idx);
}

/** @internal */
export function calculateMultiPoolSwap(
  pools: Array<{
    tokenAAmount: bigint;
    tokenBAmount: bigint;
    datum: PoolDatum;
    rewardAmount: bigint;
  }>,
  deltaAmounts: bigint[],
  platformFeeRate: bigint
): Array<{ poolIndex: number; deltaAmount: bigint; outputAmount: bigint; platformFee: bigint }> {
  const results: Array<{ poolIndex: number; deltaAmount: bigint; outputAmount: bigint; platformFee: bigint }> = [];

  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    const deltaAmount = deltaAmounts[i];

    if (deltaAmount === 0n) continue;

    // adjustedDeltaAmount may be smaller in magnitude than the requested
    // deltaAmount (same sign) when the pool's reserve capped the swap.
    const {
      deltaAmount: adjustedDeltaAmount,
      outputAmount,
      platformFee,
    } = calculateConcentratedPoolSwap(
      pool.tokenAAmount,
      pool.tokenBAmount,
      pool.datum,
      deltaAmount,
      pool.rewardAmount,
      platformFeeRate
    );

    results.push({
      poolIndex: i,
      deltaAmount: adjustedDeltaAmount,
      outputAmount,
      platformFee
    });
  }

  return results;
}

/** @internal */
export const toEvoOutRef = (
  outRefString: string,
): TransactionInput.TransactionInput | undefined => {
  if (!outRefString) return undefined;
  const [txId, index] = outRefString.split("#");
  return new TransactionInput.TransactionInput({
    transactionId: TransactionHash.fromHex(txId),
    index: BigInt(index),
  });
};