/**
 * Social shared helpers — hono port.
 *
 * Identity is established via VTOP session (cookies + authorizedID + csrf),
 * exactly like the legacy routes. The reg_no is scraped from VTOP's
 * StudentProfileAllView response — never trusted from the body.
 *
 * Person data lives in student_profiles (keyed by reg_no, plaintext, no
 * masking). Social-specific tables (social_grants, social_timetables,
 * ffcs_*) are created inline here.
 */
import { Hono } from "hono";
import { vtopPostForm, readText, cookieHeader, formParams } from "./vtop";
import { parseStudentProfile } from "./parsers/student-profile";
import { getDbPool } from "./db";
import { publicErrorMessage } from "./publicError";
import { upsertStudentProfile, getStudentProfileByRegNo } from "./student-profiles";
import { hash } from "./generator";

export const SOCIAL_TABLE = "social_grants";
export const TIMETABLE_TABLE = "social_timetables";
export const FFCS_MATCH_TABLE = "ffcs_match_entries";
export const FFCS_CLASSES_TABLE = "ffcs_classes";
export const FFCS_CLASS_REGISTRATIONS_TABLE = "ffcs_class_registrations";

export type CallerIdentity = {
  ownerKey: string;
  displayName: string;
  regNo: string;
  cookies: string;
  authorizedID: string;
  csrf: string;
};

export type CallerResult =
  | { ok: true; caller: CallerIdentity }
  | { ok: false; status: number; error: string; detail?: Record<string, unknown> };

export const VTOP_BASE = "https://vtopcc.vit.ac.in";

