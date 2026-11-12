import { Hono } from "hono";
export const financeRoute = new Hono();
import { vtopPostForm, readText, formParams, cookieHeader as vtopCookieHeader } from "../../lib/vtop";
import * as cheerio from "cheerio";

import { parseVtopHtml } from "../../lib/parsers/auto-parse";



type Section = "all" | "dues" | "receipts" | "receipt" | "wallet" | "bank" | "library";

const cookieHeader = vtopCookieHeader;

function clean(value: string | undefined | null): string | undefined {
  const v = String(value ?? "")
    .replace(/&nbsp;|\u00a0/g, " ")
    .replace(/&#8377;|₹/g, "₹")
    .replace(/\s+/g, " ")
    .trim();
  return v || undefined;
}

async function postPage(
  url: string,
  creds: { cookies: unknown; authorizedID: string; csrf: string },
  extra: Record<string, string> = {}
) {
  const resp = await vtopPostForm(
    url,
    formParams({
      verifyMenu: "true",
      authorizedID: creds.authorizedID,
      _csrf: creds.csrf,
      nocache: Date.now().toString(),
      ...extra,
    }),
    { cookies: cookieHeader({ cookies: creds.cookies as string | string[] | undefined }), timeoutMs: 20_000 }
  );
  return readText(resp);
}

function parseDues(html: string) {
  const $ = cheerio.load(html);

  const pick = (label: string) => {
    let val = "";
    $("b").each((_, el) => {
      if (val) return;
      const t = $(el).text().replace(/\s+/g, " ").trim();
      if (t.toUpperCase().startsWith(label)) {
        const col = $(el).closest("div");
        const next = col.next();
        const candidate = next.text().replace(/^:\s*/, "").replace(/\s+/g, " ").trim();
        if (candidate) val = candidate;
      }
    });
    return clean(val);
  };

  const infoCells = $("div.container .row .text-primary b");
  const regNo = pick("REGISTER NUMBER") || clean($(infoCells[0]).text().replace(/^:\s*/, ""));
  const name = pick("STUDENT NAME") || clean($(infoCells[1]).text().replace(/^:\s*/, ""));
  const programme = pick("PROGRAMME") || clean($(infoCells[2]).text().replace(/^:\s*/, ""));
  const campus = pick("CAMPUS") || clean($(infoCells[3]).text().replace(/^:\s*/, ""));

  const studentInfo =
    regNo || name || programme || campus
      ? {
          ...(regNo ? { registerNumber: regNo } : {}),
          ...(name ? { studentName: name } : {}),
          ...(programme ? { programme } : {}),
          ...(campus ? { campus } : {}),
        }
      : undefined;

  const msgEl = $("font[color='green'], font[color='Green']");
  let message: string | undefined;
  if (msgEl.length) {
    msgEl.find("script, style").remove();
    message = clean(msgEl.text());
  }
  if (!message) {
    const bodyText = $("body").text().replace(/\s+/g, " ").trim();
    const m = bodyText.match(/(There is no payment dues[^!.]*[!.]?)/i);
    if (m) message = clean(m[1]);
  }

  // Data tables for dues (ignore layout/modal tables with no meaningful headers/rows)
  const hasDuesTable = $("table").toArray().some((t) => {
    const $t = $(t);
    const headerText = $t.find("tr").first().text().toLowerCase();
    return /invoice|amount|due|fee|balance/.test(headerText) && $t.find("tr").length > 1;
  });
  const hasDues = message ? false : hasDuesTable;

  return {
    ...(studentInfo ? { studentInfo } : {}),
    hasDues,
    ...(message ? { message } : {}),
  };
}

function parseReceiptsList(html: string) {
  const $ = cheerio.load(html);
  const $table = $("table.table-bordered").first();
  const receipts: Array<Record<string, string>> = [];
  if (!$table.length) return { receipts };

  $table
    .find("tr")
    .slice(1)
    .each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length < 4) return;
      const receiptNumber = clean($(cells[0]).text());
      if (!receiptNumber) return;

      const actionCell = $(cells[4]);
      const onclick = actionCell.find("button").attr("onclick") || "";
      const keyMatch = onclick.match(/doDuplicateReceipt\(['\"]([^'\"]+)['\"]\)/);
      const receiptKey = keyMatch ? clean(keyMatch[1]) : undefined;
      const applicationNumber = clean(actionCell.find("input[name='applno']").val() as string);
      const campusCode = clean($(cells[3]).text());
      const amount = clean($(cells[2]).text());
      const date = clean($(cells[1]).text());

      const receipt: Record<string, string> = { receiptNumber };
      if (date) receipt.date = date;
      if (amount) receipt.amount = amount;
      if (campusCode) receipt.campusCode = campusCode;
      // Use the receipt key for detail lookups when available (matches VTOP action), else fall back.
      if (receiptKey || applicationNumber) receipt.applNo = receiptKey || applicationNumber!;
      receipts.push(receipt);
    });

  return { receipts };
}

function parseReceiptDetail(html: string) {
  const parsed = parseVtopHtml(html);
  const tables = (parsed.tables || [])
    .map((t) => {
      const rows = (t.rows || [])
        .map((row) => {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(row || {})) {
            const key = String(k).trim();
            const val = clean(v);
            if (key && val) out[key] = val;
          }
          return out;
        })
        .filter((r) => Object.keys(r).length > 0);
      if (!rows.length) return null;
      const headers = (t.headers || []).map((h) => String(h).trim()).filter(Boolean);
      return {
        ...(clean(t.caption) ? { caption: clean(t.caption) } : {}),
        ...(headers.length ? { headers } : {}),
        rows,
      };
    })
    .filter(Boolean);

  return { tables };
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseWallet(html: string) {
  const $ = cheerio.load(html);
  const tables = $("table.table-bordered");
  const ledgers: Array<Record<string, string>[]> = [[], []];

  tables.each((idx, table) => {
    if (idx > 1) return;
    const $table = $(table);
    const headers: string[] = [];
    $table
      .find("tr")
      .first()
      .find("th, td")
      .each((_, cell) => {
        headers.push(normalizeHeader($(cell).text()));
      });

    const findCol = (...needles: string[]) =>
      headers.findIndex((h) => needles.every((n) => h.includes(n)));

    const col = {
      date: findCol("date"),
      receipt: findCol("receipt"),
      type: findCol("type"),
      amount: headers.findIndex((h) => h === "amount" || h.includes("amount")),
      refundAmount: findCol("refund", "amount"),
      balance: findCol("balance"),
      refundDate: findCol("refund", "date"),
      particulars: findCol("particular"),
    };
    const hasHeaderMap = col.date >= 0 || col.amount >= 0 || col.balance >= 0;

    $table
      .find("tr")
      .slice(1)
      .each((_, row) => {
        const cells = $(row).find("td");
        if (!cells.length) return;
        const get = (i: number) => (i >= 0 ? clean($(cells[i]).text()) : undefined);
        const entry: Record<string, string> = {};
        if (hasHeaderMap) {
          const date = get(col.date) ?? get(0);
          const receipt = get(col.receipt) ?? get(1);
          const type = get(col.type) ?? get(2);
          const amount = get(col.amount) ?? get(3);
          const refundAmount = get(col.refundAmount) ?? get(4);
          const balance = get(col.balance) ?? get(5);
          const refundDate = get(col.refundDate) ?? get(6);
          const particulars = get(col.particulars);
          if (date) entry.transactionDate = date;
          if (receipt) entry.receiptNumber = receipt;
          if (type) entry.transactionType = type;
          if (amount) entry.amount = amount;
          if (refundAmount) entry.refundAmount = refundAmount;
          if (balance) entry.bookBalanceAmount = balance;
          if (refundDate) entry.refundDate = refundDate;
          if (particulars) entry.particulars = particulars;
        } else if (cells.length >= 7) {
          const [date, receipt, type, amount, refundAmount, balance, refundDate] = [
            0, 1, 2, 3, 4, 5, 6,
          ].map((i) => clean($(cells[i]).text()));
          if (date) entry.transactionDate = date;
          if (receipt) entry.receiptNumber = receipt;
          if (type) entry.transactionType = type;
          if (amount) entry.amount = amount;
          if (refundAmount) entry.refundAmount = refundAmount;
          if (balance) entry.bookBalanceAmount = balance;
          if (refundDate) entry.refundDate = refundDate;
        }
        if (Object.keys(entry).length) ledgers[idx].push(entry);
      });
  });

  return { ledgerINR: ledgers[0], ledgerUSD: ledgers[1] };
}

function parseBank(html: string) {
  const $ = cheerio.load(html);
  const form = $("#bankInfoStudentForm");
  const values: Record<string, string> = {};

  form.find("input, select").each((_, el) => {
    const name = ($(el).attr("name") || "").trim();
    if (!name) return;
    const tag = ($(el).prop("tagName") || "").toLowerCase();
    let val = "";
    if (tag === "select") val = String($(el).val() || "");
    else val = String($(el).attr("value") || $(el).val() || "");
    const c = clean(val);
    if (c) values[name] = c;
  });

  const bankDetailsDiv = $("#ifscCodeBkFrag");
  const lines: string[] = [];
  if (bankDetailsDiv.length) {
    bankDetailsDiv.find("b").each((_, el) => {
      const t = clean($(el).text());
      if (t) lines.push(t);
    });
  }

  const pick = (...keys: string[]) => keys.map((k) => values[k]).find(Boolean);
  const out: Record<string, unknown> = {};
  const accountNumber = pick("accountNumber", "accountNo");
  const confirmAccountNumber = pick("confirmAccountNumber", "confirmAccountNo");
  const ifscCode = pick("bankMasterIfscCode", "ifscCode");
  const beneficiaryName = pick("beneficiaryName");
  const relationship = pick("relationshipWithStudent");
  const accountType = pick("accountType");
  if (accountNumber) out.accountNumber = accountNumber;
  if (confirmAccountNumber) out.confirmAccountNumber = confirmAccountNumber;
  if (ifscCode) out.ifscCode = ifscCode;
  if (beneficiaryName) out.beneficiaryName = beneficiaryName;
  if (relationship) out.relationshipWithStudent = relationship;
  if (accountType) out.accountType = accountType;
  if (lines[0]) out.bankName = lines[0];
  if (lines[1]) out.branch = lines[1];
  if (lines[2]) out.address = lines[2];

  const known = new Set([
    "accountNumber",
    "accountNo",
    "confirmAccountNumber",
    "confirmAccountNo",
    "bankMasterIfscCode",
    "ifscCode",
    "beneficiaryName",
    "relationshipWithStudent",
    "accountType",
    "_csrf",
    "authorizedID",
    "formMand",
    "studentbaseApplicationNumber",
    "allow",
    "toUpload",
  ]);
  const other: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (known.has(k)) continue;
    if (!v || v === "null" || v === "undefined") continue;
    other[k] = v;
  }
  if (Object.keys(other).length) out.other = other;
  return out;
}

