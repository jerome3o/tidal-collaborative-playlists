-- Reactions: emoji reactions on tracks within a shared playlist
CREATE TABLE IF NOT EXISTS reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shared_playlist_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  track_type TEXT NOT NULL DEFAULT 'tracks',
  session_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shared_playlist_id) REFERENCES shared_playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(shared_playlist_id, track_id, session_id, emoji)
);

-- Comments: threaded comments on tracks within a shared playlist
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shared_playlist_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  track_type TEXT NOT NULL DEFAULT 'tracks',
  session_id TEXT NOT NULL,
  display_name TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shared_playlist_id) REFERENCES shared_playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_reactions_track ON reactions(shared_playlist_id, track_id);
CREATE INDEX IF NOT EXISTS idx_comments_track ON comments(shared_playlist_id, track_id);
