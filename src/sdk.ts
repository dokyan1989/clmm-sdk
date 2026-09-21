import { Transaction } from "@cardano-ogmios/schema";
import {
  AssetName,
  Data,
  DatumHash,
  PolicyId,
  RewardAccount,
  RewardAddress,
  UTxO,
} from "@evolution-sdk/evolution";
import { getPaymentCredential } from "@evolution-sdk/evolution/Address";
import {
  fromAsset,
  flatten,
  merge,
  quantityOf,
  fromLovelace,
  subtractLovelace,
} from "@evolution-sdk/evolution/Assets";
import { toHex } from "@evolution-sdk/evolution/Bytes32";
import { toHex as toCredentialHex } from "@evolution-sdk/evolution/Credential";
import * as ScriptHash from "@evolution-sdk/evolution/ScriptHash";
import { toHex as toScriptHashHex } from "@evolution-sdk/evolution/ScriptHash";
import { SigningTransactionBuilder } from "@evolution-sdk/evolution/sdk/builders/TransactionBuilder";
import type { SigningClient } from "@evolution-sdk/evolution/sdk/client/Client";
import {
  assertMeetsPoolMinimum,
  assertNonZeroDeltas,
  assertPoolOutputsAt,
  assertPoolScriptMatches,
  assertProtocolConfigMatches,
  assertSlippageFloors,
  assertStakingRefMatches,
} from "./assertions.js";
import {
  ConcentratedPool,
  QuoteSwapRequest,
  SwapRequest,
} from "./concentratedPool.js";
import { ADA_UNIT, getNetworkConfig } from "./constants.js";
import {
  PoolDatum,
  parseDatum,
  parseProtocolConfigDatum,
  tokenIdToTuple,
  transformPoolDatum,
} from "./datum.js";
import {
  buildMultiAssetsFromAssets,
  getPolicyIdAssetNameFromUnit,
  MultiAsset,
} from "./multiAssets.js";
import { swapTokensRedeemer } from "./redeemer.js";
import {
  calculateMultiPoolSwap,
  getEpoch,
  getPoolProtocolConfigIdx,
  outRefKey,
  toEvoOutRef,
} from "./utils.js";

class DanogoClmm {
  constructor() { }