function parseLibraryDues(html: string) {
  const parsed = parseVtopHtml(html);
  const tables = (parsed.tables || [])
    .map((t) => {
      const rows = (t.rows || [])
        .map((r) => {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(r || {})) {
            const c = clean(v);
            if (c) out[String(k).trim()] = c;
          }
          return out;
        })
        .filter((r) => Object.keys(r).length > 0);
      if (!rows.length) return null;
      return {
        ...(clean(t.caption) ? { caption: clean(t.caption) } : {}),
        headers: (t.headers || []).map((h) => String(h).trim()).filter(Boolean),
        rows,
      };
    })
    .filter(Boolean) as Array<{ caption?: string; headers: string[]; rows: Record<string, string>[] }>;

  const books: Array<Record<string, string | number>> = [];
  for (const t of tables) {
    const lower = (h: string) => h.toLowerCase();
    const titleKey = t.headers.find((h) => lower(h).includes("title") || lower(h).includes("book")) || "";
    const amountKey =
      t.headers.find((h) => lower(h).includes("amount") || lower(h).includes("fine") || lower(h).includes("due")) || "";
    const daysKey = t.headers.find((h) => lower(h).includes("overdue") || lower(h).includes("day")) || "";
    const authorKey = t.headers.find((h) => lower(h).includes("author")) || "";
    const isbnKey = t.headers.find((h) => lower(h).includes("isbn")) || "";
    if (!titleKey && !amountKey) continue;
    for (const row of t.rows) {
      const book: Record<string, string | number> = {};
      if (titleKey && row[titleKey]) book.title = row[titleKey];
      if (authorKey && row[authorKey]) book.author = row[authorKey];
      if (isbnKey && row[isbnKey]) book.isbn = row[isbnKey];
      if (amountKey && row[amountKey]) book.dueAmount = row[amountKey];
      if (daysKey && row[daysKey]) {
        const n = parseInt(row[daysKey].replace(/[^0-9-]/g, ""), 10);
        if (!Number.isNaN(n)) book.daysOverdue = n;
        else book.daysOverdue = row[daysKey];
      }
      if (Object.keys(book).length) books.push(book);
    }
  }

  const out: Record<string, unknown> = {};
  if (books.length) out.books = books;
  if (tables.length) out.tables = tables;
  const kv: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.keyValuePairs || {})) {
    const c = clean(v);
    if (c) kv[k] = c;
  }
  if (Object.keys(kv).length) out.keyValuePairs = kv;
  const msg: Record<string, string> = {};
  if (clean(parsed.messages?.warning)) msg.warning = clean(parsed.messages.warning)!;
  if (clean(parsed.messages?.error)) msg.error = clean(parsed.messages.error)!;
  if (clean(parsed.messages?.success)) msg.success = clean(parsed.messages.success)!;
  if (Object.keys(msg).length) out.messages = msg;
  return out;
}

