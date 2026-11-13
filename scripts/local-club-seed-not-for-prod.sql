-- LOCAL-ONLY seed for club admin RBAC verification.
CREATE TABLE IF NOT EXISTS club_representatives (
  club_id TEXT NOT NULL,
  vtop_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'representative',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (club_id, vtop_id)
);
INSERT INTO club_representatives (club_id, vtop_id, role) VALUES
  ('LINUX CLUB', '25BLC1081', 'representative'),
  ('ROBOTICS CLUB', '25BLC1081', 'super-club-rep'),
  ('LINUX CLUB', '24BCE0001', 'representative');
UPDATE "user" SET vtopRegNo = '25BLC1081' WHERE email = 'hono-admin@amaze.local';
UPDATE "user" SET vtopRegNo = '24BCE0001' WHERE email = 'qbank-admin@amaze.local';