  /**
   * Calculates the expected output amount for a swap across multiple liquidity pools.
   *
   * This function retrieves the latest pool states from the blockchain and performs routing
   * calculations to estimate the best swap outcome across multiple pools.
   *
   * @param client An initialized SigningClient instance used to query the blockchain.
   * @param request The quote request object containing pool references and the swap amount.
   *                - `pools`: Array of pool objects with poolOutRef, deltaAmount, and optional stakingOutRef
   *                - `currentEpoch`: Optional; defaults to this machine's clock (see resolveEpoch)
   * @returns A promise that resolves to a `bigint` representing the estimated total output token amount.
   *
   * @example
   * ```typescript
   * const quote = await sdk.calculateSwapOut(client, {
   *   pools: [
   *     {
   *       poolOutRef: pool1OutRef,
   *       deltaAmount: 500_000n, // 0.5 ADA to pool 1
   *       stakingOutRef: staking1OutRef
   *     },
   *     {
   *       poolOutRef: pool2OutRef,
   *       deltaAmount: 500_000n, // 0.5 ADA to pool 2
   *       stakingOutRef: staking2OutRef
   *     }
   *   ]
   * });
   * ```
   */
  async calculateSwapOut(
    client: SigningClient,
    request: QuoteSwapRequest,
  ): Promise<bigint[]> {
    if (!client || !client.address) {
      throw new Error("Please connect a wallet first.");
    }
    assertNonZeroDeltas(request.pools);
    const networkId = (await client.address()).networkId;
    const currentEpoch = this.resolveEpoch(request.currentEpoch, networkId);

    const config = getNetworkConfig(networkId);

    // Fetch all pool UTxOs
    const poolUtxos = await Promise.all(
      request.pools.map(pool =>
        this.getUtxoOrThrow(client, pool.poolOutRef, "Pool input")
      )
    );
    poolUtxos.forEach((poolUtxo, index) =>
      this.derivePoolNft(
        poolUtxo,
        config.poolScriptHash,
        request.pools[index].poolOutRef,
      ),
    );

    const protocolConfigOutRef = config.protocolScriptOutRef;

    // Fetch protocol config
    const protocolConfigUtxo = await this.getUtxoOrThrow(client, protocolConfigOutRef, "Protocol config");
    assertProtocolConfigMatches(
      protocolConfigUtxo,
      config.protocolConfigScriptHash,
      protocolConfigOutRef,
    );
    const protocolConfigDatum = parseProtocolConfigDatum(
      await this.resolveDatum(client, protocolConfigUtxo, "Protocol config UTxO"),
    );

    // Prepare pool data for calculation
    const poolsData = await Promise.all(
      request.pools.map(async (pool, index) => {
        const poolUtxo = poolUtxos[index];
        const poolDatum: PoolDatum = parseDatum(
          await this.resolveDatum(client, poolUtxo, `Pool input UTxO ${index}`),
        );
        assertMeetsPoolMinimum(
          poolDatum,
          pool.deltaAmount,
          pool.poolOutRef,
        );
        const tokenA = getPolicyIdAssetNameFromUnit(poolDatum.tokenX);
        const tokenB = getPolicyIdAssetNameFromUnit(poolDatum.tokenY);
        const coin = poolUtxo.assets.lovelace;
        const getTokenAmount = (token: typeof tokenA) => {
          if (token.unit === ADA_UNIT) return coin;
          return quantityOf(poolUtxo.assets, token.policyId!, token.assetName!);
        };

        const stakingCredential = this.resolveEpochClaim(
          poolUtxo,
          poolDatum,
          currentEpoch,
        );
        const rewardAmount = stakingCredential
          ? await this.getRewardAmount(client, networkId, stakingCredential)
          : 0n;

        return {
          tokenAAmount: getTokenAmount(tokenA),
          tokenBAmount: getTokenAmount(tokenB),
          datum: poolDatum,
          rewardAmount,
          stakingCredential,
        };
      })
    );

    // Two pools sharing a staking script (distinct from the pool script)
    // would each quote the same reward account's balance as if it were
    // theirs alone; only one of them could actually claim it in a real
    // submitSwap for this same batch, which refuses outright when this
    // happens (see the withdrawal-building loop there).
    const queuedStakingCredentials = new Set<string>();
    poolsData.forEach((pool, index) => {
      if (!pool.stakingCredential) return;
      const stakingHex = toScriptHashHex(pool.stakingCredential);
      if (stakingHex === config.poolScriptHash) return;
      if (queuedStakingCredentials.has(stakingHex)) {
        throw new Error(
          `Pool ${request.pools[index].poolOutRef} shares its staking credential with another pool in this swap; only one of them could actually claim the reward.`,
        );
      }
      queuedStakingCredentials.add(stakingHex);
    });

    // Calculate multi-pool swap
    const deltaAmounts = request.pools.map((pool) => pool.deltaAmount);
    const swapResults = calculateMultiPoolSwap(
      poolsData,
      deltaAmounts,
      protocolConfigDatum.platformFeeRate,
    );

    // Return all output amounts
    return swapResults.map((result) => result.outputAmount);
  }

