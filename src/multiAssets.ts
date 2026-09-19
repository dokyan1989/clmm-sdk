import { Value } from "@cardano-ogmios/schema";
import { AssetName, Bytes, PolicyId } from "@evolution-sdk/evolution";
import { ADA_UNIT } from "./constants";

export interface MultiAsset {
  policyId: string;
  assets: Asset[];
}

interface Asset {
  name: string;
  value: bigint;
}
export interface TokenInfo {
  policyId?: PolicyId.PolicyId;
  assetName?: AssetName.AssetName;
  unit: string;
}

export function getPolicyIdAssetNameFromUnit(unit: string): TokenInfo {
  if (unit === ADA_UNIT) {
    return {
      unit: ADA_UNIT
    };
  }

  // Parse "policyId.assetName" or "policyId" (empty asset name)
  const dotIndex = unit.indexOf(".")
  const policyIdHex = dotIndex === -1 ? unit : unit.slice(0, dotIndex)
  const assetNameHex = dotIndex === -1 ? "" : unit.slice(dotIndex + 1)

  // Decode policy ID from hex (28 bytes = 56 hex chars)
  const policyIdBytes = Bytes.fromHex(policyIdHex)
  const policyId = new PolicyId.PolicyId({ hash: policyIdBytes })

  // Decode asset name from hex (empty string yields empty bytes)
  const assetNameBytes = assetNameHex ? Bytes.fromHex(assetNameHex) : new Uint8Array(0)
  const assetName = new AssetName.AssetName({ bytes: assetNameBytes })

  return { policyId, assetName, unit };
}

/** Builds MultiAsset entries from an Ogmios Value object; for reading pool data, not for building transactions. @internal */
export const buildMultiAssetsFromAssets = (assets: Value): MultiAsset[] => {
  if (!assets || Object.keys(assets).length === 0) {
    return [];
  }

  const multiAssets: MultiAsset[] = [];

  for (const [policyId, assetsMap] of Object.entries(assets)) {
    if (policyId === "ada") continue;

    const currentAssets: Asset[] = [];
    for (const [assetName, quantity] of Object.entries(
      assetsMap as { [k: string]: bigint }
    )) {
      currentAssets.push({
        name: assetName,
        value: quantity as bigint,
      });
    }

    multiAssets.push({
      policyId,
      assets: currentAssets,
    });
  }

  return multiAssets;
};
