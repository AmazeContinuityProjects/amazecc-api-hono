import { getDbPool, isCircuitBreakerError } from "../db";

export const GOROBO_ITEMS_DDL = `
CREATE TABLE IF NOT EXISTS gorobo_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price NUMERIC(10, 2) NOT NULL,
  category TEXT NOT NULL,
  in_stock BOOLEAN NOT NULL DEFAULT TRUE,
  image TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export const GOROBO_ITEMS_ALTERS = `
ALTER TABLE gorobo_items ADD COLUMN IF NOT EXISTS base_price NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE gorobo_items ADD COLUMN IF NOT EXISTS margin NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE gorobo_items ADD COLUMN IF NOT EXISTS sku TEXT NOT NULL DEFAULT '';
ALTER TABLE gorobo_items ADD COLUMN IF NOT EXISTS stock_quantity INT NOT NULL DEFAULT 0;
ALTER TABLE gorobo_items ADD COLUMN IF NOT EXISTS low_stock_threshold INT NOT NULL DEFAULT 5;
ALTER TABLE gorobo_items ADD COLUMN IF NOT EXISTS location_bin TEXT NOT NULL DEFAULT '';
ALTER TABLE gorobo_items ADD COLUMN IF NOT EXISTS datasheet_url TEXT NOT NULL DEFAULT '';
ALTER TABLE gorobo_items ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
`;

export const GOROBO_ORDERS_DDL = `
CREATE TABLE IF NOT EXISTS gorobo_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  items JSONB NOT NULL,
  total NUMERIC(10, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export const GOROBO_ORDERS_ALTERS = `
ALTER TABLE gorobo_orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE gorobo_orders ADD COLUMN IF NOT EXISTS subtotal NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE gorobo_orders ADD COLUMN IF NOT EXISTS discount_pct NUMERIC(5, 2) NOT NULL DEFAULT 0;
ALTER TABLE gorobo_orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE gorobo_orders ADD COLUMN IF NOT EXISTS gst_pct NUMERIC(5, 2) NOT NULL DEFAULT 18;
ALTER TABLE gorobo_orders ADD COLUMN IF NOT EXISTS gst_amount NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE gorobo_orders ADD COLUMN IF NOT EXISTS shipment_cost NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE gorobo_orders ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
ALTER TABLE gorobo_orders ADD COLUMN IF NOT EXISTS delivery_mode TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE gorobo_orders ADD COLUMN IF NOT EXISTS maps_url TEXT NOT NULL DEFAULT '';
`;

export const GOROBO_WALLET_ENTRIES_DDL = `
CREATE TABLE IF NOT EXISTS gorobo_wallet_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES gorobo_orders(id) ON DELETE CASCADE,
  party TEXT NOT NULL CHECK (party IN ('customer', 'vendor')),
  kind TEXT NOT NULL CHECK (kind IN ('profit', 'gst', 'cost')),
  amount NUMERIC(10, 2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled')),
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export const GOROBO_BUNDLES_DDL = `
CREATE TABLE IF NOT EXISTS gorobo_bundles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General Kits',
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  bundle_price NUMERIC(10, 2) NOT NULL DEFAULT 0,
  discount_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
  image TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export const GOROBO_ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "ready",
  "completed",
  "cancelled",
  "archived"
] as const;

export type GoroboOrderStatus = (typeof GOROBO_ORDER_STATUSES)[number];

let ensured = false;
let ensuring: Promise<void> | null = null;
let lastFailureAt = 0;
const COOLDOWN_MS = 30_000;

/**
 * Idempotently creates (and upgrades) the GoRobo tables if they do not exist yet.
 * Safe to call from any handler before use.
 */
export async function ensureGoroboSchema(): Promise<void> {
  if (ensured) return;
  if (ensuring) return ensuring;

  if (lastFailureAt && Date.now() - lastFailureAt < COOLDOWN_MS) {
    const remaining = Math.ceil((COOLDOWN_MS - (Date.now() - lastFailureAt)) / 1000);
    throw new Error(
      `Database temporarily unavailable (recent failure, retry in ~${remaining}s). If this is ECIRCUITBREAKER / too many authentication failures, verify DATABASE_URL credentials and wait 60s.`
    );
  }

  ensuring = (async () => {
    const pool = getDbPool();
    await pool.query(GOROBO_ITEMS_DDL);
    await pool.query(GOROBO_ITEMS_ALTERS);
    await pool.query(GOROBO_ORDERS_DDL);
    await pool.query(GOROBO_ORDERS_ALTERS);
    await pool.query(GOROBO_WALLET_ENTRIES_DDL);
    await pool.query(GOROBO_BUNDLES_DDL);
  })();

  try {
    await ensuring;
    ensured = true;
    lastFailureAt = 0;
  } catch (error: unknown) {
    lastFailureAt = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    if (isCircuitBreakerError(error)) {
      console.error('[gorobo/schema] ensureGoroboSchema blocked by circuit breaker:', message);
    } else {
      console.error('[gorobo/schema] ensureGoroboSchema failed:', message);
    }
    throw error;
  } finally {
    ensuring = null;
  }
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
