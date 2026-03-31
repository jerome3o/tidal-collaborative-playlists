-- Add sync lock to prevent concurrent sync operations
ALTER TABLE shared_playlists ADD COLUMN sync_started_at INTEGER;
