-- Align D1 with the live service-data schema before the verified bulk copy.

ALTER TABLE bus_students ADD COLUMN created_at TEXT;

ALTER TABLE papers_archive ADD COLUMN ocr_logs TEXT;
ALTER TABLE papers_archive ADD COLUMN ocr_progress INTEGER;
ALTER TABLE papers_archive ADD COLUMN ocr_model TEXT;
ALTER TABLE papers_archive ADD COLUMN source_url TEXT;

ALTER TABLE qbank_questions ADD COLUMN status TEXT;
ALTER TABLE qbank_questions ADD COLUMN metadata TEXT;
ALTER TABLE qbank_questions ADD COLUMN has_diagram INTEGER;
ALTER TABLE qbank_questions ADD COLUMN image_urls TEXT;
ALTER TABLE qbank_questions ADD COLUMN page_number INTEGER;
ALTER TABLE qbank_questions ADD COLUMN source_pdf_page INTEGER;

ALTER TABLE social_grants ADD COLUMN secret_enc TEXT;
ALTER TABLE social_grants ADD COLUMN created_by TEXT;
ALTER TABLE social_grants ADD COLUMN expires_at TEXT;

ALTER TABLE cabshare_users ADD COLUMN updated_at TEXT;
ALTER TABLE cabshare_trips ADD COLUMN updated_at TEXT;
ALTER TABLE cabshare_match_events ADD COLUMN updated_at TEXT;
ALTER TABLE cabshare_waitlist ADD COLUMN created_at TEXT;
ALTER TABLE cabshare_notifications RENAME COLUMN notif_id TO id;
ALTER TABLE cabshare_notifications ADD COLUMN action_url TEXT;
ALTER TABLE cabshare_ratings ADD COLUMN rating_id INTEGER;
ALTER TABLE cabshare_blocks ADD COLUMN block_id INTEGER;

ALTER TABLE push_subscriptions ADD COLUMN updated_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cabshare_ratings_legacy_id
  ON cabshare_ratings (rating_id) WHERE rating_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cabshare_blocks_legacy_id
  ON cabshare_blocks (block_id) WHERE block_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS admin_activity_logs (
  id INTEGER PRIMARY KEY,
  admin_user TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  ip_address TEXT,
  created_at TEXT,
  target_user TEXT,
  target_resource TEXT
);

CREATE TABLE IF NOT EXISTS app_sync_state (
  key TEXT PRIMARY KEY,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS bus_routes (
  id INTEGER PRIMARY KEY,
  route_number TEXT NOT NULL,
  route_name TEXT NOT NULL,
  type TEXT NOT NULL,
  driver_name TEXT,
  driver_phone TEXT,
  whatsapp_group TEXT,
  bus_location TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS bus_stops (
  id INTEGER PRIMARY KEY,
  route_id INTEGER NOT NULL,
  stop_order INTEGER NOT NULL,
  stop_name TEXT NOT NULL,
  pickup_time TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS bus_placements (
  id INTEGER PRIMARY KEY,
  route_id INTEGER NOT NULL,
  dispersal_time TEXT NOT NULL,
  zone TEXT NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS class_assessment_stats_legacy (
  migration_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id TEXT,
  assessment_title TEXT,
  count INTEGER,
  mean REAL,
  m2 REAL
);

CREATE TABLE IF NOT EXISTS class_assessment_stats_pre_migration_backup (
  migration_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id TEXT,
  assessment_title TEXT,
  count INTEGER,
  mean REAL,
  m2 REAL
);

CREATE TABLE IF NOT EXISTS class_overall_stats_pre_migration_backup (
  migration_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id TEXT,
  count INTEGER,
  mean REAL,
  m2 REAL
);

CREATE TABLE IF NOT EXISTS class_user_hashes_legacy (
  migration_row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id TEXT,
  user_hash TEXT,
  last_updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS class_details (
  semester_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  course_code TEXT NOT NULL DEFAULT '',
  course_title TEXT NOT NULL DEFAULT '',
  ltpjc TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  component TEXT NOT NULL DEFAULT '',
  slot_raw TEXT NOT NULL DEFAULT '',
  slot_ids TEXT NOT NULL DEFAULT '[]',
  venue TEXT NOT NULL DEFAULT '',
  faculty TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (semester_id, class_id)
);

CREATE TABLE IF NOT EXISTS class_enrollment (
  owner_key TEXT NOT NULL,
  class_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_key, class_id)
);
CREATE INDEX IF NOT EXISTS idx_class_enrollment_class_id ON class_enrollment (class_id);

CREATE TABLE IF NOT EXISTS class_sync_state (
  owner_key TEXT NOT NULL,
  semester_id TEXT NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (owner_key, semester_id)
);

