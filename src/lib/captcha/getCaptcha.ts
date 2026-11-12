/**
 * Fetch the pre-login page, establish a session and extract the captcha.
 * Direct port of the old `getCaptcha` (axios → fetch). Retries up to 10 times
 * on failure and bails after a 20 s wall-clock deadline.
 */
import * as cheerio from "cheerio";
import { getVtopBaseUrl, setCookies } from "../vtop";
import type { CaptchaResult, CaptchaType } from "../../types/data/login";

const MAX_RETRIES = 10;
const DEADLINE_MS = 20_000;
const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 500;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function base64EncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function getCaptcha(): Promise<CaptchaResult> {
  const startedAt = Date.now();
  let lastError = "unknown error";
  const base = getVtopBaseUrl();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const remaining = DEADLINE_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      return {
        error: `Timed out after ${DEADLINE_MS}ms while fetching captcha. Last error: ${lastError}`,
      };
    }
    const budget = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining));

    try {
      // 1. Prime the session: GET /vtop/prelogin/setup (sets the session cookies).
      const setupRes = await fetch(`${base}/vtop/prelogin/setup`, {
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(budget),
      });
      const cookies: string[] = setCookies(setupRes);
      const jar = cookies.map((c) => c.split(";")[0]!.trim()).filter(Boolean).join("; ");
      const setupHtml = await setupRes.text();

      const $ = cheerio.load(setupHtml);
      const csrfValue = $("#stdForm input[name=_csrf]").val();
      const csrf = Array.isArray(csrfValue) ? csrfValue[0] : csrfValue;

      if (!csrf) {
        lastError = "csrf token missing from /vtop/prelogin/setup";
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      // 2. Flag the session for VTOP.
      await fetch(`${base}/vtop/prelogin/setup`, {
        method: "POST",
        headers: {
          Cookie: jar,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": UA,
        },
        body: new URLSearchParams({ _csrf: String(csrf), flag: "VTOP" }).toString(),
        signal: AbortSignal.timeout(budget),
      }).then((r) => r.text()); // drain the body; response is irrelevant

      // 3. Load the login page and read the captcha image.
      const loginRes = await fetch(`${base}/vtop/login`, {
        headers: { Cookie: jar, "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(budget),
      });
      const loginHtml = await loginRes.text();

      const $$ = cheerio.load(loginHtml);
      const captchaType: CaptchaType = $$("input#gResponse").length === 1 ? "GRECAPTCHA" : "DEFAULT";

      if (captchaType === "GRECAPTCHA") {
        lastError = "VTOP served a reCAPTCHA challenge to this server IP";
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      const imgSrc = $$("#captchaBlock img").attr("src");
      if (!imgSrc) {
        lastError = "Captcha image source not found on /vtop/login";
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      let base64: string;
      if (imgSrc.startsWith("data:image")) {
        base64 = imgSrc;
      } else {
        const imgUrl = imgSrc.startsWith("http") ? imgSrc : `${base}${imgSrc}`;
        const imgRes = await fetch(imgUrl, {
          headers: { Cookie: jar, "User-Agent": UA },
          signal: AbortSignal.timeout(budget),
        });
        const buf = new Uint8Array(await imgRes.arrayBuffer());
        base64 = `data:image/jpeg;base64,${base64EncodeBytes(buf)}`;
      }

      return { captchaBase64: base64, cookies, csrf: String(csrf) };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(RETRY_DELAY_MS);
    }
  }

  return {
    error: `Failed to get a DEFAULT captcha after ${MAX_RETRIES} attempts. Last error: ${lastError}`,
  };
}
