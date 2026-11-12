import * as cheerio from "cheerio";

/**
 * Test whether an identifier matches the standard VIT registration number format (e.g. 25BLC1081, 21BCE0001).
 * Typically: 2 digits (admission year) + 2-5 uppercase letters (branch/school) + 3-5 digits (sequence).
 * Purely numeric IDs (e.g. 20626703, 2025001264) are application/enrollment numbers, not registration numbers.
 */
export function isRegistrationNumber(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim().toUpperCase();
  return /^[0-9]{2}[A-Z]{2,5}[0-9]{3,5}$/.test(trimmed);
}

/**
 * Parses the VTOP StudentProfileAllView page into a flat profile object.
 * Shared by /api/student and /api/me.
 */
export interface StudentProfileData {
  applicationNumber?: string;
  registerNo?: string;
  name?: string;
  email?: string;
  dob?: string;
  bloodGroup?: string;
  branch?: string;
  gender?: string;
  isHosteller?: boolean;
  nativeLanguage?: string;
  nativeState?: string;
  physicallyChallenged?: string;
  community?: string;
  religion?: string;
  caste?: string;
  nationality?: string;
  aadharNumber?: string;
  mobileNumber?: string;
  friendMobileNumber?: string;
  currentAddress?: Record<string, string>;
  permanentAddress?: Record<string, string>;
  appliedDegree?: string;
  educationalQualification?: string;
  branchStudied?: string;
  schoolName?: string;
  mediumOfStudy?: string;
  boardUniversity?: string;
  classObtained?: string;
  yearOfPassing?: string;
  monthOfPassing?: string;
  schoolAddress?: string;
  breakInStudy?: string;
  brothers?: string;
  sisters?: string;
  siblingInVIT?: string;
  guardian?: string;
  father?: Record<string, string>;
  mother?: Record<string, string>;
  proctor?: Record<string, string>;
  image?: string;
  [key: string]: unknown;
}

