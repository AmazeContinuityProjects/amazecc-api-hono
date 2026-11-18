-- Migration 0014: Add critical missing indexes to reduce D1 row reads
-- Resolves full-table scans across high-traffic routes (attendance, marks, curves, social, cabshare, qbank).

-- class_user_marks: prevent full table scans when looking up or updating marks by user_key
CREATE INDEX IF NOT EXISTS idx_class_user_marks_user_key ON class_user_marks (user_key);

-- social_people: prevent full table scans when looking up handles/profiles by register_no
CREATE INDEX IF NOT EXISTS idx_social_people_register_no ON social_people (register_no);

-- qbank_questions: fast lookup of questions for a paper source
CREATE INDEX IF NOT EXISTS idx_qbank_questions_source_id ON qbank_questions (source_id);

-- papers_archive: indexed filtering for past papers by course and approval status
CREATE INDEX IF NOT EXISTS idx_papers_archive_course_approval ON papers_archive (course_code, approval_status);
CREATE INDEX IF NOT EXISTS idx_papers_archive_approval_created ON papers_archive (approval_status, created_at DESC);

-- cabshare: index trips, match events, and notifications
CREATE INDEX IF NOT EXISTS idx_cabshare_trips_user_id ON cabshare_trips (user_id);
CREATE INDEX IF NOT EXISTS idx_cabshare_trips_hub_date_status ON cabshare_trips (hub_id, travel_date, status);
CREATE INDEX IF NOT EXISTS idx_cabshare_match_events_trip_id ON cabshare_match_events (trip_id);
CREATE INDEX IF NOT EXISTS idx_cabshare_match_events_requester ON cabshare_match_events (requester_id);
CREATE INDEX IF NOT EXISTS idx_cabshare_match_events_owner ON cabshare_match_events (owner_id);
CREATE INDEX IF NOT EXISTS idx_cabshare_notifications_user_id ON cabshare_notifications (user_id);

-- bus stops & placements by route
CREATE INDEX IF NOT EXISTS idx_bus_stops_route_id ON bus_stops (route_id);
CREATE INDEX IF NOT EXISTS idx_bus_placements_route_id ON bus_placements (route_id);

-- gorobo wallet entries by order
CREATE INDEX IF NOT EXISTS idx_gorobo_wallet_entries_order_id ON gorobo_wallet_entries (order_id);

-- post promotions by user
CREATE INDEX IF NOT EXISTS idx_post_promotions_user_hash ON post_promotions (user_hash);

-- push subscriptions by vitol status and user
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_vitol ON push_subscriptions (vitol_enabled) WHERE vitol_enabled = 1;
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions (user_id);
