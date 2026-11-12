import { StudentProfileData } from "./parsers/student-profile";
import { CredentialsData } from "./parsers/credentials";
import { ProctorData } from "./parsers/proctor";
import { HodDeanData } from "./parsers/hod-dean";
import { BankInfoData } from "./parsers/bank-info";
import { ParsedVtopPage } from "./parsers/auto-parse";

/**
 * Normalizes scraped VTOP payloads into the canonical StudentIdentity JSON shape
 * (mirrors `StudentIdentity` in Amazecc-Kotlin). The client merges this payload
 * directly into its identity store under the ME tier — the highest authority.
 *
 * Rules mirrored from the Kotlin extractor:
 *  - only filled values are emitted (no blanks, no placeholders)
 *  - unknown official labels land in `extras` as KeyValueRows
 *  - tables/fields are passed through in the exact shapes the client deciphers
 */

export interface KeyValueRow {
  label: string;
  value: string;
}

export interface VtopTable {
  caption?: string;
  headers: string[];
  rows: Array<Record<string, string>>;
}

export interface Official {
  role?: string | null;
  name?: string | null;
  designation?: string | null;
  email?: string | null;
  phone?: string | null;
  school?: string | null;
  cabin?: string | null;
  department?: string | null;
  intercom?: string | null;
  facultyId?: string | null;
  photoBase64?: string | null;
  extras?: KeyValueRow[];
}

export interface AccountCredential {
  account: string;
  username: string;
  password: string;
  url?: string | null;
  venueDate: string;
  seatLocation: string;
}

export interface RankInfo {
  name: string;
  rank: string;
}

export interface DayboarderInfo {
  isDayboarder: boolean;
  fields: KeyValueRow[];
}

export interface ApaarInfo {
  hasApaar: boolean;
  fields: KeyValueRow[];
  tables: VtopTable[];
}

export interface BankInfo {
  name?: string | null;
  branch?: string | null;
  address?: string | null;
  fields: KeyValueRow[];
}

export interface StudentIdentity {
  regNo?: string | null;
  name?: string | null;
  email?: string | null;
  mobile?: string | null;
  dob?: string | null;
  gender?: string | null;
  bloodGroup?: string | null;
  photoBase64?: string | null;
  isHosteller?: boolean;
  program?: string | null;
  nationality?: string | null;
  nativeLanguage?: string | null;
  nativeState?: string | null;
  community?: string | null;
  religion?: string | null;
  caste?: string | null;
  physicallyChallenged?: string | null;
  aadharNumber?: string | null;
  currentAddress?: KeyValueRow[];
  permanentAddress?: KeyValueRow[];
  father?: KeyValueRow[];
  mother?: KeyValueRow[];
  guardian?: string | null;
  proctor?: Official | null;
  hodDean?: Official[];
  credentials?: AccountCredential[];
  ranks?: RankInfo[];
  apaar?: ApaarInfo | null;
  bank?: BankInfo | null;
  [key: string]: unknown;
}

/** Kotlin humanizeKey: underscore → space, title-case each word. */
export function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .split(" ")
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function toRows(map: Record<string, unknown> | undefined): KeyValueRow[] {
  if (!map) return [];
  const rows: KeyValueRow[] = [];
  for (const [key, raw] of Object.entries(map)) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    rows.push({ label: humanizeKey(key), value });
  }
  return rows;
}

/** Mirrors Kotlin typedDetails: known labels → typed fields, the rest → extras. */
function detailsToOfficial(
  details: Record<string, string>,
  photoBase64: string | null,
  role: string | null
): Official {
  const typed: {
    name: string | null; designation: string | null; email: string | null;
    phone: string | null; school: string | null; cabin: string | null;
    department: string | null; intercom: string | null; facultyId: string | null;
  } = {
    name: null, designation: null, email: null, phone: null, school: null,
    cabin: null, department: null, intercom: null, facultyId: null,
  };
  const extras: KeyValueRow[] = [];

  for (const [key, raw] of Object.entries(details)) {
    const value = raw.trim();
    if (!value) continue;
    switch (key.toLowerCase().replace(/ /g, "")) {
      case "name": typed.name = value; break;
      case "designation": typed.designation = value; break;
      case "email": typed.email = value; break;
      case "phone":
      case "mobile":
      case "mobilenumber": typed.phone = value; break;
      case "school": typed.school = value; break;
      case "cabin": typed.cabin = value; break;
      case "department": typed.department = value; break;
      case "intercom": typed.intercom = value; break;
      case "facultyid":
      case "faculty_id": typed.facultyId = value; break;
      default: extras.push({ label: humanizeKey(key), value });
    }
  }

  const official: Official = { role: role || null, ...typed };
  official.photoBase64 = photoBase64;
  if (extras.length > 0) official.extras = extras;
  return official;
}

