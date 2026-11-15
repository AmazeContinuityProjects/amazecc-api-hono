/**
 * GET /api/koha/detail?biblionumber= — Koha MARC biblio + holdings.
 *
 * Koha REST:  GET /public/biblios/{id}       (marc-in-json)
 *             GET /public/biblios/{id}/items
 * Public catalog data; no credentials.
 *
 * NOT MOUNTED: webopaccc is unreachable from Cloudflare's egress (connection
 * blackhole, verified 2026-11-14). Render upstream serves this today.
 */
import { Hono } from "hono";
import { publicErrorMessage } from "../../lib/publicError";
import { kohaOrigin } from "../../lib/koha";

export const kohaDetailRouter = new Hono();

const MARC_TAG = /^[0-9][0-9A-Za-z]{2}$/;

async function fetchJson(url: string, headers?: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; AmazeCC/1.0)",
      ...(headers ?? {}),
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Koha returned ${res.status} for ${url}`);
  }
  return res.json();
}

interface MarcField {
  subfields?: Array<Record<string, string>>;
  ind1?: string;
  ind2?: string;
}

function marcFields(marc: any): Map<string, MarcField[]> {
  const map = new Map<string, MarcField[]>();
  const fields: any[] = Array.isArray(marc?.fields) ? marc.fields : [];
  for (const f of fields) {
    for (const [tag, val] of Object.entries(f)) {
      if (MARC_TAG.test(tag) && val && typeof val === "object") {
        const list = map.get(tag) ?? [];
        list.push(val as MarcField);
        map.set(tag, list);
      }
    }
  }
  return map;
}

function sub(field: MarcField | undefined, code: string): string {
  if (!field?.subfields) return "";
  for (const sf of field.subfields) {
    const v = sf?.[code];
    if (typeof v === "string") return v.trim();
  }
  return "";
}

function subAll(field: MarcField | undefined, code: string): string[] {
  const out: string[] = [];
  if (!field?.subfields) return out;
  for (const sf of field.subfields) {
    const v = sf?.[code];
    if (typeof v === "string") out.push(v.trim());
  }
  return out;
}

function deriveStatus(item: any): string {
  if (item?.not_for_loan_status) return "Not for loan";
  if (item?.damaged_status) return "Damaged";
  if (item?.lost_status) return "Lost";
  if (item?.checked_out_date) return "Checked out";
  return "Available";
}

kohaDetailRouter.get("/detail", async (c) => {
  const biblionumber = new URL(c.req.raw.url).searchParams.get("biblionumber") ?? "";
  if (!/^[0-9]+$/.test(biblionumber)) {
    return Response.json(
      { success: false, error: "biblionumber must be a numeric Koha biblio id" },
      { status: 400 },
    );
  }

  try {
    const base = `${kohaOrigin()}/api/v1/public/biblios/${encodeURIComponent(biblionumber)}`;
    const [marcRes, itemsRes] = await Promise.allSettled([
      fetchJson(base, { Accept: "application/marc-in-json" }),
      fetchJson(`${base}/items`),
    ]);

    if (marcRes.status === "rejected") {
      throw new Error(String(marcRes.reason));
    }
    const marc = marcRes.value;
    const fields = marcFields(marc);

    const title = sub(fields.get("245")?.[0], "a");
    const author = [
      sub(fields.get("100")?.[0], "a"),
      ...(fields.get("700") ?? []).map((f) => sub(f, "a")),
    ]
      .filter(Boolean)
      .join("; ");
    const isbn = sub(fields.get("020")?.[0], "a");
    const edition = sub(fields.get("250")?.[0], "a");
    const publisher = [
      sub(fields.get("260")?.[0], "b"),
      sub(fields.get("260")?.[0], "c") || sub(fields.get("260")?.[1], "c"),
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
    const description = sub(fields.get("300")?.[0], "a");
    const ddc = sub(fields.get("082")?.[0], "a");
    const subjects = (fields.get("650") ?? []).map((f) => sub(f, "a")).filter(Boolean);
    const summary = (fields.get("520") ?? []).map((f) => sub(f, "a")).filter(Boolean).join(" ");

    const rawItems: any[] =
      itemsRes.status === "fulfilled" && Array.isArray(itemsRes.value) ? itemsRes.value : [];
    const holdings = rawItems.map((item) => ({
      itemId: item?.item_id ?? "",
      barcode: item?.external_id ?? "",
      currentLibrary: item?.home_library_id ?? "",
      homeLibrary: item?.holding_library_id ?? "",
      shelvingLocation: item?.location ?? item?.shelving_location ?? "",
      callNumber: item?.call_number ?? "",
      status: deriveStatus(item),
      dateDue: item?.checked_out_date ?? null,
      notes: item?.notes ?? "",
    }));

    return Response.json({
      success: true,
      book: {
        biblionumber,
        title,
        author,
        publisher,
        edition,
        description,
        isbn,
        subjects,
        ddc,
        summary,
        holdings,
      },
    });
  } catch (err: unknown) {
    console.error("[koha] detail error:", err instanceof Error ? err.message : String(err));
    return Response.json(
      { success: false, error: publicErrorMessage(err) },
      { status: 500 },
    );
  }
});
