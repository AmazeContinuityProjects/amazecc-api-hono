-- Migration 0016: indexes for the case-insensitive register-number / owner-key lookups.
--
-- `WHERE UPPER(col) = ?` cannot use a plain index on `col` (including the ones
-- added in 0014), so each of these lookups was a full table scan. D1 insights,
-- 2026-11-18 (24h): ~4.5k rows read per social_people lookup, ~3k per
-- social_timetables lookup, ~19k per ffcs_class_registrations lookup — about
-- 4M of the ~6M rows read that day. SQLite uses an expression index when the
-- query repeats the exact expression, so no query changes are needed.

CREATE INDEX IF NOT EXISTS social_people_upper_reg_idx ON social_people (UPPER(register_no));
CREATE INDEX IF NOT EXISTS social_people_upper_owner_idx ON social_people (UPPER(owner_key));

CREATE INDEX IF NOT EXISTS social_timetables_upper_reg_idx ON social_timetables (UPPER(register_no));
CREATE INDEX IF NOT EXISTS social_timetables_upper_owner_idx ON social_timetables (UPPER(owner_key));

CREATE INDEX IF NOT EXISTS social_grants_upper_owner_a_idx ON social_grants (UPPER(owner_a));
CREATE INDEX IF NOT EXISTS social_grants_upper_owner_b_idx ON social_grants (UPPER(owner_b));

CREATE INDEX IF NOT EXISTS service_enrollments_upper_owner_idx ON service_enrollments (UPPER(owner_key));

CREATE INDEX IF NOT EXISTS ffcs_class_registrations_sem_upper_reg_idx
  ON ffcs_class_registrations (semester_id, UPPER(register_no));
CREATE INDEX IF NOT EXISTS ffcs_class_registrations_sem_upper_owner_idx
  ON ffcs_class_registrations (semester_id, UPPER(owner_key));
CREATE INDEX IF NOT EXISTS ffcs_class_registrations_sem_owner_idx
  ON ffcs_class_registrations (semester_id, owner_key);

-- Without stats the planner preferred the (semester_id, class_id, register_no)
-- PK as a covering index for `SELECT class_id ... WHERE semester_id = ? AND
-- register_no IN (...)`, scanning the whole semester (~4.2k rows per call,
-- ~1.1M/day). Make the register-number index covering too.
DROP INDEX IF EXISTS ffcs_class_registrations_sem_reg_idx;
CREATE INDEX IF NOT EXISTS ffcs_class_registrations_sem_reg_idx
  ON ffcs_class_registrations (semester_id, register_no, class_id);

-- /services/curves without a semesterId looks registrations up by register_no alone.
CREATE INDEX IF NOT EXISTS ffcs_class_registrations_reg_class_idx
  ON ffcs_class_registrations (register_no, class_id);

-- Production has no sqlite_stat1, so the planner guesses; give it real stats
-- so it picks the indexes above.
PRAGMA optimize;
