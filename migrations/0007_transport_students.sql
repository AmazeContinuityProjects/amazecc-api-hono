-- Bus-student entries are maintained by the transport admin routes.
CREATE TABLE IF NOT EXISTS bus_students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL,
  registration_number TEXT NOT NULL DEFAULT '',
  application_number TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_bus_students_route ON bus_students (route_id);
