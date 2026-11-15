/**
 * POST /api/events/register — register for an event.
 *
 * Body: { eid, username?, password?, jsessionid? }
 *
 * Flow: resolve the caller's EventHub session, scrape the event preview for
 * hidden form tokens, submit the registration, and interpret the response.
 * Free events redirect to a success page; paid events redirect to a payment
 * terms page whose form we submit server-side to obtain the final BillDesk /
 * Paytm payload, which is returned as { status: "payment_form", html }.
 */
import { Hono } from "hono";
import * as cheerio from "cheerio";
import { getEventHubCookie } from "../../lib/eventHubAuth";
import { eventHubUrl } from "../../lib/upstreamUrl";
import { publicErrorMessage } from "../../lib/publicError";
import { credentialsRejected } from "./_shared";

export const eventsRegisterRouter = new Hono();

const EVENTHUB_ORIGIN = "https://eventhubcc.vit.ac.in";

eventsRegisterRouter.post("/register", async (c) => {
  try {
    const { username, password, jsessionid, eid } = (await c.req.json().catch(() => ({}))) as {
      username?: string;
      password?: string;
      jsessionid?: string;
      eid?: string | number;
    };

    if (!eid) {
      return Response.json({ error: "Missing eid" }, { status: 400 });
    }

    const cookie = await getEventHubCookie({ username, password, jsessionid });

    if (!cookie) {
      return credentialsRejected(!username && !password);
    }

    // Step 1: fetch event preview to grab hidden tokens
    const previewParams = new URLSearchParams({ eid: String(eid) });
    const previewRes = await fetch(`${EVENTHUB_ORIGIN}/EventHub/eventPreview`, {
      method: "POST",
      body: previewParams,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0",
      },
      signal: AbortSignal.timeout(20_000),
    });

    const html = await previewRes.text();
    const $ = cheerio.load(html);

    // A login form here means the session was rejected, not that the password
    // is wrong. An expired cached session still builds a valid Cookie header.
    if ($('form[action="/EventHub/mainDashboard"]').length > 0) {
      const expired = Boolean(jsessionid);
      return Response.json(
        {
          error: expired
            ? "Event Hub session expired. Log in again to refresh it."
            : "Event Hub authentication failed. Please check your credentials.",
          reason: expired ? "session_expired" : "invalid_credentials",
          reauthenticate: expired,
        },
        { status: 401 },
      );
    }

    // Already registered: the Register button disappears
    const registerButton = $(
      'form[method="POST"] button[formaction="/EventHub/registerEvent"], form[method="POST"] button:contains("Register")',
    );
    if (registerButton.length === 0) {
      return Response.json(
        {
          status: "already_registered",
          message: "You have already registered for this event, or registrations are closed.",
        },
        { status: 200 },
      );
    }

    // Step 2: extract ALL hidden tokens from the form
    const registerParams = new URLSearchParams();
    $('form[method="POST"] input').each((_, el) => {
      const name = $(el).attr("name");
      const value = $(el).val()?.toString() || "";
      if (name) {
        registerParams.append(name, value);
      }
    });

    // The button payload carries id=eid
    registerParams.append("id", String(eid));

    // Step 3: submit registration
    const registerRes = await fetch(`${EVENTHUB_ORIGIN}/EventHub/registerEvent`, {
      method: "POST",
      body: registerParams,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0",
        Origin: EVENTHUB_ORIGIN,
        Referer: `${EVENTHUB_ORIGIN}/EventHub/eventPreview`,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });

    const status = registerRes.status;
    const location = registerRes.headers.get("location") || "";

    if (status === 302 || status === 303) {
      if (location.includes("showPaymentTC")) {
        /*
         * Paid flow: the user lands on the payment Terms & Conditions page.
         * The browser can't submit it (it lacks the EventHub session), so we
         * fetch it, "agree", and submit to obtain the final payment payload.
         * `location` is externally supplied - pin it to Event Hub first.
         */
        let tcUrl: string;
        try {
          tcUrl = eventHubUrl(location);
        } catch {
          return Response.json(
            { error: "Unexpected payment redirect target" },
            { status: 502 },
          );
        }

        const tcRes = await fetch(tcUrl, {
          headers: { Cookie: cookie },
          redirect: "manual",
          signal: AbortSignal.timeout(20_000),
        });

        const tcHtml = await tcRes.text();
        const $tc = cheerio.load(tcHtml);
        const tcFormAction = $tc("form").attr("action");

        if (tcFormAction && tcFormAction.includes("doPtmPayment")) {
          const payData = new URLSearchParams();
          $tc("form input").each((_, el) => {
            const name = $tc(el).attr("name");
            if (name) payData.append(name, $tc(el).val()?.toString() || "");
          });

          // Emulate checking the T&C checkbox
          if (!payData.has("checkbox")) payData.append("checkbox", "on");

          // tcFormAction is parsed from fetched HTML - pin it too.
          let payUrl: string;
          try {
            payUrl = eventHubUrl(tcFormAction);
          } catch {
            return Response.json(
              { error: "Unexpected payment form target" },
              { status: 502 },
            );
          }

          const finalPayRes = await fetch(payUrl, {
            method: "POST",
            body: payData,
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Cookie: cookie,
              Origin: EVENTHUB_ORIGIN,
              Referer: tcUrl,
            },
            redirect: "manual",
            signal: AbortSignal.timeout(20_000),
          });

          if (finalPayRes.status === 200) {
            const finalHtml = await finalPayRes.text();
            const baseInjected = finalHtml.includes("<base")
              ? finalHtml
              : `<base href="${EVENTHUB_ORIGIN}/">\n${finalHtml}`;
            return Response.json({ status: "payment_form", html: baseInjected }, { status: 200 });
          }
        }
      }

      // Redirect to a payment page or a success page
      let finalUrl: string;
      try {
        finalUrl = eventHubUrl(location);
      } catch {
        return Response.json(
          { error: "Unexpected payment redirect target" },
          { status: 502 },
        );
      }
      if (
        location.includes("payment") ||
        location.includes("billdesk") ||
        location.includes("paytm") ||
        location.includes("razorpay")
      ) {
        return Response.json({ status: "payment_required", url: finalUrl }, { status: 200 });
      } else if (location.includes("success") || location.includes("goBackToEventList")) {
        return Response.json(
          { status: "success", message: "Successfully registered!" },
          { status: 200 },
        );
      }
      // Generic fallback
      return Response.json({ status: "redirect", url: finalUrl }, { status: 200 });
    } else if (status === 200) {
      // Rendered a page directly: an auto-submitting payment form, or success/error text
      const bodyText = await registerRes.text();
      const bodyLower = bodyText.toLowerCase();

      const $body = cheerio.load(bodyText);
      const externalForms = $body("form").filter((_, el) => {
        const action = $body(el).attr("action") || "";
        return action.startsWith("http") && !action.includes("eventhubcc.vit.ac.in");
      });

      if (
        externalForms.length > 0 ||
        bodyLower.includes("billdesk") ||
        bodyLower.includes("paytm") ||
        bodyLower.includes("razorpay") ||
        bodyLower.includes("pay") ||
        bodyLower.includes("payment") ||
        bodyText.includes('name="msg"') ||
        bodyText.includes('name="merchant_id"')
      ) {
        // Inject a <base> tag so relative forms submit to Event Hub, not localhost/hono
        const modifiedHtml = bodyText.replace("<head>", `<head><base href="${EVENTHUB_ORIGIN}/">`);
        const finalHtml = modifiedHtml.includes("<base")
          ? modifiedHtml
          : `<base href="${EVENTHUB_ORIGIN}/">\n${bodyText}`;

        return Response.json({ status: "payment_form", html: finalHtml }, { status: 200 });
      }

      // Fallback success
      return Response.json(
        { status: "success", message: "Successfully registered!" },
        { status: 200 },
      );
    } else {
      return Response.json(
        { error: `Registration failed with status ${status}` },
        { status: 400 },
      );
    }
  } catch (err: unknown) {
    console.error("[events] register failed:", err);
    return Response.json({ error: publicErrorMessage(err) }, { status: 500 });
  }
});
