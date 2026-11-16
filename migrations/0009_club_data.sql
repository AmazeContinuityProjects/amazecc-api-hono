CREATE TABLE IF NOT EXISTS club_details (
  club_id TEXT PRIMARY KEY,
  club_name TEXT NOT NULL,
  mission TEXT,
  description TEXT,
  hiring_process TEXT,
  website TEXT,
  recruitment_link TEXT,
  instagram TEXT,
  whatsapp TEXT,
  poc TEXT,
  email TEXT,
  poc_phone TEXT,
  logo_url TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS club_representatives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id TEXT NOT NULL,
  vtop_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'representative',
  assigned_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (club_id, vtop_id)
);
CREATE INDEX IF NOT EXISTS club_representatives_vtop_idx ON club_representatives (vtop_id);

CREATE TABLE IF NOT EXISTS club_landing_pages (
  club_id TEXT PRIMARY KEY,
  theme TEXT NOT NULL DEFAULT '{"primary_color":"#3B82F6","mode":"light"}',
  showcase_projects TEXT NOT NULL DEFAULT '[]',
  popular_events TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS club_feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id TEXT NOT NULL,
  event_id TEXT,
  content TEXT NOT NULL,
  links TEXT NOT NULL DEFAULT '[]',
  image_urls TEXT NOT NULL DEFAULT '[]',
  posted_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS club_feed_club_created_idx ON club_feed (club_id, created_at DESC);

CREATE TABLE IF NOT EXISTS post_promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (post_id, user_hash)
);
