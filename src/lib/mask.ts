import { getWorkerEnv } from "../env";
import { hmacSha256Hex } from "./crypto";

function salt(): Uint8Array {
  const value = getWorkerEnv().ID_SALT;
  if (!value) {
    throw new Error("ID_SALT environment variable is required");
  }
  return new TextEncoder().encode(value);
}

/** Stable pseudonymous key for a student id (REGISTER NO). 16 hex chars. */
export async function maskUserID(userID: string): Promise<string> {
  return (await hmacSha256Hex(salt(), userID)).substring(0, 16);
}

/** Pseudonymous key for an IP address. 32 hex chars. */
export async function maskIP(ipAddress: string): Promise<string> {
  return (await hmacSha256Hex(salt(), ipAddress)).substring(0, 32);
}
