-- Migration 0015: Add index on handle for social_handle_aliases to avoid index scans during peer resolution
CREATE INDEX IF NOT EXISTS idx_social_handle_aliases_handle ON social_handle_aliases (handle);
