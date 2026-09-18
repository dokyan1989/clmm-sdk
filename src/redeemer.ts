import { Data, UTxO } from "@evolution-sdk/evolution";
import type { IndexedInput } from "@evolution-sdk/evolution/sdk/builders/RedeemerBuilder";
import { RedeemerArg } from "@evolution-sdk/evolution/sdk/builders/RedeemerBuilder";

/**
 * Converts a BigInt to a big-endian byte array (Uint8Array) of a specific length.
 * @param n The BigInt to convert.
 * @param length The desired length of the output byte array.
 * @returns A Uint8Array representing the BigInt, padded with leading zeros if necessary.
 */
/** @internal */
export function bigintToBytesPadded(n: bigint, length: number): Uint8Array {
  // if n is negative, n only can be deltaAmount
  // add 2^256 (32 bytes) to get positive number represent deltaAmount
  const unSignNum = n >= 0n ? n : n + (1n << 256n);

  let hex = unSignNum.toString(16);
  if (hex.length % 2) hex = "0" + hex;

  const numBytes = hex.length / 2;
  if (numBytes > length) {
    throw new Error(
      `Number ${n} requires ${numBytes} bytes, but target length is ${length}.`,
    );
  }

  const u8 = new Uint8Array(length);
  const offset = length - numBytes;
  for (let i = 0; i < numBytes; i++) {
    u8[i + offset] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return u8;
}

/** @internal */
export const swapTokensRedeemer = (
  targetPoolUTxO: UTxO.UTxO | null,
  poolInUTxOs: UTxO.UTxO[],
  deltaAmounts: bigint[],
  poolOutputIndices: number[],
  protocolConfigIdx: bigint,
): RedeemerArg => {
  try {
    // Supports multi-pool vector: (pool_in, pool_out, amount)+
    const buildRedeemerData = (
      indexedTargetPoolIndex: bigint | null,
      indexedInputs: ReadonlyArray<IndexedInput>,
    ): Data.Data => {
      const SWAP_ACTION = 3n;
      const firstBytes = bigintToBytesPadded(
        targetPoolUTxO ? indexedTargetPoolIndex : protocolConfigIdx,
        1,
      );
      const actionBytes = bigintToBytesPadded(SWAP_ACTION, 1);

      const poolEntries = poolInUTxOs
        .map((poolUtxo, poolOutIdx) => {
          // Find this pool UTxO's index in indexedInputs
          const indexedInput = indexedInputs.find(
            (input) =>
              input.utxo.transactionId === poolUtxo.transactionId &&
              input.utxo.index === poolUtxo.index,
          );
          if (!indexedInput) {
            throw new Error(
              `Pool UTxO at ${poolOutIdx} not found in indexedInputs`,
            );
          }
          if (deltaAmounts[poolOutIdx] === undefined)
            throw new Error(
              `deltaAmount for poolOutIdx ${poolOutIdx} is undefined`,
            );
          // Where the caller placed this pool's re-created output, rather than an
          // assumption that the outputs mirror the order the pools were passed in.
          const poolOutputIndex = poolOutputIndices[poolOutIdx];
          if (poolOutputIndex === undefined || poolOutputIndex < 0) {
            throw new Error(
              `Pool UTxO at ${poolOutIdx} has no output index in this transaction`,
            );
          }
          const poolInBytes = bigintToBytesPadded(BigInt(indexedInput.index), 1);
          const poolOutBytes = bigintToBytesPadded(BigInt(poolOutputIndex), 1);
          const amountBytes = bigintToBytesPadded(deltaAmounts[poolOutIdx], 32);
          return {
            poolInputIndex: indexedInput.index,
            poolInBytes,
            poolOutBytes,
            amountBytes,
          };
        })
        // The validator matches these against the canonically sorted transaction
        // inputs, so they must ascend by input index rather than by request order.
        .sort((a, b) => a.poolInputIndex - b.poolInputIndex);

      // 1 byte for firstBytes, 1 byte for actionBytes, 34 bytes for each pool entry (poolIn, poolOut, amount)
      const totalLength = 2 + 34 * poolEntries.length;
      const concatenatedBytes = new Uint8Array(totalLength);

      let pos = 0;
      concatenatedBytes.set(firstBytes, pos);
      pos += firstBytes.length;
      concatenatedBytes.set(actionBytes, pos);
      pos += actionBytes.length;

      for (const entry of poolEntries) {
        concatenatedBytes.set(entry.poolInBytes, pos);
        pos += entry.poolInBytes.length;
        concatenatedBytes.set(entry.poolOutBytes, pos);
        pos += entry.poolOutBytes.length;
        concatenatedBytes.set(entry.amountBytes, pos);
        pos += entry.amountBytes.length;
      }

      return concatenatedBytes;
    };

    return {
      all: (indexedInputs: ReadonlyArray<IndexedInput>) => {
        if (!indexedInputs.length) {
          throw new Error(
            "swapTokensRedeemer batch all called with empty indexedInputs",
          );
        }
        let indexedTargetPool = null;
        if (targetPoolUTxO) {
          indexedTargetPool = indexedInputs.find(
            (poolUtxo) =>
              poolUtxo.utxo.transactionId === targetPoolUTxO.transactionId &&
              poolUtxo.utxo.index === targetPoolUTxO.index,
          );
          if (!indexedTargetPool) {
            throw new Error("Target pool UTxO is not found in poolInUTxOs");
          }
        }
        return buildRedeemerData(indexedTargetPool?.index, indexedInputs);
      },
      inputs: poolInUTxOs,
    };
  } catch (error) {
    console.error("Error creating pool redeemer:", error);
    throw error;
  }
};
