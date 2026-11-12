/**
 * WebCrypto helpers shared by token signing, masking and HMAC work.
 *
 * All functions are safe to use in a 10 ms CPU budget: HMAC-SHA256 of short
 * payloads is microseconds of WebCrypto time.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i]!.toString(16).padStart(2, "0");
  return hex;
}

/** Standard base64 (with padding), matching `Buffer.toString("base64")`. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Tolerates missing padding, like `Buffer.from(s, "base64")`. */
export function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function base64ToString(b64: string): string | null {
  const bytes = base64ToBytes(b64);
  return bytes ? decoder.decode(bytes) : null;
}

export function stringToBase64(text: string): string {
  return bytesToBase64(encoder.encode(text));
}

async function importHmacKey(raw: Uint8Array | ArrayBuffer): Promise<CryptoKey> {
  const data = raw instanceof ArrayBuffer ? raw : (raw.buffer as ArrayBuffer).slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  return crypto.subtle.importKey("raw", data, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** HMAC-SHA256 of `message` under raw key bytes, hex-encoded. */
export async function hmacSha256Hex(key: Uint8Array, message: string): Promise<string> {
  const cryptoKey = await importHmacKey(key);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return bytesToHex(signature);
}

/** HMAC-SHA256 under raw key bytes, raw bytes (for JWT-ish binary work). */
export async function hmacSha256Bytes(key: Uint8Array, message: Uint8Array | string): Promise<ArrayBuffer> {
  const cryptoKey = await importHmacKey(key);
  const data = typeof message === "string" ? encoder.encode(message) : (message as Uint8Array);
  return crypto.subtle.sign("HMAC", cryptoKey, data as Uint8Array);
}

export async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(message));
  return bytesToHex(digest);
}

/** Constant-time comparison for equal-length ASCII/hex strings. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
