-- Initial service-data schema for the dedicated amazecc-api D1 database.
-- Request handlers use APP_DB (D1). Production cutover remains gated on the
-- source-data backfill and verification documented in D1_MIGRATION.md.

CREATE TABLE IF NOT EXISTS student_profiles (
  reg_no TEXT PRIMARY KEY,
  display_name TEXT,
  phone_number TEXT,
  email TEXT,
  branch TEXT,
  semester_id TEXT,
  photo_url TEXT,
  amaze_sub TEXT UNIQUE,
  claim_status TEXT NOT NULL DEFAULT 'incomplete',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS service_enrollments (
  owner_key TEXT NOT NULL,
  service TEXT NOT NULL,
  enrolled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT,
  PRIMARY KEY (owner_key, service)
);
CREATE INDEX IF NOT EXISTS idx_service_enrollments_owner ON service_enrollments (owner_key);

CREATE TABLE IF NOT EXISTS social_people (
  owner_key TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT,
  register_no TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS social_grants (
  grant_id TEXT PRIMARY KEY,
  owner_a TEXT NOT NULL,
  owner_b TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'coarse',
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS social_grants_secret_hash_idx ON social_grants (secret_hash);
CREATE INDEX IF NOT EXISTS social_grants_owner_a_idx ON social_grants (owner_a);
CREATE INDEX IF NOT EXISTS social_grants_owner_b_idx ON social_grants (owner_b);

CREATE TABLE IF NOT EXISTS social_timetables (
  owner_key TEXT NOT NULL,
  semester_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  busy_map TEXT NOT NULL DEFAULT '{}',
  courses TEXT NOT NULL DEFAULT '[]',
  slotmap_version TEXT NOT NULL,
  register_no TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  client_updated_at TEXT,
  PRIMARY KEY (owner_key, semester_id)
);

CREATE TABLE IF NOT EXISTS social_handle_aliases (
  register_no TEXT NOT NULL,
  handle TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (register_no, handle)
);
CREATE INDEX IF NOT EXISTS social_handle_aliases_reg_idx ON social_handle_aliases (register_no);

CREATE TABLE IF NOT EXISTS ffcs_match_entries (
  owner_key TEXT NOT NULL,
  semester_id TEXT NOT NULL,
  class_ids TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL CHECK (source IN ('planned', 'registered')),
  discoverable INTEGER NOT NULL DEFAULT 1,
  changes_in_window INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  register_no TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (owner_key, semester_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ffcs_match_entries_sem_reg_unique
  ON ffcs_match_entries (semester_id, register_no) WHERE register_no <> '';

CREATE TABLE IF NOT EXISTS ffcs_classes (
  semester_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  course_code TEXT NOT NULL DEFAULT '',
  course_title TEXT NOT NULL DEFAULT '',
  course_type TEXT NOT NULL DEFAULT '',
  slot TEXT NOT NULL DEFAULT '',
  faculty TEXT NOT NULL DEFAULT '',
  credits TEXT NOT NULL DEFAULT '',
  room TEXT NOT NULL DEFAULT '',
  register_nos TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (semester_id, class_id)
);
CREATE INDEX IF NOT EXISTS ffcs_classes_sem_class_idx ON ffcs_classes (semester_id, class_id);

CREATE TABLE IF NOT EXISTS ffcs_class_registrations (
  semester_id TEXT NOT NULL,
  class_id TEXT NOT NULL,
  register_no TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL DEFAULT '',
  owner_key TEXT NOT NULL,
  discoverable INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (semester_id, class_id, register_no)
);
CREATE INDEX IF NOT EXISTS ffcs_class_registrations_sem_reg_idx
  ON ffcs_class_registrations (semester_id, register_no);
CREATE INDEX IF NOT EXISTS ffcs_class_registrations_sem_class_idx
  ON ffcs_class_registrations (semester_id, class_id);

CREATE TABLE IF NOT EXISTS class_overall_stats (
  class_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  mean REAL NOT NULL,
  m2 REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS class_assessment_stats (
  class_id TEXT NOT NULL,
  assessment_key TEXT NOT NULL,
  count INTEGER NOT NULL,
  mean REAL NOT NULL,
  m2 REAL NOT NULL,
  PRIMARY KEY (class_id, assessment_key)
);
CREATE TABLE IF NOT EXISTS class_assessment_metadata (
  class_id TEXT NOT NULL,
  assessment_key TEXT NOT NULL,
  component TEXT NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (class_id, assessment_key)
);
CREATE TABLE IF NOT EXISTS class_user_marks (
  class_id TEXT NOT NULL,
  user_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  assessment_key TEXT NOT NULL,
  value_token TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (class_id, user_key, scope, assessment_key)
);
