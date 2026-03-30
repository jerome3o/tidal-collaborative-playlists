-- Sessions: store user tokens server-side
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  tidal_user_id TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Shared playlists: track which playlists are shared for collaboration
CREATE TABLE IF NOT EXISTS shared_playlists (
  id TEXT PRIMARY KEY,
  tidal_playlist_id TEXT NOT NULL,
  owner_session_id TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_session_id) REFERENCES sessions(id)
);

-- Playlist members: track who has joined a shared playlist
CREATE TABLE IF NOT EXISTS playlist_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shared_playlist_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  their_playlist_id TEXT,
  joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shared_playlist_id) REFERENCES shared_playlists(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(shared_playlist_id, session_id)
);

-- PKCE verifiers: temporary storage during OAuth flow
CREATE TABLE IF NOT EXISTS pkce_state (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  redirect_after TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
