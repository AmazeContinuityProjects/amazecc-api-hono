import type { GoroboOrderLine } from "./schema";

export interface QuoteInput {
  lines: GoroboOrderLine[];
  discountPct: number;
  gstPct: number;
  shipmentCost: number;
}

export interface Quote {
  subtotal: number;
  discountAmount: number;
  taxable: number;
  gstAmount: number;
  shipmentCost: number;
  total: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Quote math (locked with the user):
 *   subtotal        = Σ line.unitPrice * line.quantity
 *   discount_amount = round2(subtotal * discountPct / 100)   // discountPct ∈ [0,10]
 *   taxable         = subtotal − discount_amount
 *   gst_amount      = round2(taxable * gstPct / 100)         // gstPct default 18
 *   total           = taxable + gst_amount + shipment_cost
 */
export function computeQuote({ lines, discountPct, gstPct, shipmentCost }: QuoteInput): Quote {
  const subtotal = round2(lines.reduce((sum, l) => sum + Number(l.unitPrice) * Number(l.quantity), 0));
  const discountAmount = round2((subtotal * discountPct) / 100);
  const taxable = round2(subtotal - discountAmount);
  const gstAmount = round2((taxable * gstPct) / 100);
  const total = round2(taxable + gstAmount + shipmentCost);
  return { subtotal, discountAmount, taxable, gstAmount, shipmentCost, total };
}

/** Total raw (base) cost of the lines — what Amaze must pay the vendor. */
export function baseCostOf(lines: GoroboOrderLine[]): number {
  return round2(lines.reduce((sum, l) => sum + Number(l.basePrice ?? 0) * Number(l.quantity), 0));
}

/**
 * Wallet amounts for a completed order (see docs/admin/04-quote-math.md):
 *   customer/profit = taxable − baseCost     (shipping is a pass-through, not part of profit)
 *   customer/gst    = gstAmount
 *   vendor/cost     = baseCost
 */
export function computeWalletAmounts(quote: Quote, lines: GoroboOrderLine[]): {
  profit: number;
  gst: number;
  cost: number;
} {
  const cost = baseCostOf(lines);
  return {
    profit: round2(quote.taxable - cost),
    gst: quote.gstAmount,
    cost,
  };
}
