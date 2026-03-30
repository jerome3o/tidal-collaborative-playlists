-- Add display_name to sessions
ALTER TABLE sessions ADD COLUMN display_name TEXT;

-- Add tidal_user_id to shared_playlists for stable ownership
ALTER TABLE shared_playlists ADD COLUMN owner_tidal_user_id TEXT;

-- Backfill owner_tidal_user_id from sessions
UPDATE shared_playlists SET owner_tidal_user_id = (
  SELECT tidal_user_id FROM sessions WHERE sessions.id = shared_playlists.owner_session_id
);

-- Add tidal_user_id to playlist_members for stable membership
ALTER TABLE playlist_members ADD COLUMN tidal_user_id TEXT;

-- Backfill tidal_user_id from sessions
UPDATE playlist_members SET tidal_user_id = (
  SELECT tidal_user_id FROM sessions WHERE sessions.id = playlist_members.session_id
);