  /**
   * Builds and submits a swap transaction to the network.
   *
   * This method performs a swap across one or more liquidity pools in a single transaction,
   * potentially splitting the input amount across multiple pools for better price execution.
   *
   * @param client An initialized SigningClient instance with a connected wallet.
   * @param request The swap request object containing pool references, swap amount, and minimum output.
   *                - `pools`: Array of pool objects with poolOutRef, deltaAmount, minOutChangeAmount, and optional stakingOutRef
   *                - `minOutChangeAmount`: Minimum acceptable output for that pool (slippage protection); `0n` swaps at any price
   *                - `currentEpoch`: Optional; defaults to this machine's clock (see resolveEpoch)
   * @returns A promise that resolves to the transaction hash.
   *
   * @example
   * ```typescript
   * const txHash = await sdk.submitSwap(client, {
   *   pools: [
   *     {
   *       poolOutRef: pool1OutRef,
   *       deltaAmount: 500_000n, // 0.5 ADA to pool 1
   *       minOutChangeAmount: 900_000n, // Minimum 0.9 tokens out of pool 1
   *       stakingOutRef: staking1OutRef
   *     },
   *     {
   *       poolOutRef: pool2OutRef,
   *       deltaAmount: 500_000n, // 0.5 ADA to pool 2
   *       minOutChangeAmount: 900_000n, // Minimum 0.9 tokens out of pool 2
   *       stakingOutRef: staking2OutRef
   *     }
   *   ]
   * });
   * ```
   */
  async submitSwap(
    client: SigningClient,
    request: SwapRequest,
  ): Promise<string> {
    if (!client || !client.address) {
      throw new Error("Please connect a wallet first.");
    }
    assertNonZeroDeltas(request.pools);
    assertSlippageFloors(request.pools);
    const networkId = (await client.address()).networkId;
    const currentEpoch = this.resolveEpoch(request.currentEpoch, networkId);

    const config = getNetworkConfig(networkId);

    // Fetch all pool UTxOs and script UTxO
    const poolUtxos: UTxO.UTxO[] = await Promise.all(
      request.pools.map((pool) =>
        this.getUtxoOrThrow(client, pool.poolOutRef, "Pool input")
      ),
    );
    const validityNfts = poolUtxos.map((poolUtxo, index) =>
      this.derivePoolNft(
        poolUtxo,
        config.poolScriptHash,
        request.pools[index].poolOutRef,
      ),
    );

    const poolScriptOutRef = config.poolScriptOutRef;
    const protocolConfigOutRef = config.protocolScriptOutRef;

    const poolScriptUtxo = await this.getUtxoOrThrow(client, poolScriptOutRef, "Pool script");
    const poolScriptCredential = assertPoolScriptMatches(
      poolScriptUtxo,
      config.poolScriptHash,
      poolScriptOutRef,
    );

    // Fetch protocol config
    const protocolConfigUtxo = await this.getUtxoOrThrow(client, protocolConfigOutRef, "Protocol config");
    assertProtocolConfigMatches(
      protocolConfigUtxo,
      config.protocolConfigScriptHash,
      protocolConfigOutRef,
    );
    const protocolConfigDatum = parseProtocolConfigDatum(
      await this.resolveDatum(client, protocolConfigUtxo, "Protocol config UTxO"),
    );

    // Prepare pool data and calculate swap results
    const poolsData = [];
    const stakingUtxos = [];
    const rewardAmounts: bigint[] = [];
    const stakingCredentials: (ScriptHash.ScriptHash | null)[] = [];

    for (let i = 0; i < request.pools.length; i++) {
      const pool = request.pools[i];
      const poolUtxo = poolUtxos[i];

      const poolDatum: PoolDatum = parseDatum(
        await this.resolveDatum(client, poolUtxo, `Pool input UTxO ${i}`),
      );
      assertMeetsPoolMinimum(poolDatum, pool.deltaAmount, pool.poolOutRef);
      const tokenA = getPolicyIdAssetNameFromUnit(poolDatum.tokenX);
      const tokenB = getPolicyIdAssetNameFromUnit(poolDatum.tokenY);
      const coin = poolUtxo.assets.lovelace;
      const getTokenAmount = (token: typeof tokenA) => {
        if (token.unit === ADA_UNIT) return coin;
        return quantityOf(poolUtxo.assets, token.policyId!, token.assetName!);
      };

      const stakingCredential = this.resolveEpochClaim(
        poolUtxo,
        poolDatum,
        currentEpoch,
      );
      stakingCredentials.push(stakingCredential);

      let stakingRefUtxo = null;
      if (pool.stakingOutRef) {
        stakingRefUtxo = await this.getUtxoOrThrow(client, pool.stakingOutRef, "Staking");
      }
      if (stakingCredential) {
        if (!stakingRefUtxo) {
          throw new Error(
            `Pool ${pool.poolOutRef} has not claimed its staking rewards this epoch, so the swap must withdraw them. Provide its stakingOutRef.`,
          );
        }
        assertStakingRefMatches(
          stakingRefUtxo,
          stakingCredential,
          pool.poolOutRef,
        );
      }
      stakingUtxos.push(stakingRefUtxo);

      // Resolve the staking reward up front so it can be applied consistently
      // both to the swap calculation and to the pool output assets below.
      const rewardAmount = stakingCredential
        ? await this.getRewardAmount(client, networkId, stakingCredential)
        : 0n;
      rewardAmounts.push(rewardAmount);

      poolsData.push({
        tokenAAmount: getTokenAmount(tokenA),
        tokenBAmount: getTokenAmount(tokenB),
        datum: poolDatum,
        utxo: poolUtxo,
        tokenA,
        tokenB,
        rewardAmount,
        validityNft: validityNfts[i],
        outRef: pool.poolOutRef,
      });
    }

    // Calculate multi-pool swap
    const deltaAmounts = request.pools.map((pool) => pool.deltaAmount);
    const swapResults = calculateMultiPoolSwap(
      poolsData,
      deltaAmounts,
      protocolConfigDatum.platformFeeRate,
    );

    // Check output meets minimum for each pool
    swapResults.forEach((result) => {
      const minOut = request.pools[result.poolIndex].minOutChangeAmount;
      if (result.outputAmount < minOut) {
        throw new Error(
          `Expected swap output at least ${minOut} but got ${result.outputAmount}`,
        );
      }
    });

    // A pool's own reserve can cap a swap to less than requested (see
    // calculateConcentratedPoolSwap), which is the amount actually reflected
    // in the pool's output assets/datum below — the redeemer must name that
    // same amount, not the caller's original request, or the two disagree.
    const redeemerDeltaAmounts = poolsData.map((_, index) => {
      const result = swapResults.find((r) => r.poolIndex === index);
      return result ? result.deltaAmount : deltaAmounts[index];
    });

    // Pool outputs are appended in pool order below, ahead of any change output,
    // so this is the index the redeemer must name for each pool.
    let nextOutputIndex = 0;
    const poolOutputIndices = poolsData.map((_, index) =>
      swapResults.some((result) => result.poolIndex === index)
        ? nextOutputIndex++
        : -1,
    );

    // Initialize transaction builder
    let tx: SigningTransactionBuilder = client.newTx();

    // Withdrawals are keyed by reward account; two pools sharing a staking
    // script would otherwise collide here and double-count the reward.
    const queuedStakingCredentials = new Set<string>();

    // Add reference inputs. Pools sharing a staking script would otherwise be
    // counted twice here while the transaction holds one, shifting every index
    // the redeemer derives from this list.
    const referenceInputs = [
      ...new Map(
        [
          protocolConfigUtxo,
          poolScriptUtxo,
          ...stakingUtxos.filter((staking) => staking !== null),
        ].map((utxo) => [outRefKey(utxo), utxo] as const),
      ).values(),
    ];
    tx = tx.readFrom({ referenceInputs });

    // Process each pool
    const protocolConfigIdx = getPoolProtocolConfigIdx(
      protocolConfigUtxo,
      referenceInputs,
    );

    // Add withdrawal
    tx = tx.withdraw({
      stakeCredential: poolScriptCredential,
      amount: 0n,
      redeemer: swapTokensRedeemer(
        null,
        poolUtxos,
        redeemerDeltaAmounts,
        poolOutputIndices,
        protocolConfigIdx,
      ),
    });

    for (let i = 0; i < poolsData.length; i++) {
      const pool = poolsData[i];
      const swapResult = swapResults.find((r) => r.poolIndex === i);
      if (!swapResult) continue;

      const { deltaAmount, platformFee, outputAmount } = swapResult;
      const rewardAmount = rewardAmounts[i];
      const stakingCredential = stakingCredentials[i];

      // Transform pool datum
      const transformedDatum = transformPoolDatum({
        ...pool.datum,
        platformFeeX:
          BigInt(pool.datum.platformFeeX) +
          (deltaAmount > 0 ? platformFee : 0n),
        platformFeeY:
          BigInt(pool.datum.platformFeeY) +
          (deltaAmount < 0 ? platformFee : 0n),
        lastWithdrawEpoch: currentEpoch,
        totalSwapFee:
          BigInt(pool.datum.totalSwapFee) + protocolConfigDatum.swapFee,
      });

      // Calculate output assets
      const deltaAssets = this.buildDeltaAssets(
        deltaAmount > 0 ? pool.tokenA : pool.tokenB,
        deltaAmount > 0 ? pool.tokenB : pool.tokenA,
        deltaAmount,
        outputAmount,
        protocolConfigDatum.swapFee,
      );
      let poolOutAssets = merge(pool.utxo.assets, deltaAssets);
      if (rewardAmount > 0n) {
        poolOutAssets = merge(poolOutAssets, fromLovelace(rewardAmount));
      }

      // Add pool output
      tx = tx.payToAddress({
        address: pool.utxo.address,
        assets: poolOutAssets,
        datum: transformedDatum,
      });

      // Add spend
      tx = tx.collectFrom({
        inputs: [pool.utxo],
        redeemer: swapTokensRedeemer(
          pool.utxo,
          poolUtxos,
          redeemerDeltaAmounts,
          poolOutputIndices,
          protocolConfigIdx,
        ),
      });

      // Handle staking rewards if applicable
      if (stakingCredential) {
        // A pool delegating to its own spend script shares a reward account
        // with the withdrawal above; a second entry would collide, not add.
        const sharesPoolScriptAccount =
          toScriptHashHex(stakingCredential) ===
          toScriptHashHex(poolScriptCredential);

        if (sharesPoolScriptAccount) {
          // The shared entry withdraws 0, and Cardano has no partial
          // withdrawal, so a nonzero reward can't be collected through it.
          if (rewardAmount > 0n) {
            throw new Error(
              `Pool ${pool.outRef} delegates to its own spend script and has ${rewardAmount} lovelace of rewards, which this swap cannot withdraw.`,
            );
          }
          continue;
        }

        const stakingHex = toScriptHashHex(stakingCredential);
        if (queuedStakingCredentials.has(stakingHex)) {
          throw new Error(
            `Pool ${pool.outRef} shares its staking credential with another pool in this swap; withdrawing the same reward account twice would double-count its ${rewardAmount} lovelace reward.`,
          );
        }
        queuedStakingCredentials.add(stakingHex);

        tx = tx.withdraw({
          stakeCredential: stakingCredential,
          amount: rewardAmount,
          redeemer: swapTokensRedeemer(
            pool.utxo,
            poolUtxos,
            redeemerDeltaAmounts,
            poolOutputIndices,
            protocolConfigIdx,
          ),
        });
      }
    }

    // Add metadata
    tx = tx.attachMetadata({
      label: 674n,
      metadata: new Map([["msg", ["Danogo Multi-Pool Swap"]]]),
    });

    // Finalize and submit
    tx.setValidity({
      from: BigInt(Date.now() - 120000),
      to: BigInt(Date.now() + 240000),
    });
    const builtTx = await tx.build({
      scriptDataFormat: "array",
    });
    const body = (await builtTx.toTransaction()).body;
    assertPoolOutputsAt(
      body.outputs,
      poolsData,
      poolOutputIndices,
      config.poolScriptHash,
    );
    const settledConfigIdx = getPoolProtocolConfigIdx(
      protocolConfigUtxo,
      body.referenceInputs ?? [],
    );
    if (settledConfigIdx !== protocolConfigIdx) {
      throw new Error(
        `The redeemer points the validator at reference input ${protocolConfigIdx} for the protocol config, but the built transaction puts it at ${settledConfigIdx}.`,
      );
    }
    const signedTx = await builtTx.sign();
    const txHash = await signedTx.submit();
    return toHex(txHash.hash);
  }

