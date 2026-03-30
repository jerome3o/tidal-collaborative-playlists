-- Remove duplicate shared_playlists for the same tidal_playlist_id,
-- keeping only the oldest one (lowest created_at).
DELETE FROM playlist_members
WHERE shared_playlist_id IN (
  SELECT sp.id FROM shared_playlists sp
  WHERE sp.id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY tidal_playlist_id ORDER BY created_at ASC) as rn
      FROM shared_playlists
    ) WHERE rn = 1
  )
);

DELETE FROM shared_playlists
WHERE id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY tidal_playlist_id ORDER BY created_at ASC) as rn
    FROM shared_playlists
  ) WHERE rn = 1
);

-- Prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_playlists_tidal_id ON shared_playlists(tidal_playlist_id);
