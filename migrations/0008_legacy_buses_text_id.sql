-- The legacy bus import accepts string IDs, so INTEGER PRIMARY KEY was too narrow.
CREATE TABLE buses_rebuild (
  id TEXT PRIMARY KEY,
  type TEXT,
  route TEXT,
  boarding_points TEXT,
  driver_phone TEXT,
  driver_name TEXT,
  whatsapp_group TEXT,
  bus_location TEXT
);
INSERT OR IGNORE INTO buses_rebuild (id, type, route, boarding_points, driver_phone, driver_name, whatsapp_group, bus_location)
  SELECT CAST(id AS TEXT), type, route, boarding_points, driver_phone, driver_name, whatsapp_group, bus_location FROM buses;
DROP TABLE buses;
ALTER TABLE buses_rebuild RENAME TO buses;