  /**
   * Extracts concentrated liquidity pool data from a given Ogmios transaction.
   *
   * This method scans the transaction outputs for tokens associated with the configured
   * pool script hash. When a pool NFT is detected, it decodes the inline datum and
   * assets to return a structured `ConcentratedPool` object.
   *
   * @param tx The transaction object conforming to the Ogmios schema.
   * @returns An array of `ConcentratedPool` objects found in the transaction outputs.
   */
  getPoolsFromOgmiosTx(
    tx: Transaction,
    networkId: number,
    poolScriptHash?: string,
  ): ConcentratedPool[] {
    const config = getNetworkConfig(networkId);
    const scriptHash = poolScriptHash ?? config.poolScriptHash;

    if (!scriptHash) {
      throw new Error(
        "Pool script hash is required but not provided or not found for this network.",
      );
    }

    const concentratedPools: ConcentratedPool[] = [];

    // Ogmios omits outputs entirely for a transaction that has none.
    const outputs = tx.outputs ?? [];

    outputs.forEach((utxo, index) => {
      // A validity NFT is freely transferable once minted, so also require the
      // output to sit at the pool script's address — same check as derivePoolNft.
      const credential = getPaymentCredential(utxo.address);
      const isPoolScriptAddress =
        credential?._tag === "ScriptHash" &&
        toCredentialHex(credential) === scriptHash;
      if (!isPoolScriptAddress) return;

      const val = utxo.value;
      const policyAssets = val[scriptHash];
      if (!policyAssets || !utxo.datum) return;

      for (const [assetName, quantity] of Object.entries(policyAssets)) {
        if (quantity !== 1n) continue;

        const poolNft = scriptHash + assetName;
        const outRef = `${tx.id}#${index}`;
        const coin = val.ada.lovelace;
        const multiAssets: MultiAsset[] = buildMultiAssetsFromAssets(val);
        const datum: PoolDatum = parseDatum(utxo.datum);

        const tokenA = datum.tokenX;
        const tokenB = datum.tokenY;

        const getTokenReserve = (tokenId: string) => {
          if (tokenId === ADA_UNIT) return coin;
          const [policyId, assetName] = tokenIdToTuple(tokenId);
          const policyGroup = multiAssets.find(
            (ma) => ma.policyId === policyId,
          );
          const asset = policyGroup?.assets.find(
            (a) => a.name === assetName,
          );
          return asset ? asset.value : 0n;
        };

        concentratedPools.push({
          outRef,
          address: utxo.address,
          coin,
          multiAssets,
          validityNft: poolNft,
          tokenA,
          tokenAReserve: getTokenReserve(tokenA),
          tokenB,
          tokenBReserve: getTokenReserve(tokenB),
          lpFeeRate: datum.lpFeeRate,
          priceLowerNum: datum.sqrtLowerPriceNum,
          priceLowerDen: datum.sqrtLowerPriceDen,
          priceUpperNum: datum.sqrtUpperPriceNum,
          priceUpperDen: datum.sqrtUpperPriceDen,
          platformFeeA: datum.platformFeeX,
          platformFeeB: datum.platformFeeY,
          minAChange: datum.minXChange,
          minBChange: datum.minYChange,
          lpTokenTotalSupply: datum.circulatingLPToken,
          lastWithdrawEpoch: datum.lastWithdrawEpoch,
          totalSwapFee: datum.totalSwapFee,
        });
      }
    });
    return concentratedPools;
  }

