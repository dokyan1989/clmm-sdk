import {
  AssetName,
  Data,
  DatumHash,
  PolicyId,
  RewardAccount,
  RewardAddress,
  UTxO,
} from "@evolution-sdk/evolution";
import type { SigningClient } from "@evolution-sdk/evolution/sdk/client/Client";
import * as TxOut from "@evolution-sdk/evolution/TxOut";
import { SigningTransactionBuilder } from "@evolution-sdk/evolution/sdk/builders/TransactionBuilder";
import * as ScriptHash from "@evolution-sdk/evolution/ScriptHash";
import { getPaymentCredential } from "@evolution-sdk/evolution/Address";
import { toHex as toCredentialHex } from "@evolution-sdk/evolution/Credential";
import {
  fromScript,
  toHex as toScriptHashHex,
} from "@evolution-sdk/evolution/ScriptHash";
import {
  fromAsset,
  flatten,
  merge,
  quantityOf,
  fromLovelace,
  subtractLovelace,
} from "@evolution-sdk/evolution/Assets";
import { Transaction } from "@cardano-ogmios/schema";
import { swapTokensRedeemer } from "./redeemer.js";
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
import {
  ConcentratedPool,
  QuoteSwapRequest,
  SwapRequest,
} from "./concentratedPool.js";
import {
  calculateMultiPoolSwap,
  getEpoch,
  getPoolProtocolConfigIdx,
  outRefKey,
  toEvoOutRef,
} from "./utils.js";
import { ADA_UNIT, getNetworkConfig } from "./constants.js";
import { toHex } from "@evolution-sdk/evolution/Bytes32";

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
   *                - `protocolConfigOutRef`: Reference to the protocol configuration UTxO
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
   *   ],
   *   protocolConfigOutRef: protocolConfigRef
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
    this.assertNonZeroDeltas(request.pools);
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

    const protocolConfigOutRef =
      request.protocolConfigOutRef ?? config.protocolScriptOutRef;

    // Fetch protocol config
    const protocolConfigUtxo = await this.getUtxoOrThrow(client, protocolConfigOutRef, "Protocol config");
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
        this.assertMeetsPoolMinimum(
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
        };
      })
    );

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
   *                - `protocolConfigOutRef`: Reference to the protocol configuration UTxO
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
   *   ],
   *   protocolConfigOutRef: protocolConfigRef
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
    this.assertNonZeroDeltas(request.pools);
    this.assertSlippageFloors(request.pools);
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
    const protocolConfigOutRef =
      request.protocolConfigOutRef ?? config.protocolScriptOutRef;

    const poolScriptUtxo = await this.getUtxoOrThrow(client, poolScriptOutRef, "Pool script");
    const poolScriptCredential = this.assertPoolScriptMatches(
      poolScriptUtxo,
      config.poolScriptHash,
      poolScriptOutRef,
    );

    // Fetch protocol config
    const protocolConfigUtxo = await this.getUtxoOrThrow(client, protocolConfigOutRef, "Protocol config");
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
      this.assertMeetsPoolMinimum(poolDatum, pool.deltaAmount, pool.poolOutRef);
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
        this.assertStakingRefMatches(
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

    // Cardano's withdrawals are keyed by reward account, so two pools sharing
    // a staking script distinct from the pool script would collide here —
    // one entry silently overwriting the other while both pools' outputs
    // still credit themselves the reward, double-counting it.
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
        // A pool delegating to its own spend script shares a reward account with
        // the withdrawal that invokes the validator above. Withdrawals are keyed
        // by reward account, so a second entry here would collide with it rather
        // than add to it, and that one invocation already covers both purposes.
        const sharesPoolScriptAccount =
          toScriptHashHex(stakingCredential) ===
          toScriptHashHex(poolScriptCredential);

        if (!sharesPoolScriptAccount) {
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
        } else if (rewardAmount > 0n) {
          // The shared entry withdraws 0, and Cardano has no partial withdrawal,
          // so the reward cannot be collected through it.
          throw new Error(
            `Pool ${pool.outRef} delegates to its own spend script and has ${rewardAmount} lovelace of rewards, which this swap cannot withdraw.`,
          );
        }
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
    this.assertPoolOutputsAt(
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
      // A validity NFT, once minted, is a freely transferable token — anyone
      // could send one to an address they control, paired with an arbitrary
      // datum. Require it to actually sit at the pool script's own address,
      // matching the check derivePoolNft makes for a live UTxO.
      const credential = getPaymentCredential(utxo.address);
      const isPoolScriptAddress =
        credential?._tag === "ScriptHash" &&
        toCredentialHex(credential) === scriptHash;
      if (!isPoolScriptAddress) return;

      const val = utxo.value;
      const policyAssets = val[scriptHash];

      if (policyAssets && utxo.datum) {
        for (const [assetName, quantity] of Object.entries(policyAssets)) {
          if (quantity === 1n) {
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
        }
      }
    });
    return concentratedPools;
  }

  /**
   * `poolScriptOutRef` and `poolScriptHash` are two separate constants in
   * `constants.ts`, kept in sync by hand. This confirms the script the ref
   * input actually resolves to hashes to the credential every pool address is
   * checked against, rather than assuming the two were updated together.
   */
  private assertPoolScriptMatches(
    poolScriptUtxo: UTxO.UTxO,
    scriptHash: string,
    outRef: string,
  ): ScriptHash.ScriptHash {
    if (!poolScriptUtxo.scriptRef) {
      throw new Error(`Pool script reference ${outRef} carries no script.`);
    }
    const credential = fromScript(poolScriptUtxo.scriptRef);
    const resolvedHash = toScriptHashHex(credential);
    if (resolvedHash !== scriptHash) {
      throw new Error(
        `Pool script reference ${outRef} resolves to ${resolvedHash}, but the configured pool script hash is ${scriptHash}.`,
      );
    }
    return credential;
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
   * The redeemer tells the validator which output re-creates each pool, and that
   * index is decided before the transaction is assembled. This re-reads the built
   * transaction to confirm each pool's validity NFT really did land where its
   * redeemer says, rather than trusting the ordering to hold.
   */
  private assertPoolOutputsAt(
    outputs: readonly TxOut.TransactionOutput[],
    pools: { validityNft: AssetName.AssetName; outRef: string }[],
    outputIndices: number[],
    scriptHash: string,
  ): void {
    const policyId = PolicyId.fromHex(scriptHash);

    pools.forEach((pool, index) => {
      const outputIndex = outputIndices[index];
      if (outputIndex < 0) return;

      const output = outputs[outputIndex];
      const held = output
        ? quantityOf(output.assets, policyId, pool.validityNft)
        : 0n;
      if (held !== 1n) {
        throw new Error(
          `Pool ${pool.outRef} is declared at output ${outputIndex} of the built transaction, but that output does not hold its validity NFT.`,
        );
      }
    });
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
    // A caller reading the real chain tip may legitimately differ from this
    // machine's clock by a little, but nothing legitimate is far off. This
    // epoch gets written into a pool's shared, persistent lastWithdrawEpoch —
    // an unbounded value could push it far into the future and permanently
    // block every future staking claim on that pool.
    const EPOCH_TOLERANCE = 2;
    if (Math.abs(supplied - clockEpoch) > EPOCH_TOLERANCE) {
      throw new Error(
        `currentEpoch ${supplied} is too far from this machine's clock estimate of ${clockEpoch} (tolerance ${EPOCH_TOLERANCE}).`,
      );
    }
    return supplied;
  }

  /** Below its minimum the validator moves the pool by that minimum instead, taking more from the wallet than the caller offered. */
  private assertMeetsPoolMinimum(
    datum: PoolDatum,
    deltaAmount: bigint,
    outRef: string,
  ): void {
    const offered = deltaAmount > 0n ? deltaAmount : -deltaAmount;
    const minimum = deltaAmount > 0n ? datum.minXChange : datum.minYChange;
    if (offered < minimum) {
      throw new Error(
        `Pool ${outRef} moves at least ${minimum} at a time, but the request offers ${offered}.`,
      );
    }
  }

  /** An omitted floor leaves the swap with no price protection at all, which is an oversight rather than a choice; `0n` says it on purpose. */
  private assertSlippageFloors(
    pools: readonly { poolOutRef: string; minOutChangeAmount?: bigint }[],
  ): void {
    pools.forEach((pool, index) => {
      if (pool.minOutChangeAmount === undefined) {
        throw new Error(
          `Pool ${index} (${pool.poolOutRef}) has no minOutChangeAmount. Set the least output you accept, or 0n to swap at any price.`,
        );
      }
      if (pool.minOutChangeAmount < 0n) {
        throw new Error(
          `Pool ${index} (${pool.poolOutRef}) has a negative minOutChangeAmount.`,
        );
      }
    });
  }

  /** A zero-delta pool is dropped from the swap results, desyncing the pool indices the redeemer is built from. */
  private assertNonZeroDeltas(
    pools: readonly { poolOutRef: string; deltaAmount: bigint }[],
  ): void {
    pools.forEach((pool, index) => {
      if (pool.deltaAmount === 0n) {
        throw new Error(
          `Pool ${index} (${pool.poolOutRef}) has deltaAmount 0. Remove it from the request instead.`,
        );
      }
    });
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

  /**
   * The first transaction to touch a pool in a new epoch must carry its staking
   * withdrawal, so this returns the credential to withdraw from, or null when no
   * claim is due. Taking it from the pool's own address rather than from a
   * caller-supplied reference keeps it tied to the pool being spent.
   */
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

  private assertStakingRefMatches(
    stakingRefUtxo: UTxO.UTxO,
    stakingCredential: ScriptHash.ScriptHash,
    outRef: string,
  ): void {
    if (!stakingRefUtxo.scriptRef) {
      throw new Error(
        `Staking reference for pool ${outRef} carries no script.`,
      );
    }
    const referenced = toScriptHashHex(fromScript(stakingRefUtxo.scriptRef));
    const expected = toScriptHashHex(stakingCredential);
    if (referenced !== expected) {
      throw new Error(
        `Staking reference for pool ${outRef} holds script ${referenced}, but the pool delegates to ${expected}.`,
      );
    }
  }

  /**
   * A UTxO's datum is inline only if the transaction that created it chose to
   * pay the extra bytes; otherwise the ledger stores just a hash, and the
   * provider hands that back as a `DatumHash` rather than resolving it. Every
   * real pool and protocol-config UTxO on Danogo mainnet and preprod stores a
   * hash, not an inline datum, so skipping this resolution step is not an edge
   * case — it is the reason parsing a live UTxO would fail every time.
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
