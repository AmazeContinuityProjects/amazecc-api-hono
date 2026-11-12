/**
 * Daily VTOP club-chapter sync, ported from the Next.js background task.
 *
 * Invoked from the queue consumer (`env.SYNC_QUEUE`) rather than inline in
 * the login path: the old code called it fire-and-forget from POST /api/login,
 * which is exactly the "background heavy work" this queue exists for. The DB
 * claim (`claimDailySync`) still guarantees at most one sync per 24h no matter
 * how many logins arrive.
 */
import { getDbPool } from "./db";
import { parseVtopHtml } from "./parsers/auto-parse";
import { vtopPostMenu, readText, type VtopCreds } from "./vtop";

const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

async function ensureSyncStateTable() {
  const pool = getDbPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_sync_state (
      key TEXT PRIMARY KEY,
      last_synced_at TIMESTAMPTZ
    )
  `);
}

/**
 * Returns true if this invocation should perform the sync now.
 * Uses an atomic DB claim so multiple consumers don't all sync at once.
 */
async function claimDailySync(key: string): Promise<boolean> {
  const pool = getDbPool();
  await ensureSyncStateTable();

  const res = await pool.query(
    `INSERT INTO app_sync_state (key, last_synced_at)
     VALUES ($1, NOW())
     ON CONFLICT (key) DO UPDATE
         SET last_synced_at = NOW()
         WHERE app_sync_state.last_synced_at IS NULL
            OR app_sync_state.last_synced_at < NOW() - INTERVAL '24 hours'
     RETURNING last_synced_at`,
    [key]
  );

  return res.rowCount === 1;
}

/** Queue payload for the `clubs-sync` job. */
export interface ClubsSyncJob {
  type: "clubs-sync";
  cookies: string;
  csrf: string;
  authorizedID: string;
}

export async function syncClubsFromVtop(creds: VtopCreds): Promise<void> {
  const shouldSync = await claimDailySync("vtop_clubs");
  if (!shouldSync) return;

  console.log("Background: Syncing VTOP Clubs...");
  const resp = await vtopPostMenu(
    "/vtop/event/swf/student/loadClubChapterEnrollmentPage",
    creds
  );
  const clubHtml = await readText(resp);
  const parsedData = parseVtopHtml(clubHtml);

  if (parsedData.tables && parsedData.tables.length > 0) {
    const pool = getDbPool();
    const query = `
      INSERT INTO club_details (club_id, club_name, mission, description, hiring_process, website, recruitment_link, instagram, whatsapp, poc)
      VALUES ($1, $2, '', '', '', '', '', '', '', '')
      ON CONFLICT (club_id) DO NOTHING;
    `;

    let addedCount = 0;
    for (const row of parsedData.tables[0]!.rows) {
      const rawName = row["Association Name (Type)"] || "";
      if (rawName) {
        const name = rawName.replace(/\([^)]+\)$/, "").trim();
        // Temporary ID based on name since VTOP doesn't give a short acronym
        const clubId = name;

        const result = await pool.query(query, [clubId, name]);
        if (result.rowCount && result.rowCount > 0) {
          addedCount++;
        }
      }
    }
    console.log(`Background: VTOP Clubs sync complete. Added ${addedCount} new clubs.`);
  } else {
    console.log("Background: VTOP Clubs sync complete. No club table found.");
  }
}
