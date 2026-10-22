// Off-chain re-implementation of PatchLedger.computeRecordHash so that an
// exported history can be verified without trusting the PatchLedger server.
import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";

export const RECORD_DOMAIN = keccak256(toUtf8Bytes("PatchLedger.Record.v1"));
export const ZERO_HASH = "0x" + "00".repeat(32);
export const NO_REF = 0xffffffff;

const coder = AbiCoder.defaultAbiCoder();

export interface RecordFields {
  seq: number;
  recordType: number;
  prevHash: string;
  payloadDigest: string;
  actor: string;
  timestamp: number;
  refSeq: number;
  outcome: number;
}

export function computeRecordHash(chainId: number | bigint, contract: string, deviceKey: string, r: RecordFields): string {
  return keccak256(
    coder.encode(
      ["bytes32", "uint256", "address", "bytes32", "uint32", "uint8", "bytes32", "bytes32", "address", "uint40", "uint32", "uint8"],
      [RECORD_DOMAIN, chainId, contract, deviceKey, r.seq, r.recordType, r.prevHash, r.payloadDigest, r.actor, r.timestamp, r.refSeq, r.outcome],
    ),
  );
}

export function deviceKeyFor(publicId: string): string {
  return keccak256(toUtf8Bytes("patchledger:device:" + publicId));
}