financeRoute.post("/finance", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const { cookies, authorizedID, csrf } = body as Record<string, unknown>;
    const section = String((body as Record<string, unknown>).section || "all") as Section;
    const applNo = clean((body as Record<string, unknown>).applNo as string);

    if (!csrf || !authorizedID) {
      return c.json({ error: "Missing csrf or authorizedID" }, { status: 400 });
    }

    const creds = { cookies, authorizedID: String(authorizedID), csrf: String(csrf) };


    async function fetchReceiptDetail(key?: string) {
      const base = "/vtop/p2p/getReceiptsApplno";
      const attempts: Array<Record<string, string>> = [];
      if (key) {
        attempts.push({ applno: key }, { receiptNumber: key }, { receiptnumber: key }, { recptNo: key });
      } else {
        attempts.push({});
      }
      let best: { tables: unknown[] } = { tables: [] };
      for (const extra of attempts) {
        try {
          const html = await postPage(base, creds, extra);
          const parsed = parseReceiptDetail(html) as { tables: unknown[] };
          if (Array.isArray(parsed.tables) && parsed.tables.length > 0) return parsed;
          if (!best.tables.length) best = parsed;
        } catch {
          // try next variant
        }
      }
      return best;
    }

    if (section === "receipt") {
      return c.json({ success: true, ...(await fetchReceiptDetail(applNo)) });
    }

    const want = (s: Section) => section === "all" || section === s;
    const tasks: Array<[string, Promise<unknown>]> = [];

    if (want("dues")) tasks.push(["dues", postPage("/vtop/p2p/Payments", creds).then(parseDues)]);
    if (want("receipts")) tasks.push(["receipts", postPage("/vtop/p2p/getReceiptsApplno", creds).then(parseReceiptsList)]);
    if (want("wallet")) tasks.push(["wallet", postPage("/vtop/finance/getStudentWallet", creds).then(parseWallet)]);
    if (want("bank")) tasks.push(["bank", postPage("/vtop/studentBankInformation/BankInfoStudent", creds).then(parseBank)]);
    if (want("library")) tasks.push(["library", postPage("/vtop/finance/libraryPayments", creds).then(parseLibraryDues)]);
    if (applNo && want("receipts")) {
      tasks.push(["receiptDetail", fetchReceiptDetail(applNo)]);
    }

    const settled = await Promise.allSettled(tasks.map(([, p]) => p));
    const data: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    settled.forEach((res, i) => {
      const key = tasks[i][0];
      if (res.status === "fulfilled") data[key] = res.value;
      else errors[key] = res.reason instanceof Error ? res.reason.message : String(res.reason);
    });

    return c.json({
      success: Object.keys(errors).length === 0,
      ...data,
      ...(Object.keys(errors).length ? { errors } : {}),
    });
  } catch (err: unknown) {
    console.error("finance route error:", err);
    return c.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
});