/** Handle alphabet: no I, L, O, U — unambiguous when read aloud. */
const HANDLE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Deterministic handle from reg_no via GENERATOR_KEY. */
export function generateHandle(regNo: string): string {
  const h = hash(`handle::${regNo.trim().toUpperCase()}`);
  let out = "";
  for (let i = 0; i < 8; i++) {
    const digit = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    out += HANDLE_ALPHABET[digit % HANDLE_ALPHABET.length];
  }
  return `AMZ-${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

/** Identity key = reg_no itself (plaintext, no masking). */
export function regKey(regNo: string): string {
  return regNo.trim().toUpperCase();
}

/**
 * Establish the caller's identity from VTOP session credentials.
 * Centralised so all social routes share the same IDOR protection:
 * nothing in the request body is an identity assertion.
 */
export async function identifyCaller(body: {
  cookies?: string | string[];
  authorizedID?: string;
  csrf?: string;
  registerNo?: string;
  regNo?: string;
}): Promise<CallerResult> {
  const cookieHeader =
    typeof body.cookies === "string"
      ? body.cookies
      : Array.isArray(body.cookies)
        ? body.cookies.join("; ")
        : body.cookies;
  const { authorizedID, csrf } = body;

  if (!csrf || !authorizedID || !cookieHeader) {
    return {
      ok: false,
      status: 400,
      error: "missing_credentials",
      detail: { detail: "Missing cookies, csrf or authorizedID" },
    };
  }

  try {
    const res = await vtopPostForm(
      "/vtop/studentsRecord/StudentProfileAllView",
      formParams({
        verifyMenu: "true",
        authorizedID: String(authorizedID),
        _csrf: String(csrf),
        nocache: Date.now().toString(),
      }),
      { cookies: cookieHeader, timeoutMs: 20_000 },
    );

    const profile = parseStudentProfile(await readText(res));
    const bodyReg =
      typeof body.registerNo === "string"
        ? body.registerNo.trim()
        : typeof body.regNo === "string"
          ? body.regNo.trim()
          : "";
    const authReg = typeof authorizedID === "string" ? authorizedID.trim() : "";
    const isReg = (s: string) => /^[0-9]{2}[A-Z]{3}[0-9]{4,5}$/i.test(s);

    const validReg =
      (profile.registerNo && isReg(profile.registerNo)
        ? profile.registerNo.toUpperCase()
        : bodyReg && isReg(bodyReg)
          ? bodyReg.toUpperCase()
          : authReg && isReg(authReg)
            ? authReg.toUpperCase()
            : null);

    const regNumber = validReg || profile.registerNo || profile.applicationNumber;
    if (!regNumber) {
      return {
        ok: false,
        status: 401,
        error: "vtop_identity_unresolved",
        detail: {
          detail:
            "VTOP returned no REGISTER NO for these cookies. The session is not this student's, or has expired.",
        },
      };
    }

    const resolvedRegNo = validReg
      ? String(validReg).toUpperCase()
      : isReg(String(regNumber))
        ? String(regNumber).toUpperCase()
        : String(regNumber);

    return {
      ok: true,
      caller: {
        ownerKey: regKey(resolvedRegNo),
        displayName: profile.name || "",
        regNo: resolvedRegNo,
        cookies: cookieHeader,
        authorizedID: String(authorizedID),
        csrf: String(csrf),
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\b401\b|unauthor|\bsession\b|invalid\s*csrf/i.test(message)) {
      return { ok: false, status: 401, error: "vtop_session_expired", detail: { detail: message } };
    }
    console.error("social identifyCaller error:", message);
    return { ok: false, status: 502, error: "vtop_unavailable", detail: { detail: message } };
  }
}

/** Ensure all social tables exist. Safe to call on every request. */
export async function ensureSocialSchema(): Promise<void> {
  const pool = getDbPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SOCIAL_TABLE} (
      grant_id   TEXT PRIMARY KEY,
      owner_a    TEXT NOT NULL,
      owner_b    TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'coarse',
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS social_grants_secret_hash_idx ON ${SOCIAL_TABLE} (secret_hash);
    CREATE INDEX IF NOT EXISTS social_grants_owner_a_idx ON ${SOCIAL_TABLE} (owner_a);
    CREATE INDEX IF NOT EXISTS social_grants_owner_b_idx ON ${SOCIAL_TABLE} (owner_b);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TIMETABLE_TABLE} (
      owner_key         TEXT NOT NULL,
      semester_id       TEXT NOT NULL,
      version           INTEGER NOT NULL DEFAULT 1,
      busy_map          JSONB NOT NULL DEFAULT '{}'::jsonb,
      courses           JSONB NOT NULL DEFAULT '[]'::jsonb,
      slotmap_version   TEXT NOT NULL,
      register_no       TEXT NOT NULL DEFAULT '',
      display_name      TEXT NOT NULL DEFAULT '',
      published_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      client_updated_at TIMESTAMPTZ,
      PRIMARY KEY (owner_key, semester_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${FFCS_MATCH_TABLE} (
      owner_key          TEXT NOT NULL,
      semester_id        TEXT NOT NULL,
      class_ids          TEXT[] NOT NULL DEFAULT '{}',
      source             TEXT NOT NULL CHECK (source IN ('planned', 'registered')),
      discoverable       BOOLEAN NOT NULL DEFAULT TRUE,
      changes_in_window  INTEGER NOT NULL DEFAULT 0,
      window_started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      register_no        TEXT NOT NULL DEFAULT '',
      display_name       TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (owner_key, semester_id)
    );
    CREATE INDEX IF NOT EXISTS ffcs_match_entries_class_ids_gin
      ON ${FFCS_MATCH_TABLE} USING GIN (class_ids);
    CREATE UNIQUE INDEX IF NOT EXISTS ffcs_match_entries_sem_reg_unique
      ON ${FFCS_MATCH_TABLE} (semester_id, register_no) WHERE register_no <> '';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${FFCS_CLASSES_TABLE} (
      semester_id   TEXT NOT NULL,
      class_id      TEXT NOT NULL,
      course_code   TEXT NOT NULL DEFAULT '',
      course_title  TEXT NOT NULL DEFAULT '',
      course_type   TEXT NOT NULL DEFAULT '',
      slot          TEXT NOT NULL DEFAULT '',
      faculty       TEXT NOT NULL DEFAULT '',
      credits       TEXT NOT NULL DEFAULT '',
      room          TEXT NOT NULL DEFAULT '',
      register_nos  TEXT[] NOT NULL DEFAULT '{}',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (semester_id, class_id)
    );
    CREATE INDEX IF NOT EXISTS ffcs_classes_sem_class_idx
      ON ${FFCS_CLASSES_TABLE} (semester_id, class_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${FFCS_CLASS_REGISTRATIONS_TABLE} (
      semester_id   TEXT NOT NULL,
      class_id      TEXT NOT NULL,
      register_no   TEXT NOT NULL,
      display_name  TEXT NOT NULL DEFAULT '',
      handle        TEXT NOT NULL DEFAULT '',
      owner_key     TEXT NOT NULL,
      discoverable  BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (semester_id, class_id, register_no)
    );
    CREATE INDEX IF NOT EXISTS ffcs_class_registrations_sem_reg_idx
      ON ${FFCS_CLASS_REGISTRATIONS_TABLE} (semester_id, register_no);
    CREATE INDEX IF NOT EXISTS ffcs_class_registrations_sem_class_idx
      ON ${FFCS_CLASS_REGISTRATIONS_TABLE} (semester_id, class_id);
  `);
}

export type SocialCourse = {
  code: string;
  title: string;
  type: string;
  slot: string;
  faculty: string;
  credits: string;
  room: string;
};

export type BusyMap = Record<string, { c: string; t: string; v: string }>;