export function parseStudentProfile(html: string): StudentProfileData {
  const $ = cheerio.load(html);
  const profile: StudentProfileData = {};

  // 1. Primary VIT Registration Number, Email & Branch from top header card
  const regNoHeader = $('label[for="no"]').text().trim();
  if (regNoHeader && isRegistrationNumber(regNoHeader)) {
    profile.registerNo = regNoHeader.toUpperCase();
  } else {
    // Check any label containing "REGISTER NUMBER" or "REGISTRATION NUMBER"
    $("label").each((_, el) => {
      const text = $(el).text().trim().toUpperCase();
      if (text.includes("REGISTER NUMBER") || text.includes("REGISTRATION NUMBER") || text.includes("REG NO")) {
        const candidate =
          $(el).next("label").text().trim() ||
          $(el).parent().find('label[for="no"]').text().trim() ||
          $(el).parent().text().replace(text, "").trim();
        if (candidate && isRegistrationNumber(candidate)) {
          profile.registerNo = candidate.toUpperCase();
        }
      }
    });
  }

  const vmail = $('label[for="vmail"]').text().trim();
  if (vmail) profile.email ??= vmail;

  const branchHeader = $('label[for="branchno"]').text().trim();
  if (branchHeader) profile.branch ??= branchHeader;

  const parseAddress = (addressHtml: string): Record<string, string> => {
    const addr: Record<string, string> = {};
    const parts = addressHtml.split(/<br\s*\/?>/i);
    for (const part of parts) {
      const cleaned = $(`<div>${part}</div>`).text().trim();
      if (!cleaned) continue;
      const colonIdx = cleaned.indexOf(":");
      if (colonIdx > 0) {
        const key = cleaned.slice(0, colonIdx).trim().toLowerCase().replace(/\s+/g, "");
        const val = cleaned.slice(colonIdx + 1).trim();
        if (val) addr[key] = val;
      }
    }
    return addr;
  };

  $("table tr").each((_, row) => {
    const cols = $(row).find("td");
    if (cols.length < 2) return;

    const label = cols.eq(0).text().trim();
    const value = cols.eq(1).text().trim();
    const valueHtml = $(cols[1]).html() || "";

    const L = label.toUpperCase();

    if (L.includes("APPLICATION NUMBER")) profile.applicationNumber = value;
    else if (L.includes("STUDENT NAME")) profile.name = value;
    else if (L.includes("DATE OF BIRTH")) profile.dob = value;
    else if (L.includes("BLOOD GROUP")) profile.bloodGroup = value;
    else if (L.includes("PROGRAM / BRANCH") || L.includes("BRANCH")) profile.branch = value;
    else if (L.includes("GENDER")) profile.gender = value;
    else if (L.includes("HOSTEL")) profile.isHosteller = value.toUpperCase() === "HOSTELLER" || value.toUpperCase() === "YES";
    else if (L.includes("NATIVE LANGUAGE")) profile.nativeLanguage = value;
    else if (L.includes("NATIVE STATE")) profile.nativeState = value;
    else if (L.includes("PHYSICALLY CHALLENGED")) profile.physicallyChallenged = value;
    else if (L.includes("COMMUNITY")) profile.community = value;
    else if (L.includes("RELIGION")) profile.religion = value;
    else if (L.includes("CASTE")) profile.caste = value;
    else if (L.includes("NATIONALITY")) profile.nationality = value;
    else if (L.includes("AADHAR") || L.includes("AADHAAR")) profile.aadharNumber = value;
    else if (L.includes("MOBILE NUMBER")) profile.mobileNumber = value;
    else if (L.includes("FRIEND MOBILE")) profile.friendMobileNumber = value;
    else if (L.includes("CURRENT ADDRESS")) profile.currentAddress = parseAddress(valueHtml);
    else if (L.includes("PERMANENT ADDRESS")) profile.permanentAddress = parseAddress(valueHtml);
    else if (L.includes("APPLIED DEGREE")) profile.appliedDegree = value;
    else if (L.includes("EDUCATIONAL QUALIFICATION")) profile.educationalQualification = value;
    else if (L.includes("BRANCH / GROUP STUDIED")) profile.branchStudied = value;
    else if (L.includes("SCHOOL NAME") || L.includes("SCHOOL/COLLEGE NAME")) profile.schoolName = value;
    else if (L.includes("MEDIUM OF STUDY")) profile.mediumOfStudy = value;
    else if (L.includes("BOARD / UNIVERSITY")) profile.boardUniversity = value;
    else if (L.includes("REGISTER NO") || L.includes("REGISTRATION NO") || L.includes("ROLL NO")) {
      if (isRegistrationNumber(value)) {
        profile.registerNo = value.toUpperCase();
      } else {
        profile.schoolRollNo = value;
        if (!profile.registerNo) {
          profile.registerNo = value;
        }
      }
    }
    else if (L.includes("CLASS OBTAINED")) profile.classObtained = value;
    else if (L.includes("YEAR OF PASSING") || L.includes("YEAR OF PASSED")) profile.yearOfPassing = value;
    else if (L.includes("MONTH OF PASSING") || L.includes("MONTH OF PASSED")) profile.monthOfPassing = value;
    else if (L.includes("SCHOOL / COLLEGE ADDRESS") || L.includes("SCHOOL ADDRESS")) profile.schoolAddress = value;
    else if (L.includes("BREAK IN STUDY")) profile.breakInStudy = value;
    else if (L.includes("NO.OF.BROTHERS") || L.includes("NO.OF BROTHERS")) profile.brothers = value;
    else if (L.includes("NO.OF.SISTERS") || L.includes("NO.OF SISTERS")) profile.sisters = value;
    else if (L.includes("BROTHER/SISTER STUDYING") || L.includes("SIBLING")) profile.siblingInVIT = value;
    else if (L.includes("GUARDIAN")) profile.guardian = value;
    else if (L.includes("FACULTY ID")) { profile.proctor ??= {}; profile.proctor.facultyId = value; }
    else if (L.includes("FACULTY NAME")) { profile.proctor ??= {}; profile.proctor.name = value; }
    else if (L.includes("FACULTY DESIGNATION")) { profile.proctor ??= {}; profile.proctor.designation = value; }
    else if (L.includes("FACULTY SCHOOL") || L.includes("SCHOOL")) { profile.proctor ??= {}; profile.proctor.school = value; }
    else if (L.includes("CABIN")) { profile.proctor ??= {}; profile.proctor.cabin = value; }
    else if (L.includes("FACULTY DEPARTMENT")) { profile.proctor ??= {}; profile.proctor.department = value; }
    else if (L.includes("FACULTY EMAIL")) { profile.proctor ??= {}; profile.proctor.email = value; }
    else if (L.includes("INTERCOM")) { profile.proctor ??= {}; profile.proctor.intercom = value; }
    else if (L.includes("FACULTY MOBILE") || L.includes("FACULTY PHONE")) { profile.proctor ??= {}; profile.proctor.mobile = value; }
    else if (L.includes("FATHER NAME")) { profile.father ??= {}; profile.father.name = value; }
    else if (L.includes("FATHER QUALIFICATION")) { profile.father ??= {}; profile.father.qualification = value; }
    else if (L.includes("FATHER OCCUPATION")) { profile.father ??= {}; profile.father.occupation = value; }
    else if (L.includes("FATHER ORGANISATION") || L.includes("FATHER ORGANIZATION")) { profile.father ??= {}; profile.father.organization = value; }
    else if (L.includes("FATHER MOBILE")) { profile.father ??= {}; profile.father.mobile = value; }
    else if (L.includes("FATHER EMAIL")) { profile.father ??= {}; profile.father.email = value; }
    else if (L.includes("FATHER ANNUAL INCOME")) { profile.father ??= {}; profile.father.annualIncome = value; }
    else if (L.includes("FATHER DESIGNATION")) { profile.father ??= {}; profile.father.designation = value; }
    else if (L.includes("FATHER ADDRESS")) { profile.father ??= {}; profile.father.address = value; }
    else if (L.includes("MOTHER NAME")) { profile.mother ??= {}; profile.mother.name = value; }
    else if (L.includes("MOTHER QUALIFICATION")) { profile.mother ??= {}; profile.mother.qualification = value; }
    else if (L.includes("MOTHER OCCUPATION")) { profile.mother ??= {}; profile.mother.occupation = value; }
    else if (L.includes("MOTHER ORGANISATION") || L.includes("MOTHER ORGANIZATION")) { profile.mother ??= {}; profile.mother.organization = value; }
    else if (L.includes("MOTHER MOBILE")) { profile.mother ??= {}; profile.mother.mobile = value; }
    else if (L.includes("MOTHER EMAIL")) { profile.mother ??= {}; profile.mother.email = value; }
    else if (L.includes("MOTHER ANNUAL INCOME")) { profile.mother ??= {}; profile.mother.annualIncome = value; }
    else if (L.includes("MOTHER DESIGNATION")) { profile.mother ??= {}; profile.mother.designation = value; }
    else if (L.includes("MOTHER ADDRESS")) { profile.mother ??= {}; profile.mother.address = value; }
  });

  const imgMatch = html.match(/src="(data:[^"]+base64,[^"]+)"/i) || html.match(/src="(data:image[^"]+)"/i);
  if (imgMatch) {
    profile.image = imgMatch[1];
  }

  // Fallback: If registerNo is still not a valid VIT registration number, look across page text
  if (!profile.registerNo || !isRegistrationNumber(profile.registerNo)) {
    const matches = html.match(/\b([0-9]{2}[A-Z]{2,5}[0-9]{3,5})\b/g);
    if (matches && matches.length > 0) {
      const found = matches.find((m) => isRegistrationNumber(m));
      if (found) profile.registerNo = found.toUpperCase();
    }
  }

  return profile;
}