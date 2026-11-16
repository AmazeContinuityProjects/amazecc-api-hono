import { hash } from "./generator";

/** Stable pseudonymous key for a student id (REGISTER NO). 16 hex chars. */
export async function maskUserID(userID: string): Promise<string> {
  return hash(`mask:user:${userID.trim().toUpperCase()}`).substring(0, 16);
}

/** Pseudonymous key for an IP address. 32 hex chars. */
export async function maskIP(ipAddress: string): Promise<string> {
  return hash(`mask:ip:${ipAddress.trim()}`).substring(0, 32);
}
