/**
 * Web Push (RFC 8291 & RFC 8292) on WebCrypto — no Node `crypto`, no `web-push`.
 *
 * VAPID keys are the ones `web-push generate-vapid-keys` produces:
 *   NEXT_PUBLIC_VAPID_PUBLIC_KEY  — base64url of the 65-byte uncompressed point
 *   VAPID_PRIVATE_KEY             — base64url of the 32-byte scalar
 *
 * Flow per subscription:
 *   1. VAPID JWT (ES256) signs { aud: endpoint origin, exp, sub }
 *   2. aes128gcm content-encoding encrypts the payload to the subscription's
 *      p256dh public key under its auth secret.
 */
import { getWorkerEnv } from "../env";

const encoder = new TextEncoder();

function base64UrlDecode(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64url.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class PushError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "PushError";
  }
}

async function importVapidPrivateKey(privateKeyB64Url: string, publicKeyB64Url: string): Promise<CryptoKey> {
  const priv = base64UrlDecode(privateKeyB64Url);
  const pub = base64UrlDecode(publicKeyB64Url);
  if (priv.length !== 32 || pub.length !== 65 || pub[0] !== 0x04) {
    throw new PushError("Malformed VAPID keys (expected 65-byte public point, 32-byte private scalar)");
  }
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(pub.slice(1, 33)),
    y: base64UrlEncode(pub.slice(33)),
    d: base64UrlEncode(priv),
    ext: false,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function vapidJwt(audience: string, privateKeyB64Url: string, publicKeyB64Url: string): Promise<string> {
  const key = await importVapidPrivateKey(privateKeyB64Url, publicKeyB64Url);
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        aud: audience,
        sub: "mailto:support@uni-cc.site",
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
      })
    )
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as Uint8Array<ArrayBuffer>, { name: "HKDF" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, info: info as Uint8Array<ArrayBuffer> },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

async function aes128gcmBody(
  plaintext: Uint8Array,
  receiverPublicRaw: Uint8Array,
  authSecret: Uint8Array
): Promise<Uint8Array> {
  // Ephemeral ECDH key pair (per message, per RFC 8291 §3.4).
  const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const ephemeralPublicRaw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", ecdh.publicKey)) as ArrayBuffer
  );
  const receiver = await crypto.subtle.importKey(
    "raw",
    receiverPublicRaw as Uint8Array<ArrayBuffer>,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: receiver } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      ecdh.privateKey,
      256
    )
  );

  const authInfo = concatBytes(encoder.encode("WebPush: info\0"), receiverPublicRaw, ephemeralPublicRaw);
  const ikm = await hkdfSha256(ecdhSecret, authSecret, authInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdfSha256(ikm, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfSha256(ikm, salt, encoder.encode("Content-Encoding: nonce\0"), 12);

  // Single record: delimiter 0x02 terminates the plaintext.
  const padded = concatBytes(plaintext, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey("raw", cek as Uint8Array<ArrayBuffer>, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as Uint8Array<ArrayBuffer> }, aesKey, padded as Uint8Array<ArrayBuffer>)
  );

  // Content-Encoding: aes128gcm header = salt(16) | rs(4) | idlen(1) | keyid(0)
  const header = new Uint8Array(21);
  header.set(salt, 0);
  header[16] = 0x00;
  header[17] = 0x00;
  header[18] = 0x10; // rs = 4096
  header[19] = 0x00;
  header[20] = 0x00; // idlen = 0
  return concatBytes(header, ciphertext);
}

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Send one Web Push notification. Throws PushError (with statusCode) on failure —
 * 404/410 mean the subscription is gone and should be deleted by the caller.
 */
export async function sendWebPush(sub: PushSubscription, payload: string, ttl = 86400): Promise<void> {
  const env = getWorkerEnv();
  const vapidPublicKey = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const vapidPrivateKey = env.VAPID_PRIVATE_KEY;
  if (!vapidPublicKey || !vapidPrivateKey) {
    throw new PushError("VAPID keys not configured");
  }

  const endpoint = sub.endpoint;
  const audience = new URL(endpoint).origin;
  const jwt = await vapidJwt(audience, vapidPrivateKey, vapidPublicKey);

  const receiverPublicRaw = base64UrlDecode(sub.p256dh);
  const authSecret = base64UrlDecode(sub.auth);
  if (receiverPublicRaw.length !== 65 || authSecret.length !== 16) {
    throw new PushError("Malformed subscription keys");
  }

  const body = await aes128gcmBody(encoder.encode(payload), receiverPublicRaw, authSecret);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${vapidPublicKey}`,
      TTL: String(ttl),
      Urgency: "normal",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
    },
    body: body as Uint8Array<ArrayBuffer>,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new PushError(`Push failed: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`, response.status);
  }
}
