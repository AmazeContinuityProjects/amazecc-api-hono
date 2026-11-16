CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT,
  auth TEXT,
  vitol_enabled INTEGER DEFAULT 0,
  vitol_reminder_day INTEGER DEFAULT 1,
  vitol_reminder_time TEXT DEFAULT '10:00',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS class_data (
  class_id TEXT PRIMARY KEY,
  includes_users TEXT DEFAULT '[]',
  count INTEGER DEFAULT 0,
  mean REAL DEFAULT 0,
  m2 REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
  file_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  extension TEXT,
  name TEXT,
  size INTEGER,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS api_route_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT,
  route TEXT,
  source TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS visitor_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,
  hashed_ip TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS buses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  route TEXT,
  boarding_points TEXT,
  driver_phone TEXT,
  driver_name TEXT,
  whatsapp_group TEXT,
  bus_location TEXT
);

CREATE TABLE IF NOT EXISTS papers_archive (
  source_id TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    lower(hex(randomblob(6)))
  ),
  course_code TEXT,
  title TEXT,
  source_type TEXT,
  exam_year INTEGER,
  file_url TEXT,
  uploader_reg_no TEXT,
  approval_status TEXT DEFAULT 'PENDING',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS qbank_questions (
  question_id TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    lower(hex(randomblob(6)))
  ),
  source_id TEXT REFERENCES papers_archive(source_id) ON DELETE CASCADE,
  question_number TEXT,
  question_text TEXT,
  image_url TEXT,
  question_type TEXT,
  options TEXT,
  correct_answer TEXT,
  marks INTEGER
);

CREATE TABLE IF NOT EXISTS qbank_topics (
  topic_id TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' ||
    lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) ||
    substr(lower(hex(randomblob(2))), 2, 3) || '-' ||
    lower(hex(randomblob(6)))
  ),
  course_code TEXT,
  topic_name TEXT
);

CREATE TABLE IF NOT EXISTS qbank_question_topics (
  question_id TEXT REFERENCES qbank_questions(question_id) ON DELETE CASCADE,
  topic_id TEXT REFERENCES qbank_topics(topic_id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, topic_id)
);

CREATE TABLE IF NOT EXISTS buses_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_number TEXT NOT NULL UNIQUE,
  route_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('AC', 'Non-AC')),
  driver_name TEXT DEFAULT '',
  driver_phone TEXT DEFAULT '',
  whatsapp_group TEXT DEFAULT '',
  bus_location TEXT DEFAULT '',
  supervisor_name TEXT DEFAULT '',
  supervisor_phone TEXT DEFAULT '',
  driver_incharge_name TEXT DEFAULT '',
  driver_incharge_phone TEXT DEFAULT '',
  stops TEXT DEFAULT '[]',
  placements TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS transport_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_number INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS admin_users (
  username TEXT PRIMARY KEY,
  role TEXT DEFAULT 'admin' CHECK (role IN ('superadmin', 'admin')),
  permissions TEXT DEFAULT '["dashboard","qbank","buses","push","fresher-resources","faculty-directories","faculty-directory"]',
  added_by TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user TEXT NOT NULL,
  action TEXT NOT NULL,
  target_resource TEXT DEFAULT '',
  details TEXT DEFAULT '{}',
  ip_address TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_admin_user ON admin_audit_logs (admin_user);

CREATE TABLE IF NOT EXISTS fresher_resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  url TEXT,
  icon TEXT DEFAULT 'ExternalLink',
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  type TEXT DEFAULT 'link' CHECK (type IN ('link', 'text', 'md')),
  content TEXT DEFAULT '',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