  /** Anyone can park a UTxO with a crafted datum at the pool address, so the validity NFT is what identifies a real pool. */
  private derivePoolNft(
    poolUtxo: UTxO.UTxO,
    scriptHash: string,
    outRef: string,
  ): AssetName.AssetName {
    const credential = poolUtxo.address.paymentCredential;
    if (
      credential._tag !== "ScriptHash" ||
      toScriptHashHex(credential) !== scriptHash
    ) {
      throw new Error(
        `Pool input ${outRef} is not locked by the pool script ${scriptHash}.`,
      );
    }

    const validityNft = flatten(poolUtxo.assets).find(
      ([policyId, , quantity]) =>
        quantity === 1n && PolicyId.toHex(policyId) === scriptHash,
    );
    if (!validityNft) {
      throw new Error(
        `Pool input ${outRef} carries no validity NFT of policy ${scriptHash}.`,
      );
    }
    return validityNft[1];
  }

  /**
   * The epoch decides what this swap writes into the pool datum and whether it
   * owes a staking claim, but no provider method reports the chain tip, so the
   * fallback is this machine's clock. A caller that can read the tip should say
   * so rather than let a skewed clock pick the epoch near a boundary.
   */
  private resolveEpoch(supplied: number | undefined, networkId: number): number {
    const clockEpoch = getEpoch(Date.now(), networkId);
    if (supplied === undefined) return clockEpoch;

    if (!Number.isSafeInteger(supplied) || supplied < 0) {
      throw new Error(
        `currentEpoch must be a non-negative whole number, got ${supplied}.`,
      );
    }
    // Written into a pool's shared, persistent lastWithdrawEpoch — an
    // unbounded value could block every future staking claim on that pool.
    const EPOCH_TOLERANCE = 2;
    if (Math.abs(supplied - clockEpoch) > EPOCH_TOLERANCE) {
      throw new Error(
        `currentEpoch ${supplied} is too far from this machine's clock estimate of ${clockEpoch} (tolerance ${EPOCH_TOLERANCE}).`,
      );
    }
    return supplied;
  }

