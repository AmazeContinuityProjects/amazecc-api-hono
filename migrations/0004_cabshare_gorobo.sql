CREATE TABLE IF NOT EXISTS cabshare_users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone_number TEXT,
  reg_number TEXT NOT NULL UNIQUE,
  owner_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS cabshare_hubs (
  hub_id INTEGER PRIMARY KEY AUTOINCREMENT,
  hub_name TEXT NOT NULL,
  city TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cabshare_trips (
  trip_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES cabshare_users(user_id),
  hub_id INTEGER NOT NULL REFERENCES cabshare_hubs(hub_id),
  travel_date TEXT NOT NULL,
  preferred_time TEXT NOT NULL,
  tolerance_hours INTEGER NOT NULL DEFAULT 0,
  seat_options TEXT NOT NULL DEFAULT '[]',
  gender_preference TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS cabshare_match_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES cabshare_trips(trip_id),
  requester_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS cabshare_waitlist (
  waitlist_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES cabshare_users(user_id),
  hub_id INTEGER NOT NULL REFERENCES cabshare_hubs(hub_id),
  travel_date TEXT NOT NULL,
  UNIQUE (user_id, hub_id, travel_date)
);

CREATE TABLE IF NOT EXISTS cabshare_notifications (
  notif_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES cabshare_users(user_id),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS cabshare_ratings (
  trip_id INTEGER NOT NULL REFERENCES cabshare_trips(trip_id),
  rater_id INTEGER NOT NULL REFERENCES cabshare_users(user_id),
  ratee_id INTEGER NOT NULL REFERENCES cabshare_users(user_id),
  score INTEGER NOT NULL CHECK (score >= 1 AND score <= 5),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (trip_id, rater_id)
);

CREATE TABLE IF NOT EXISTS cabshare_blocks (
  blocker_id INTEGER NOT NULL REFERENCES cabshare_users(user_id),
  blocked_id INTEGER NOT NULL REFERENCES cabshare_users(user_id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS gorobo_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL,
  base_price REAL NOT NULL DEFAULT 0,
  margin REAL NOT NULL DEFAULT 0,
  category TEXT NOT NULL,
  in_stock INTEGER NOT NULL DEFAULT 1,
  image TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL DEFAULT '',
  stock_quantity INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  location_bin TEXT NOT NULL DEFAULT '',
  datasheet_url TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS gorobo_orders (
  id TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    lower(hex(randomblob(6)))
  ),
  user_name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  items TEXT NOT NULL,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  subtotal REAL NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  gst_pct REAL NOT NULL DEFAULT 18,
  gst_amount REAL NOT NULL DEFAULT 0,
  shipment_cost REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  delivery_mode TEXT NOT NULL DEFAULT 'normal',
  maps_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS gorobo_wallet_entries (
  id TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    lower(hex(randomblob(6)))
  ),
  order_id TEXT NOT NULL REFERENCES gorobo_orders(id) ON DELETE CASCADE,
  party TEXT NOT NULL CHECK (party IN ('customer', 'vendor')),
  kind TEXT NOT NULL CHECK (kind IN ('profit', 'gst', 'cost')),
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled')),
  settled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS gorobo_bundles (
  id TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    lower(hex(randomblob(6)))
  ),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General Kits',
  items TEXT NOT NULL DEFAULT '[]',
  bundle_price REAL NOT NULL DEFAULT 0,
  discount_pct REAL NOT NULL DEFAULT 0,
  image TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
