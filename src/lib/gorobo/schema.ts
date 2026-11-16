import { getWorkerEnv } from "../../env";

export const GOROBO_ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "ready",
  "completed",
  "cancelled",
  "archived",
] as const;

export type GoroboOrderStatus = (typeof GOROBO_ORDER_STATUSES)[number];

/** Require the D1 schema installed by the versioned migrations. */
export async function ensureGoroboSchema(): Promise<void> {
  if (!getWorkerEnv().APP_DB) throw new Error("APP_DB is not configured");
}

export interface GoroboItem {
  id: string;
  name: string;
  description: string;
  price: number;
  base_price: number;
  margin: number;
  category: string;
  in_stock: boolean;
  image: string;
  sku?: string;
  stock_quantity?: number;
  low_stock_threshold?: number;
  location_bin?: string;
  datasheet_url?: string;
  tags?: string[];
  updated_at?: string;
}

/**
 * A single line on an order. Inventory lines use `itemId` + snapshots;
 * custom lines (not in inventory) use `custom: true` + `name`.
 */
export interface GoroboOrderLine {
  itemId?: string;
  name?: string;
  custom?: boolean;
  quantity: number;
  unitPrice: number;
  basePrice?: number;
  margin?: number;
}

export interface GoroboOrderItem {
  itemId: string;
  quantity: number;
}

export interface GoroboWalletEntry {
  id: string;
  order_id: string;
  party: "customer" | "vendor";
  kind: "profit" | "gst" | "cost";
  amount: number;
  status: "pending" | "settled";
  settled_at: string | null;
  created_at: string;
}

export interface GoroboBundle {
  id: string;
  name: string;
  description: string;
  category: string;
  items: GoroboOrderLine[];
  bundle_price: number;
  discount_pct: number;
  image: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