  /** Asset delta for the pool's new output: +amountIn (plus swapFee) of tokenIn, -amountOut of tokenOut. */
  private buildDeltaAssets(
    tokenIn: { unit: string; policyId?: any; assetName?: any },
    tokenOut: { unit: string; policyId?: any; assetName?: any },
    deltaAmount: bigint,
    amountOut: bigint,
    swapFee: bigint,
  ): any {
    // amountIn = abs(deltaAmount)
    const amountIn = deltaAmount > 0n ? deltaAmount : -deltaAmount;
    let deltaAssets: any;

    // Input amount (including swap fee)
    if (tokenIn.unit === ADA_UNIT) {
      deltaAssets = fromLovelace(amountIn + swapFee);
    } else {
      deltaAssets = fromAsset(
        tokenIn.policyId,
        tokenIn.assetName,
        amountIn,
        swapFee,
      );
    }

    // Output amount
    if (tokenOut.unit === ADA_UNIT) {
      deltaAssets = subtractLovelace(deltaAssets, amountOut);
    } else {
      const outputAssets = fromAsset(
        tokenOut.policyId,
        tokenOut.assetName,
        -amountOut,
      );
      deltaAssets = merge(deltaAssets, outputAssets);
    }

    return deltaAssets;
  }

  /** Outstanding staking reward for a pool's stake account, in lovelace. */
  private async getRewardAmount(
    client: SigningClient,
    networkId: number,
    stakingCredential: ScriptHash.ScriptHash,
  ): Promise<bigint> {
    const stakingAccount = new RewardAccount.RewardAccount({
      networkId,
      stakeCredential: stakingCredential,
    });
    const stakingRewardAddress = RewardAccount.toBech32(
      stakingAccount,
    ) as RewardAddress.RewardAddress;
    // On Kupmios, requires an Ogmios new enough for the array-shaped
    // queryLedgerState/rewardAccountSummaries response — see README.
    const rewardAmount = (await client.getDelegation(stakingRewardAddress)).rewards;

    return rewardAmount;
  }

