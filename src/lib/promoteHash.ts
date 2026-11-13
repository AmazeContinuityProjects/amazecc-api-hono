import { maskUserID } from "./mask";
import { getDbPool } from "./db";

/** Port of src/lib/promoteHash.ts (ID_SALT keyed HMAC, domain-separated). */
export function promoteHash(vtop_id: string): Promise<string> {
  return maskUserID(`post-promotion:${vtop_id.trim().toUpperCase()}`);
}

async function legacyHash(vtop_id: string): Promise<string> {
  const data = new TextEncoder().encode(vtop_id);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Rewrites this user's legacy rows to the keyed hash. Cheap no-op once done. */
export async function migrateLegacyPromotions(
  pool: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }> },
  vtop_id: string
): Promise<string> {
  const hash = await promoteHash(vtop_id);
  const legacy = await legacyHash(vtop_id);
  await pool.query(
    `UPDATE post_promotions SET user_hash = $1
       WHERE user_hash = $2
         AND NOT EXISTS (SELECT 1 FROM post_promotions q WHERE q.post_id = post_promotions.post_id AND q.user_hash = $1)`,
    [hash, legacy]
  );
  await pool.query(`DELETE FROM post_promotions WHERE user_hash = $1`, [legacy]);
  return hash;
}
