/**
 * Shared VTOP login attempt — used by /api/remote/login (interactive login)
 * and /api/admin/auth (admin sign-in via VTOP credentials). Verifies the
 * captcha (solved with the bundled MLP), POSTs the credentials, follows the
 * redirect to the dashboard, and reports the outcome.
 */
import * as cheerio from "cheerio";
import {
  vtopPostForm,
  vtopGet,
  readText,
  formParams,
  cookieHeader,
  withDeadline,
  DeadlineError,
  setCookies,
} from "./vtop";
import { getCaptcha } from "./captcha/getCaptcha";
import { solveCaptcha } from "./captcha/solveCaptcha";

export interface VtopLoginSuccess {
  ok: true;
  allCookies: string;
  dashboardHtml: string;
}

export interface VtopLoginFailure {
  ok: false;
  /** User-facing reason. */
  message: string;
  /** HTTP status that fits the failure. */
  status: number;
}

export type VtopLoginOutcome = VtopLoginSuccess | VtopLoginFailure;

const VTOP_PHASE_BUDGET_MS = 50_000;
const VTOP_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Runs the whole pre-login → captcha → login → dashboard dance. Never throws:
 * every failure comes back as a categorized outcome so callers can shape their
 * own error responses.
 */
export async function attemptVtopLogin(
  username: string,
  password: string
): Promise<VtopLoginOutcome> {
  try {
    const { allCookies, dashboardHtml } = await withDeadline(
      (async () => {
        const captchaRes = await getCaptcha();
        if ("error" in captchaRes) {
          throw new Error(captchaRes.error);
        }

        const { captchaBase64, cookies, csrf } = captchaRes;
        const captcha = solveCaptcha(captchaBase64);

        const loginRes = await vtopPostForm(
          "/vtop/login",
          formParams({
            _csrf: String(csrf),
            username: String(username),
            password: String(password),
            captchaStr: captcha,
          }),
          {
            cookies: cookieHeader({ cookies }),
            redirect: "manual",
            timeoutMs: VTOP_REQUEST_TIMEOUT_MS,
          }
        );

        const loginSetCookies = setCookies(loginRes);
        const sessionCookies = [...(cookies || []), ...loginSetCookies];
        const allCookies = sessionCookies
          .map((s) => s.split(";")[0]?.trim() ?? "")
          .filter(Boolean)
          .join("; ");

        const location = loginRes.headers.get("location");
        let dashHtml: string;
        if (loginRes.status === 302 && location) {
          const path =
            location.startsWith("http") || location.startsWith("/")
              ? location
              : `/${location}`;
          dashHtml = await readText(
            await vtopGet(path, { cookies: allCookies, timeoutMs: VTOP_REQUEST_TIMEOUT_MS })
          );
        } else {
          dashHtml = await readText(
            await vtopGet("/vtop/open/page", {
              cookies: allCookies,
              timeoutMs: VTOP_REQUEST_TIMEOUT_MS,
            })
          );
        }

        return { allCookies, dashboardHtml: dashHtml };
      })(),
      VTOP_PHASE_BUDGET_MS,
      `VTOP login did not complete within ${VTOP_PHASE_BUDGET_MS}ms`
    );

    if (/authorizedidx/i.test(dashboardHtml)) {
      return { ok: true, allCookies, dashboardHtml };
    }
    if (/invalid\s*captcha/i.test(dashboardHtml)) {
      return { ok: false, message: "Invalid Captcha", status: 401 };
    }
    if (/invalid\s*(user\s*name|login\s*id|user\s*id)\s*\/\s*password/i.test(dashboardHtml)) {
      return { ok: false, message: "Invalid Username / Password", status: 401 };
    }
    if (/months/i.test(dashboardHtml)) {
      return {
        ok: false,
        message:
          "Please visit VTOP and change your password, it has expired after the usual 3 month period",
        status: 401,
      };
    }
    return { ok: false, message: "Login failed for an unknown reason.", status: 401 };
  } catch (err: unknown) {
    if (err instanceof DeadlineError) {
      return { ok: false, message: "VTOP did not respond in time. Please try again.", status: 504 };
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("attemptVtopLogin error:", message);
    return { ok: false, message: "VTOP did not respond in time. Please try again.", status: 502 };
  }
}

/** Parse csrf + authorizedID from the dashboard HTML, exactly like the login route. */
export function parseDashboardIdentity(dashboardHtml: string, username: string): {
  csrf: string;
  authorizedID: string;
} {
  const $ = cheerio.load(dashboardHtml);
  const csrf = String($('input[name="_csrf"]').val() ?? "");
  let authorizedID =
    String($("#authorizedID").val() ?? "") || String($('input[name="authorizedid"]').val() ?? "");
  if (!authorizedID) authorizedID = String(username).toUpperCase();
  return { csrf, authorizedID };
}
