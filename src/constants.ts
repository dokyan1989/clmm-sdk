export const ADA_UNIT = "lovelace";

// Length, in ms, of the "epoch" this SDK writes to a pool's lastWithdrawEpoch
// and uses to decide whether a staking claim is due — see getEpoch. This is
// Danogo's own reward-epoch cadence, not Cardano's chain epoch.
export const EPOCH_LENGTH_MAINNET = 432_000_000; // 5 days
export const POOL_SCRIPT_OUT_REF_MAINNET =
  "64d111b957e7d7848ffdde5149aa77fa4090a7fa1ad0ac108067900614848501#0";
export const POOL_SCRIPT_HASH_MAINNET =
  "d8b69fc53637bcfadbc4469083f706bc293f4d9d2296646c5ca167bb";
export const PROTOCOL_CONFIG_OUT_REF_MAINNET =
  "2cafd7c92f7093e5229af274be83dea660b0590b4174bbed79ba662b44fbd1ee#0";
// The protocol config UTxO's payment credential — see assertProtocolConfigMatches.
export const PROTOCOL_CONFIG_SCRIPT_HASH_MAINNET =
  "fa991bc2f9c4206e72d713bc3487a72e7901057cabb8d364bebeef8f";

export const EPOCH_LENGTH_PREPROD = 1_800_000; // 30 min
export const POOL_SCRIPT_OUT_REF_PREPROD =
  "2e19cca74e3badcab26aef7574aa1885ba97228a254ca227ba2f79f2b75fd136#0";
export const POOL_SCRIPT_HASH_PREPROD =
  "04041c3c6ba87b33f2c9eb7f7dbeae3b26003c3e199d438bb99932a2";
export const PROTOCOL_CONFIG_OUT_REF_PREPROD =
  "3775af36f485f9c97101ee5b9b360c34f0f8e12186bc9060f358b7fc8ce468a4#0";
export const PROTOCOL_CONFIG_SCRIPT_HASH_PREPROD =
  "26ec271e96420bd548932f350e76ea38590da68e12f0f55bd5473f67";

export const getNetworkConfig = (networkId: number) => {
  if (networkId === 1) {
    return {
      poolScriptOutRef: POOL_SCRIPT_OUT_REF_MAINNET,
      poolScriptHash: POOL_SCRIPT_HASH_MAINNET,
      protocolScriptOutRef: PROTOCOL_CONFIG_OUT_REF_MAINNET,
      protocolConfigScriptHash: PROTOCOL_CONFIG_SCRIPT_HASH_MAINNET,
    };
  }
  return {
    poolScriptOutRef: POOL_SCRIPT_OUT_REF_PREPROD,
    poolScriptHash: POOL_SCRIPT_HASH_PREPROD,
    protocolScriptOutRef: PROTOCOL_CONFIG_OUT_REF_PREPROD,
    protocolConfigScriptHash: PROTOCOL_CONFIG_SCRIPT_HASH_PREPROD,
  };
};
