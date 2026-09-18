# Danogo CLMM SDK

An SDK to calculate and execute swaps on the Danogo liquidity platform on the Cardano network.

## Installation

```bash
npm install danogo-clmm
```

## Prerequisites

This SDK requires:
- Node.js 18+
- `@evolution-sdk/evolution` version `0.3.32` for wallet management and transaction building
- A Kupmios provider for blockchain data and transaction submission
- Support network: Preprod & Mainnet

## Usage

### Initialization

Initialize the SDK and the Evolution client.
```typescript
import DanogoClmm from "danogo-clmm";
import { client, preprod } from "@evolution-sdk/evolution";

const danogoClmm = new DanogoClmm();

const evolutionClient = client(preprod)
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
  ],
  protocolConfigOutRef: "tx_hash#index"
});
```

> `protocolConfigOutRef` is optional and defaults to the SDK's internal constants. In rare cases where the protocol configuration has updated but the SDK has not yet been updated, you can manually provide the latest `protocolConfigOutRef` in your request. Refer to `src/constants.ts` for the constants.

### 4. Get Pool Info from Ogmios Transaction

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