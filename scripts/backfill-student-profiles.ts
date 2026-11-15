/**
 * Backfill student_profiles from existing social_people and cabshare_users.
 *
 * Run against the shared Postgres (the same DB used by AmazeCC-API legacy and
 * amazecc-api-hono via Hyperdrive):
 *
 *   DATABASE_URL=postgres://... pnpm exec tsx scripts/backfill-student-profiles.ts
 *
 * Idempotent: safe to re-run. Uses upsert, so existing rows are updated with
 * any new display_name/phone_number but never overwritten with empties.
 */
import { upsertStudentProfile, ensureStudentProfilesSchema } from "../src/lib/student-profiles";
import { getDbPool } from "../src/lib/db";

async function main() {
  await ensureStudentProfilesSchema();
  const pool = getDbPool();

  let backfilled = 0;

  // --- From social_people (has register_no, display_name) ---
  try {
    const { rows: socialRows } = await pool.query(
      `SELECT register_no, display_name FROM social_people WHERE register_no <> ''`,
    );
    for (const row of socialRows as Array<{ register_no: string; display_name: string }>) {
      await upsertStudentProfile(row.register_no, {
        display_name: row.display_name,
      });
      backfilled++;
    }
    console.log(`social_people: ${socialRows.length} rows backfilled`);
  } catch (err) {
    console.warn("social_people not found or unreadable (may not exist yet):", err);
  }

  // --- From cabshare_users (has reg_number, name, phone_number) ---
  try {
    const { rows: cabshareRows } = await pool.query(
      `SELECT reg_number, name, phone_number FROM cabshare_users WHERE reg_number <> ''`,
    );
    for (const row of cabshareRows as Array<{
      reg_number: string;
      name: string;
      phone_number: string;
    }>) {
      await upsertStudentProfile(row.reg_number, {
        display_name: row.name,
        phone_number: row.phone_number,
      });
      backfilled++;
    }
    console.log(`cabshare_users: ${cabshareRows.length} rows backfilled`);
  } catch (err) {
    console.warn("cabshare_users not found or unreadable (may not exist yet):", err);
  }

  console.log(`Backfill complete: ${backfilled} profiles upserted into student_profiles`);
  await pool.end();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
