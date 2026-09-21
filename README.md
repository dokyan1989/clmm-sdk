# Danogo CLMM SDK

An SDK to calculate and execute swaps on the Danogo liquidity platform on the Cardano network.

## Installation

```bash
npm install danogo-clmm
```

## Prerequisites

This SDK requires:
- Node.js 18+
- `@evolution-sdk/evolution` version `^0.5.13` for wallet management and transaction building
- A supported evolution-sdk provider (Kupmios, Koios, Blockfrost, or Maestro) for blockchain data and transaction submission
- Support network: Preprod & Mainnet

### ⚠️ Ogmios version requirement (Kupmios provider only)

If you use the Kupmios provider, **Ogmios must be new enough that
`queryLedgerState/rewardAccountSummaries` returns a JSON array** (the shape
`@evolution-sdk/evolution@0.5.13`'s Kupmios adapter expects). Older Ogmios
releases return a JSON object instead (keyed by credential, with a
`delegate` field instead of `stakePool`) for the same query — confirmed at
least as late as v6.11.2, fixed by v6.14.0 (the exact version the shape
changed in between those two hasn't been pinned down).

On an older Ogmios, any swap through a pool that holds ADA and hasn't yet
claimed its current epoch's staking reward will fail with something like:

```
ProviderError: Kupmios getDelegation failed
[cause]: ParseError: JSONRPCSchema … Expected ReadonlyArray<…>, actual {}
```

Pools with no ADA side, or that already claimed this epoch, are unaffected
regardless of Ogmios version — so this can pass testing on some pools and
only surface later on others. If you hit this, upgrade Ogmios; there is no
workaround available from this SDK's side, since `getDelegation()`'s
request/response handling happens entirely inside
`@evolution-sdk/evolution`'s Kupmios provider, before this SDK ever sees the
result.

## Usage

### Initialization

Initialize the SDK and the Evolution client.
```typescript
import DanogoClmm from "danogo-clmm";
import { Client, preprod } from "@evolution-sdk/evolution";

const danogoClmm = new DanogoClmm();

const evolutionClient = Client.make(preprod)
  .withKupmios({
    kupoUrl: "your_kupo_url",
    ogmiosUrl: "your_ogmios_url",
  })
  .withSeed({
    mnemonic: "your_seed_phrase",
    accountIndex: 0,
  });
```

### 1. Calculate Swap Output (Quote)

Calculate the expected output of a swap without submitting a transaction. You can swap through one or more pools to get better price execution.

#### Examples
```typescript
const quote = await danogoClmm.calculateSwapOut(evolutionClient, {
  pools: [
    {
      poolOutRef: "tx_hash#index",
      deltaAmount: 5_000_000n,
      stakingOutRef: "tx_hash#index" // required if pool contains ADA and swap for the first time in current epoch
    },
    {
      poolOutRef: "tx_hash#index",
      deltaAmount: 5_000_000n,
      stakingOutRef: "tx_hash#index" // required if pool contains ADA and swap for the first time in current epoch
    }
  ]
});
```

### 2. Submit Swap Transaction

Build and submit a swap transaction across one or more pools.

#### Examples
```typescript
const txHash = await danogoClmm.submitSwap(evolutionClient, {
  pools: [
    {
      poolOutRef: "tx_hash#index",
      deltaAmount: 5_000_000n,
      minOutChangeAmount: 4_500_000n, // retrieve from calculateSwapOut to avoid slippage
      stakingOutRef: "tx_hash#index" // required if pool contains ADA and swap for the first time in current epoch
    },
    {
      poolOutRef: "tx_hash#index",
      deltaAmount: 5_000_000n,
      minOutChangeAmount: 4_500_000n, // retrieve from calculateSwapOut to avoid slippage
      stakingOutRef: "tx_hash#index" // required if pool contains ADA and swap for the first time in current epoch
    }
  ]
});
```

> The protocol config UTxO is always the SDK's internal constant (`src/constants.ts`) — there is no request field to override it. It's read-only reference data the SDK itself resolves and verifies against a known script address; a request field here would only be a way to point it at something else, with no legitimate reason to.

> `currentEpoch` is also optional on both `calculateSwapOut` and `submitSwap` requests. It defaults to the epoch derived from this machine's clock, which is wrong right around an epoch boundary if your clock is skewed — pass the epoch read from the chain if you have it (this is what decides whether a pool's `stakingOutRef` is required, per above).

### 3. Get Pool Info from Ogmios Transaction

Extract pool data directly from an Ogmios transaction object. This example drives
the chain-synchronization client yourself, so install `@cardano-ogmios/client`
alongside the SDK.

```typescript
import DanogoClmm from "danogo-clmm";
import { createChainSynchronizationClient, createInteractionContext } from "@cardano-ogmios/client";
import { Point } from "@cardano-ogmios/schema";

const danogoClmm = new DanogoClmm();

async function main() {
  const context = await createInteractionContext(
    console.error,
    () => console.log("closed"),
    {
      connection: {
        host: "your_ogmios_host",
        port: 443,
        tls: true
      },
    }
  );

  const client = await createChainSynchronizationClient(context, {
    rollForward: async ({ block }, requestNext) => {
      if ("transactions" in block) {
        for (const tx of block.transactions!) {
          const networkId = 0; // 0 for Preprod, 1 for Mainnet
          const pools = danogoClmm.getPoolsFromOgmiosTx(tx, networkId);
          // A third, optional `poolScriptHash` argument overrides the
          // network's default pool script hash, if you ever need that.
          // your logic with pools
        }
      }
      requestNext();
    },

    rollBackward: async ({ point }, requestNext) => {
      // handle rollbacks
      requestNext();
    },
  });

  const checkpoint: Point = {
    slot: 109847210, // Replace with your slot
    id: "your_block_hash",
  };

  await client.resume([checkpoint]);
}
```

### ⚠️ TypeScript Compatibility Note

The dependency `@evolution-sdk/evolution` currently ships with some TypeScript type definitions that may cause compilation errors in strict projects.

If you encounter type errors originating from `node_modules/@evolution-sdk/evolution`, you can safely enable the following option in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "skipLibCheck": true
  }
}
```