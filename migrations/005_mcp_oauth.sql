-- MCP remote server OAuth: dynamically registered clients, pending consent
-- requests, single-use authorization codes, and issued access/refresh tokens.
-- Tokens are stored as SHA-256 hashes; the plaintext only exists in the
-- response to the MCP client.

CREATE TABLE IF NOT EXISTS mcp_clients (
  client_id TEXT PRIMARY KEY,
  client_secret TEXT,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL, -- JSON array of exact-match redirect URIs
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  created_at INTEGER NOT NULL
);

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