  /** Credential to withdraw from if a staking claim is due this epoch, else null. Taken from the pool's own address, not a caller-supplied reference. */
  private resolveEpochClaim(
    poolUtxo: UTxO.UTxO,
    datum: PoolDatum,
    currentEpoch: number,
  ): ScriptHash.ScriptHash | null {
    if (datum.lastWithdrawEpoch >= currentEpoch) return null;

    const stakingCredential = poolUtxo.address.stakingCredential;
    if (!stakingCredential || stakingCredential._tag !== "ScriptHash") {
      return null;
    }
    return stakingCredential;
  }

  /**
   * A datum is inline only if its creating tx paid the extra bytes;
   * otherwise the provider hands back a bare `DatumHash` to resolve. Real
   * Danogo UTxOs observed so far are all inline, but a hash-referenced one
   * is still legal Cardano, so this handles both rather than assuming.
   */
  private async resolveDatum(
    client: SigningClient,
    utxo: UTxO.UTxO,
    description: string,
  ): Promise<Data.Data> {
    if (!utxo.datumOption) {
      throw new Error(`${description} does not contain a datum.`);
    }
    if (utxo.datumOption._tag === "InlineDatum") {
      return utxo.datumOption.data;
    }
    // evolution-sdk's own providers hand back whatever CBOR they resolved for
    // this hash without re-hashing it, so a compromised or buggy provider
    // could substitute different data. Verify it here instead of trusting it.
    const data = await client.getDatum(utxo.datumOption);
    const resolvedHash = DatumHash.toHex(Data.toDatumHash(data));
    const expectedHash = DatumHash.toHex(utxo.datumOption);
    if (resolvedHash !== expectedHash) {
      throw new Error(
        `${description} datum hash mismatch: provider returned data hashing to ${resolvedHash}, expected ${expectedHash}.`,
      );
    }
    return data;
  }

  private async getUtxoOrThrow(
    client: SigningClient,
    outRefString: string,
    utxoType: string,
  ): Promise<UTxO.UTxO> {
    const outRef = toEvoOutRef(outRefString);
    if (!outRef) {
      throw new Error(`Invalid ${utxoType} output reference: ${outRefString}`);
    }
    const utxos = await client.getUtxosByOutRef([outRef]);
    if (!utxos || utxos.length === 0) {
      throw new Error(`${utxoType} ${outRefString} UTxO not found or spent.`);
    }
    return utxos[0];
  };
}

export default DanogoClmm;
export {
  ConcentratedPool,
  PoolDatum,
  SwapRequest,
  QuoteSwapRequest,
};
