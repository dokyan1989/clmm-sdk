import { CBOR, Data } from "@evolution-sdk/evolution";
import { InlineDatum } from "@evolution-sdk/evolution/InlineDatum";
import { ADA_UNIT } from "./constants.js";

export interface PoolDatum {
  tokenX: string;
  tokenY: string;
  sqrtLowerPriceNum: bigint;
  sqrtLowerPriceDen: bigint;
  sqrtUpperPriceNum: bigint;
  sqrtUpperPriceDen: bigint;
  lpFeeRate: number;
  platformFeeX: bigint;
  platformFeeY: bigint;
  totalSwapFee: bigint;
  minXChange: bigint;
  minYChange: bigint;
  circulatingLPToken: bigint;
  lastWithdrawEpoch: number;
}

export interface ProtocolConfigDatum {
  platformFeeRate: bigint,
  swapFee: bigint
}

const BASIS_POINTS = 10_000n;
const CONSTR_0_TAG = 121;
const POOL_DATUM_FIELDS = 12;

/** CBOR arrays and byte strings coerce through BigInt() to plausible numbers, so reject anything that is not an integer. */
const asInteger = (field: unknown, name: string): bigint => {
  if (typeof field !== "bigint" && typeof field !== "number") {
    throw new Error(`${name} must be an integer`);
  }
  return BigInt(field);
};

/** As asInteger, but also rejects a value above max (a structural ceiling, e.g. basis points). */
const asBoundedInteger = (field: unknown, name: string, max: bigint): bigint => {
  const value = asInteger(field, name);
  if (value < 0n || value > max) {
    throw new Error(`${name} must not be negative or exceed ${max}, got ${value}`);
  }
  return value;
};

/** As asInteger, but also rejects a negative value. */
const asNonNegativeInteger = (field: unknown, name: string): bigint => {
  const value = asInteger(field, name);
  if (value < 0n) {
    throw new Error(`${name} must not be negative, got ${value}`);
  }
  return value;
};

const EMPTY_BYTES = new Uint8Array(0);

/** [policyId, assetName] bytes for a token unit. ADA_UNIT ("lovelace") isn't hex, so it's special-cased to the empty AssetClass rather than relying on Buffer.from('hex') to truncate it. */
const encodeAssetClass = (unit: string): [Uint8Array, Uint8Array] => {
  if (unit === ADA_UNIT) return [EMPTY_BYTES, EMPTY_BYTES];
  return [
    new Uint8Array(Buffer.from(unit.slice(0, 56), 'hex')),
    new Uint8Array(Buffer.from(unit.slice(57), 'hex')), // skip the "." separator at index 56
  ];
};

/** @internal */
export const transformPoolDatum = (datum: PoolDatum): InlineDatum => {
  const tokenXData = encodeAssetClass(datum.tokenX);
  const tokenYData = encodeAssetClass(datum.tokenY);

  const sqrtLowerPriceData = Data.constr(0n, [
    datum.sqrtLowerPriceNum,
    datum.sqrtLowerPriceDen,
  ]);

  const sqrtUpperPriceData = Data.constr(0n, [
    datum.sqrtUpperPriceNum,
    datum.sqrtUpperPriceDen,
  ]);

  const poolDataumData = Data.constr(0n, [
    tokenXData,
    tokenYData,
    BigInt(datum.lpFeeRate),
    datum.platformFeeX,
    datum.platformFeeY,
    datum.totalSwapFee,
    sqrtLowerPriceData,
    sqrtUpperPriceData,
    datum.minXChange,
    datum.minYChange,
    datum.circulatingLPToken,
    BigInt(datum.lastWithdrawEpoch),
  ]);

  return new InlineDatum({ data: poolDataumData });
};

/** @internal */
export const tokenIdToTuple = (tokenId: string): [string, string] => {
  if (!tokenId) return ["", ""];

  try {
    if (tokenId.includes(".")) {
      const parts = tokenId.split(".");
      if (parts.length === 2) {
        return [parts[0], parts[1]];
      }
      return [tokenId, ""];
    }

    const policy = tokenId.slice(0, 56);
    const assetName = tokenId.slice(56);
    return [policy, assetName];
  } catch (error) {
    console.error(`Error parsing token ID "${tokenId}":`, error);
    throw new Error(`Failed to parse token ID: ${tokenId}`);
  }
};

/**
 * @internal
 * @param datum Raw CBOR hex (an Ogmios output's datum) or already-decoded
 * Plutus data (a UTxO's inline datum, or a hash-referenced one resolved separately).
 */
