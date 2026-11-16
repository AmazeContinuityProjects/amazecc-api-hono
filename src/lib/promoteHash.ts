import { maskUserID } from "./mask";
import { getWorkerEnv } from "../env";
import { hmacSha256Hex } from "./crypto";

/** Domain-separated HMAC from the shared GENERATOR_KEY. */
export function promoteHash(vtop_id: string): Promise<string> {
  return maskUserID(`post-promotion:${vtop_id.trim().toUpperCase()}`);
}

async function legacyHash(vtop_id: string): Promise<string> {
  const data = new TextEncoder().encode(vtop_id);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Previous ID_SALT format, retained only for one-way row migration. */
async function previousKeyedHash(vtop_id: string): Promise<string | null> {
  const oldSalt = getWorkerEnv().ID_SALT;
  if (!oldSalt) return null;
  const input = `post-promotion:${vtop_id.trim().toUpperCase()}`;
  return (await hmacSha256Hex(new TextEncoder().encode(oldSalt), input)).slice(0, 16);
}

/** Rewrites this user's legacy rows to the keyed hash. Cheap no-op once done. */
export async function migrateLegacyPromotions(
  db: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }> },
  vtop_id: string
): Promise<string> {
  const hash = await promoteHash(vtop_id);
  const legacy = await legacyHash(vtop_id);
  const previous = await previousKeyedHash(vtop_id);
  for (const oldHash of new Set([legacy, previous].filter((value): value is string => !!value))) {
    await db.query(
      `UPDATE post_promotions SET user_hash = $1
         WHERE user_hash = $2
           AND NOT EXISTS (SELECT 1 FROM post_promotions q WHERE q.post_id = post_promotions.post_id AND q.user_hash = $1)`,
      [hash, oldHash]
    );
    await db.query(`DELETE FROM post_promotions WHERE user_hash = $1`, [oldHash]);
  }
  return hash;
}
