import type { GoroboOrderLine } from "./schema";
import type { Quote } from "./quote";
import type { Queryable } from "../db";

export interface GoroboOrderRow {
  id: string;
  user_name: string;
  phone_number: string;
  items: GoroboOrderLine[];
  total: number;
  status: string;
  subtotal: number;
  discount_pct: number;
  discount_amount: number;
  gst_pct: number;
  gst_amount: number;
  shipment_cost: number;
  notes: string;
  delivery_mode?: string;
  maps_url?: string;
  created_at: string;
}

export interface GoroboOrderJson extends Quote {
  id: string;
  userName: string;
  phoneNumber: string;
  items: GoroboOrderLine[];
  total: number;
  status: string;
  discountPct: number;
  gstPct: number;
  shipmentCost: number;
  notes: string;
  deliveryMode: string;
  mapsUrl?: string;
  createdAt: string;
}

export function mapOrderRow(r: GoroboOrderRow): GoroboOrderJson {
  const subtotal = Number(r.subtotal);
  const discountPct = Number(r.discount_pct);
  const discountAmount = Number(r.discount_amount);
  const gstPct = Number(r.gst_pct);
  const gstAmount = Number(r.gst_amount);
  const shipmentCost = Number(r.shipment_cost);
  const taxable = Math.round((subtotal - discountAmount) * 100) / 100;
  const total = Number(r.total);
  return {
    id: r.id,
    userName: r.user_name,
    phoneNumber: r.phone_number,
    items: Array.isArray(r.items) ? r.items : [],
    status: r.status,
    subtotal,
    discountPct,
    discountAmount,
    taxable,
    gstPct,
    gstAmount,
    shipmentCost,
    total,
    notes: r.notes || "",
    deliveryMode: r.delivery_mode || "normal",
    mapsUrl: r.maps_url || "",
    createdAt: r.created_at,
  };
}

export const ORDER_SELECT = `
  SELECT id, user_name, phone_number, items, total, status, subtotal, discount_pct,
         discount_amount, gst_pct, gst_amount, shipment_cost, notes, delivery_mode, maps_url, created_at
  FROM gorobo_orders
`;

export interface ParsedQuoteBody {
  lines: GoroboOrderLine[];
  discountPct: number;
  gstPct: number;
  shipmentCost: number;
  notes: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Validates a quote-editing payload: line items (inventory + custom), discount
 * (0-10 hard cap), GST %, shipment cost and notes. Resolves inventory lines
 * against the live catalog to snapshot basePrice/margin.
 */
export async function parseQuoteBody(body: unknown, pool: Queryable): Promise<ParsedQuoteBody> {
  const bodyRecord = body as Record<string, unknown>;
  const rawLines = Array.isArray(bodyRecord?.items) ? (bodyRecord.items as unknown[]) : null;
  if (!rawLines || rawLines.length === 0 || rawLines.length > 100) {
    throw new QuoteValidationError("items must be a non-empty array of up to 100 lines");
  }

  const inventoryIds = rawLines
    .filter((l: unknown) => typeof l === "object" && l !== null && !(l as Record<string, unknown>).custom)
    .map((l: unknown) => (l as Record<string, unknown>)?.itemId)
    .filter(Boolean) as string[];

  const catalog = new Map<string, { price: number; base_price: number; margin: number; in_stock: boolean }>();
  if (inventoryIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT id, price, base_price, margin, in_stock FROM gorobo_items WHERE id = ANY($1)`,
      [inventoryIds]
    );
    for (const r of rows) catalog.set(r.id, r);
  }

  const lines: GoroboOrderLine[] = [];
  for (const raw of rawLines) {
    const rawRecord = raw as Record<string, unknown>;
    const quantity = Number(rawRecord?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new QuoteValidationError("each line needs an integer quantity between 1 and 99");
    }

    if (rawRecord?.custom) {
      const name = typeof rawRecord?.name === "string" ? (rawRecord.name as string).trim() : "";
      if (!name || name.length > 100) {
        throw new QuoteValidationError("custom lines need a name of at most 100 characters");
      }
      const unitPrice = Number(rawRecord?.unitPrice);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new QuoteValidationError(`unitPrice for custom line "${name}" must be >= 0`);
      }
      lines.push({ custom: true, name, quantity, unitPrice: round2(unitPrice), basePrice: 0, margin: 0 });
      continue;
    }

    const itemId = typeof rawRecord?.itemId === "string" ? (rawRecord.itemId as string).trim() : "";
    if (!itemId || itemId.length > 64) {
      throw new QuoteValidationError("each inventory line needs a valid itemId");
    }
    const item = catalog.get(itemId);
    if (!item) {
      throw new QuoteValidationError(`Unknown item id: ${itemId}`);
    }
    if (!item.in_stock) {
      throw new QuoteValidationError(`Item "${itemId}" is out of stock`);
    }
    const unitPrice = rawRecord?.unitPrice !== undefined ? Number(rawRecord.unitPrice) : Number(item.price);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new QuoteValidationError(`unitPrice for "${itemId}" must be >= 0`);
    }
    lines.push({
      itemId,
      quantity,
      unitPrice: round2(unitPrice),
      basePrice: Number(item.base_price),
      margin: Number(item.margin),
    });
  }

  const discountPct = bodyRecord?.discountPct !== undefined ? Number(bodyRecord.discountPct) : 0;
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 10) {
    throw new QuoteValidationError("discountPct must be between 0 and 10 (hard cap 10%)");
  }
  const gstPct = bodyRecord?.gstPct !== undefined ? Number(bodyRecord.gstPct) : 18;
  if (!Number.isFinite(gstPct) || gstPct < 0 || gstPct > 100) {
    throw new QuoteValidationError("gstPct must be between 0 and 100");
  }
  const shipmentCost = bodyRecord?.shipmentCost !== undefined ? Number(bodyRecord.shipmentCost) : 0;
  if (!Number.isFinite(shipmentCost) || shipmentCost < 0) {
    throw new QuoteValidationError("shipmentCost must be >= 0");
  }
  const notes = typeof bodyRecord?.notes === "string" ? (bodyRecord.notes as string).trim().slice(0, 500) : "";

  return {
    lines,
    discountPct: round2(discountPct),
    gstPct: round2(gstPct),
    shipmentCost: round2(shipmentCost),
    notes,
  };
}

export class QuoteValidationError extends Error {}
