/**
 * Local check for the marks-curve accumulator, against a real local D1 (Miniflare).
 *
 *   npx wrangler d1 migrations apply amazecc-api --local
 *   GENERATOR_KEY=local-test npx tsx scripts/test-marks-curves-local.ts
 *
 * Runs the real recordObservedContributionD1 + statsForClasses with fake students in a
 * throwaway class id, prints what /api/services/curves would return, and exits non-zero
 * if a number is wrong. It cleans its rows up afterwards. Never point it at production.
 */
import { getPlatformProxy } from "wrangler";
import { setWorkerEnv } from "../src/env";
import {
  MIN_PUBLISHED_COUNT,
  ownerKeyFor,
  recordObservedContributionD1,
  statsForClasses,
} from "../src/lib/marksStats";

const CLASS = `LOCALTEST${Date.now()}`;
const TITLE = "Continuous Assessment Test - I";

function sampleStats(xs: number[]) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { count: n, mean, sd };
}

let failures = 0;
function check(label: string, got: { count: number; mean: number; sd: number }, want: { count: number; mean: number; sd: number }) {
  const ok =
    got.count === want.count &&
    Math.abs(got.mean - want.mean) < 1e-9 &&
    Math.abs(got.sd - want.sd) < 1e-9;
  if (!ok) failures++;
  const f = (s: { count: number; mean: number; sd: number }) =>
    `count=${s.count} mean=${s.mean.toFixed(2)} sd=${s.sd.toFixed(2)}`;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      got  ${f(got)}\n      want ${f(want)}`);
}

async function main() {
  const proxy = await getPlatformProxy<{ APP_DB: D1Database }>();
  setWorkerEnv({ APP_DB: proxy.env.APP_DB });
  const db = proxy.env.APP_DB;

  const marks = new Map<string, number>();
  async function fetchAttendance(student: string, cat1: number) {
    const regNo = `24TST${student}`;
    await recordObservedContributionD1(await ownerKeyFor(regNo), regNo, {
      classId: CLASS, scope: "assessment", component: "theory", title: TITLE, mark: cat1, serverObserved: true,
    }, Date.now());
    marks.set(student, cat1);
  }
  const read = async () => Object.values((await statsForClasses([CLASS]))[CLASS]!.assessments)[0]!;
  const hidden = (count: number) => ({ count, mean: 0, sd: 0 });

  try {
    // 1. Three students: below the floor, only the count is published.
    for (const [s, m] of [["001", 62], ["002", 71], ["003", 55]] as const) await fetchAttendance(s, m);
    check("3 students, mean/sd hidden below 5", await read(), hidden(3));

    // 2. Six students: real curve, sample sd.
    for (const [s, m] of [["004", 80], ["005", 48], ["006", 90]] as const) await fetchAttendance(s, m);
    check("6 students, sample sd", await read(), sampleStats([...marks.values()]));

    // 3. Same marks fetched again: nothing changes (no double counting).
    for (const [s, m] of [...marks]) await fetchAttendance(s, m);
    check("everyone re-fetches unchanged marks", await read(), sampleStats([...marks.values()]));

    // 4. A mark is corrected: the scope resets to just that student...
    await fetchAttendance("002", 75);
    check("student 002 corrected 71 -> 75, scope resets", await read(), hidden(1));

    // 5. ...and the others are re-added as they fetch again.
    for (const s of ["001", "003", "004", "005", "006"]) await fetchAttendance(s, marks.get(s)!);
    check("class re-fetches after the correction", await read(), sampleStats([...marks.values()]));
    console.log(`(published floor is ${MIN_PUBLISHED_COUNT})`);
  } finally {
    await db.batch([
      db.prepare("DELETE FROM class_user_marks WHERE class_id = ?").bind(CLASS),
      db.prepare("DELETE FROM class_assessment_stats WHERE class_id = ?").bind(CLASS),
      db.prepare("DELETE FROM class_assessment_metadata WHERE class_id = ?").bind(CLASS),
    ]);
    await proxy.dispose();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
