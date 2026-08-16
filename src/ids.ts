import { createHash } from "node:crypto";

export function stableId(namespace: string, key: string): number {
  const digest = createHash("sha256").update(`${namespace}:${key}`).digest();
  const nonNegative = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return Number(nonNegative % BigInt(Number.MAX_SAFE_INTEGER));
}
