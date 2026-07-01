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
  tidal_playlist_id TEXT NOT NULL UNIQUE,
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

-- Reactions: emoji reactions on tracks
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

-- Comments: threaded comments on tracks
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

-- MCP OAuth: dynamically registered AI clients (see migrations/005_mcp_oauth.sql)
CREATE TABLE IF NOT EXISTS mcp_clients (
  client_id TEXT PRIMARY KEY,
  client_secret TEXT,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL, -- JSON array of exact-match redirect URIs
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  created_at INTEGER NOT NULL
);

-- MCP OAuth: pending consent requests (short-lived)
CREATE TABLE IF NOT EXISTS mcp_auth_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  resource TEXT,
  created_at INTEGER NOT NULL
);

-- MCP OAuth: single-use authorization codes
CREATE TABLE IF NOT EXISTS mcp_auth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  tidal_user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  resource TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- MCP OAuth: issued tokens (stored as SHA-256 hashes)
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id TEXT PRIMARY KEY,
  access_token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  tidal_user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(tidal_user_id);