/** Student profile block (StudentProfileAllView) → identity. */
function fromStudentProfile(profile: StudentProfileData): StudentIdentity {
  const result: StudentIdentity = {
    regNo: profile.registerNo || profile.applicationNumber || null,
    name: profile.name || null,
    mobile: profile.mobileNumber || null,
    dob: profile.dob || null,
    gender: profile.gender || null,
    bloodGroup: profile.bloodGroup || null,
    photoBase64: profile.image || null,
    isHosteller: profile.isHosteller === true,
    program: profile.appliedDegree || null,
    nationality: profile.nationality || null,
    nativeLanguage: profile.nativeLanguage || null,
    nativeState: profile.nativeState || null,
    community: profile.community || null,
    religion: profile.religion || null,
    caste: profile.caste || null,
    physicallyChallenged: profile.physicallyChallenged || null,
    aadharNumber: profile.aadharNumber || null,
    guardian: profile.guardian || null,
    currentAddress: toRows(profile.currentAddress),
    permanentAddress: toRows(profile.permanentAddress),
    father: toRows(profile.father),
    mother: toRows(profile.mother),
  };

  if (profile.proctor && Object.keys(profile.proctor).length > 0) {
    result.proctor = detailsToOfficial(profile.proctor, null, "Proctor");
  }
  return result;
}

/** viewProctorDetails → proctor official (photo + details). */
function fromProctor(proctor: ProctorData): Official {
  return detailsToOfficial(proctor.details, proctor.photoBase64, "Proctor");
}

/** viewHodDeanDetails → HoD/Dean officials. */
function fromHodDean(hodDean: HodDeanData): Official[] {
  const officials: Official[] = [];
  for (const person of hodDean.people) {
    const role = person.role?.trim() || null;
    const official = detailsToOfficial(person.details, person.photoBase64, role);
    const typed = official.name || official.designation;
    if (role === null && !typed && (official.extras?.length ?? 0) === 0) continue;
    officials.push(official);
  }
  return officials;
}

/** viewStudentCredentials → linked accounts + ranks. */
function fromCredentials(data: CredentialsData): { credentials: AccountCredential[]; ranks: RankInfo[] } {
  return {
    credentials: data.credentials
      .filter((c) => c.account && c.account.trim())
      .map((c) => ({
        account: c.account,
        username: c.username,
        password: c.defaultCredentials,
        url: c.url || null,
        venueDate: c.venueDate,
        seatLocation: c.seatLocation,
      })),
    ranks: data.ranks
      .filter((r) => r.name && r.rank && r.name.trim() && r.rank.trim())
      .map((r) => ({ name: r.name, rank: r.rank })),
  };
}

function recordToRows(record: Record<string, string>): KeyValueRow[] {
  return Object.entries(record)
    .map(([key, value]) => ({ label: humanizeKey(key), value: value.trim() }))
    .filter((row) => row.value.length > 0);
}

/** apaarid/upload → hasApaar + fields + tables (tables passed through verbatim). */
function fromApaar(parsed: ParsedVtopPage, hasApaar: boolean): ApaarInfo | null {
  if (!hasApaar) return null;
  return {
    hasApaar: true,
    fields: [...recordToRows(parsed.formFields), ...recordToRows(parsed.keyValuePairs)],
    tables: parsed.tables as VtopTable[],
  };
}

/** BankInfoStudent → bank name/branch/address + form fields. */
function fromBankInfo(parsed: BankInfoData): BankInfo | null {
  const bank: BankInfo = { fields: [] };
  if (parsed.bankDetails) {
    bank.name = parsed.bankDetails.bankName;
    bank.branch = parsed.bankDetails.branch;
    bank.address = parsed.bankDetails.address;
  }
  for (const [key, field] of Object.entries(parsed.fields)) {
    const value = field.value?.trim();
    if (!value) continue;
    bank.fields.push({ label: field.label?.trim() || humanizeKey(key), value });
  }
  if (!bank.name && !bank.branch && !bank.address && bank.fields.length === 0) return null;
  return bank;
}

export interface IdentityInputs {
  student: StudentProfileData;
  proctor: ProctorData;
  hodDean: HodDeanData;
  credentials: CredentialsData;
  apaar: ParsedVtopPage;
  hasApaar: boolean;
  bank: BankInfoData;
}

export function buildIdentity(inputs: IdentityInputs): StudentIdentity {
  const identity: StudentIdentity = fromStudentProfile(inputs.student);

  identity.proctor = mergeOfficials(identity.proctor ?? null, fromProctor(inputs.proctor));
  identity.hodDean = fromHodDean(inputs.hodDean);
  const creds = fromCredentials(inputs.credentials);
  identity.credentials = creds.credentials;
  identity.ranks = creds.ranks;
  identity.apaar = fromApaar(inputs.apaar, inputs.hasApaar);
  identity.bank = fromBankInfo(inputs.bank);

  return identity;
}

/** Per-field fill merge: an incoming non-null value wins, nulls never erase. */
function mergeOfficials(base: Official | null, incoming: Official): Official {
  const merged: Record<string, unknown> = { ...(base || {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) merged[key] = value;
    } else if (typeof value === "string") {
      if (value.trim()) merged[key] = value;
    } else if (typeof value === "boolean") {
      if (value) merged[key] = value;
    }
  }
  return merged as Official;
}