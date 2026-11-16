-- PostgreSQL uses UUIDs for club feed posts, representatives, and promotions.
-- Keep those IDs and their promotion references intact as SQLite text values.
CREATE TABLE club_representatives_uuid (
  id TEXT PRIMARY KEY NOT NULL,
  club_id TEXT NOT NULL,
  vtop_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'representative',
  assigned_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (club_id, vtop_id)
);
INSERT INTO club_representatives_uuid (id, club_id, vtop_id, role, assigned_by, created_at)
SELECT CAST(id AS TEXT), club_id, vtop_id, role, assigned_by, created_at FROM club_representatives;
DROP TABLE club_representatives;
ALTER TABLE club_representatives_uuid RENAME TO club_representatives;
CREATE INDEX club_representatives_vtop_idx ON club_representatives (vtop_id);

CREATE TABLE club_feed_uuid (
  id TEXT PRIMARY KEY NOT NULL,
  club_id TEXT NOT NULL,
  event_id TEXT,
  content TEXT NOT NULL,
  links TEXT NOT NULL DEFAULT '[]',
  image_urls TEXT NOT NULL DEFAULT '[]',
  posted_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO club_feed_uuid (id, club_id, event_id, content, links, image_urls, posted_by, created_at)
SELECT CAST(id AS TEXT), club_id, event_id, content, links, image_urls, posted_by, created_at FROM club_feed;
DROP TABLE club_feed;
ALTER TABLE club_feed_uuid RENAME TO club_feed;
CREATE INDEX club_feed_club_created_idx ON club_feed (club_id, created_at DESC);

CREATE TABLE post_promotions_uuid (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL,
  user_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (post_id, user_hash)
);
INSERT INTO post_promotions_uuid (id, post_id, user_hash, created_at)
SELECT CAST(id AS TEXT), CAST(post_id AS TEXT), user_hash, created_at FROM post_promotions;
DROP TABLE post_promotions;
ALTER TABLE post_promotions_uuid RENAME TO post_promotions;
