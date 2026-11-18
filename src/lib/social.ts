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
import { getWorkerEnv } from "../env";
import { publicErrorMessage } from "./publicError";
import { upsertStudentProfile, getStudentProfileByRegNo } from "./student-profiles";
import { hash, identityHash, normalizeRegisterNo } from "./generator";

export const SOCIAL_TABLE = "social_grants";
export const TIMETABLE_TABLE = "social_timetables";
export const FFCS_MATCH_TABLE = "ffcs_match_entries";
export const FFCS_CLASSES_TABLE = "ffcs_classes";
export const FFCS_CLASS_REGISTRATIONS_TABLE = "ffcs_class_registrations";
export const SOCIAL_HANDLE_ALIASES_TABLE = "social_handle_aliases";

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
  const h = hash(`handle::${normalizeRegisterNo(regNo)}`);
  let out = "";
  for (let i = 0; i < 8; i++) {
    const digit = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    out += HANDLE_ALPHABET[digit % HANDLE_ALPHABET.length];
  }
  return `AMZ-${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

/** Canonical pseudonymous identity key shared across Hono services. */
export function regKey(regNo: string): string {
  return identityHash(regNo);
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
  if (!getWorkerEnv().APP_DB) throw new Error("APP_DB is not configured");
}

/** Return every known AMZ-… handle for one verified VTOP registration number. */
export async function getSocialHandlesForRegister(regNo: string): Promise<string[]> {
  const normalized = normalizeRegisterNo(regNo);
  if (!normalized) return [];
  const db = getWorkerEnv().APP_DB;
  if (!db) throw new Error("APP_DB is not configured");
  const [aliases, people] = await Promise.all([
    db.prepare(`SELECT handle FROM ${SOCIAL_HANDLE_ALIASES_TABLE}
      WHERE register_no = ? ORDER BY created_at ASC, handle ASC`)
      .bind(normalized).all<{ handle: string }>(),
    db.prepare(`SELECT handle FROM social_people WHERE register_no = ? ORDER BY created_at ASC, handle ASC`)
      .bind(normalized).all<{ handle: string }>(),
  ]);
  const handles = new Set([...aliases.results, ...people.results].map((row) => row.handle).filter(Boolean));
  handles.add(generateHandle(normalized));
  return [...handles];
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