export const parseDatum = (datum: string | Data.Data): PoolDatum => {
  let decoded: any;

  if (typeof datum === "string") {
    decoded = CBOR.fromCBORHex(datum);
  } else {
    const inlineHex = Data.toCBORHex(datum);
    decoded = CBOR.fromCBORHex(inlineHex);
  }

  // Plutus Data is encoded as a Tagged value (Tag 121 for Constr 0). A closed
  // pool collapses to another constructor, so the tag distinguishes the two.
  if (decoded?._tag !== "Tag" || decoded.tag !== CONSTR_0_TAG) {
    throw new Error(
      `Pool datum must be constructor 0 (CBOR tag ${CONSTR_0_TAG}), got tag ${decoded?.tag}`,
    );
  }
  const fields = decoded.value;

  if (!Array.isArray(fields)) {
    throw new Error("Invalid datum structure: expected array of fields");
  }
  // Re-encoding drops whatever this does not read, so a datum of an unexpected
  // width must fail rather than be silently rewritten without its extra fields.
  if (fields.length !== POOL_DATUM_FIELDS) {
    throw new Error(
      `Pool datum must have ${POOL_DATUM_FIELDS} fields, got ${fields.length}`,
    );
  }

  // Helper to parse AssetClass (Constr 0 [PolicyId, AssetName])
  const parseAsset = (field: any): string => {
    const val = (field as any)._tag === "Tag" ? (field as any).value : field;
    if (Array.isArray(val) && val.length === 2) {
      const policyId = val[0] instanceof Uint8Array ? val[0] : new Uint8Array(val[0]);
      const assetName = val[1] instanceof Uint8Array ? val[1] : new Uint8Array(val[1]);
      const policyIdHex = Buffer.from(policyId).toString("hex");
      const assetNameHex = Buffer.from(assetName).toString("hex");
      if (policyIdHex === "" && assetNameHex === "") {
        return ADA_UNIT;
      }
      return policyIdHex + "." + assetNameHex;
    }
    throw new Error("Invalid AssetClass structure");
  };

  // Helper to parse Ratio (Constr 0 [Numerator, Denominator])
  const parseRatio = (field: any, name: string): { num: bigint; den: bigint } => {
    const val = (field as any)._tag === "Tag" ? (field as any).value : field;
    if (Array.isArray(val) && val.length === 2) {
      return {
        num: asInteger(val[0], `${name} numerator`),
        den: asInteger(val[1], `${name} denominator`),
      };
    }
    throw new Error("Invalid Ratio structure");
  };

  const sqrtLowerPrice = parseRatio(fields[6], "Pool datum sqrtLowerPrice");
  const sqrtUpperPrice = parseRatio(fields[7], "Pool datum sqrtUpperPrice");

  return {
    tokenX: parseAsset(fields[0]),
    tokenY: parseAsset(fields[1]),
    // lpFeeRate is basis points of the trade; above 10000 it would make
    // offFee negative in getPoolChange, corrupting the swap math.
    lpFeeRate: Number(
      asBoundedInteger(fields[2], "Pool datum lpFeeRate", BASIS_POINTS),
    ),
    platformFeeX: asNonNegativeInteger(fields[3], "Pool datum platformFeeX"),
    platformFeeY: asNonNegativeInteger(fields[4], "Pool datum platformFeeY"),
    totalSwapFee: asInteger(fields[5], "Pool datum totalSwapFee"),
    sqrtLowerPriceNum: sqrtLowerPrice.num,
    sqrtLowerPriceDen: sqrtLowerPrice.den,
    sqrtUpperPriceNum: sqrtUpperPrice.num,
    sqrtUpperPriceDen: sqrtUpperPrice.den,
    minXChange: asNonNegativeInteger(fields[8], "Pool datum minXChange"),
    minYChange: asNonNegativeInteger(fields[9], "Pool datum minYChange"),
    circulatingLPToken: asInteger(fields[10], "Pool datum circulatingLPToken"),
    lastWithdrawEpoch: Number(asInteger(fields[11], "Pool datum lastWithdrawEpoch")),
  };
};

/** @internal */
export const parseProtocolConfigDatum = (data: Data.Data): ProtocolConfigDatum => {
  const inlineHex = Data.toCBORHex(data);
  const decoded = CBOR.fromCBORHex(inlineHex);

  // Plutus Data is typically encoded as a Tagged value (Tag 121 for Constr 0)
  // The value inside is an array of fields.
  const fields = (decoded as any)._tag === "Tag" ? (decoded as any).value : decoded;

  if (!Array.isArray(fields)) {
    throw new Error("Invalid datum structure: expected array of fields");
  }
  if (fields.length < 2) {
    throw new Error(
      `Protocol config datum must have at least 2 fields, got ${fields.length}`,
    );
  }

  const platformFeeRate = asInteger(
    fields[0],
    "Protocol config platformFeeRate",
  );
  const swapFee = asInteger(fields[1], "Protocol config swapFee");

  // platformFeeRate is the protocol's share of the LP fee in basis points, so
  // anything above BASE would hand the protocol more than the whole LP fee.
  if (platformFeeRate < 0n || platformFeeRate > BASIS_POINTS) {
    throw new Error(
      `Protocol config platformFeeRate must be between 0 and ${BASIS_POINTS} basis points, got ${platformFeeRate}`,
    );
  }
  // swapFee is added to what the wallet pays into the pool; a negative one would drain it.
  if (swapFee < 0n) {
    throw new Error(
      `Protocol config swapFee must not be negative, got ${swapFee}`,
    );
  }

  return { platformFeeRate, swapFee };
};