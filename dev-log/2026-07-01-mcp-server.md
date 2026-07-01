# Dev Log — Remote MCP Server

## Session — 2026-07-01 — Remote MCP integration (OAuth + tools)

### Goal

Let people connect their AI agent (claude.ai custom connector, Claude Code, MCP
Inspector, etc.) to their Tidal account through this app: search the catalog,
build/edit playlists, and drive the collaborative-playlist features.

### Research

Read the MCP authorization spec (2025-06-18 revision) and Claude's custom
connector docs. What a compliant remote MCP server needs:

- **RFC 9728 Protected Resource Metadata** at `/.well-known/oauth-protected-resource`
  (clients also probe the path-suffixed variant `/.well-known/oauth-protected-resource/mcp`),
  plus a `WWW-Authenticate: Bearer resource_metadata="…"` header on every 401.
- **RFC 8414 Authorization Server Metadata** at `/.well-known/oauth-authorization-server`
  (some clients fall back to `/.well-known/openid-configuration` — serve both).
- **RFC 7591 Dynamic Client Registration** — claude.ai registers itself
  automatically; its redirect is `https://claude.ai/api/mcp/auth_callback`.
  Claude Code and local clients use `http://localhost:<port>/…`, native apps
  use private-use schemes, so registration accepts https, loopback http, and
  non-dangerous custom schemes with **exact-match** validation at authorize time.
- **OAuth 2.1**: authorization code + PKCE **S256 required**, refresh token
  rotation required for public clients, exact redirect URI matching.
- **RFC 8707 resource indicators**: clients send `resource=https://<host>/mcp`;
  we reject unknown resources (`invalid_target`).
- **Transport**: Streamable HTTP. Stateless JSON mode is legal — POST `/mcp`
  answers each JSON-RPC request with a plain JSON body; GET returns 405 when no
  server-initiated stream is offered; batching was removed in 2025-06-18.

Verified Tidal API details against their published OpenAPI spec
(`tidal-music.github.io/tidal-api-reference/tidal-api-oas.json`):

- Search: `GET /searchResults/{query}/relationships/tracks?include=tracks`.
- Batch track metadata: `GET /tracks?filter[id]=…&filter[id]=…&include=artists,albums`
  (repeated params), used to attach artist/album names to search + playlist results.
- Removing playlist items: `DELETE /playlists/{id}/relationships/items` needs
  `data: [{id, type, meta: {itemId}}]` — the playlist-item ID comes back in
  `meta.itemId` on the items GET. Max 50 per request (same as POST).

### Design

Everything lives in the existing worker — no new services:

- `src/mcp.ts` — OAuth authorization server + MCP endpoint, registered onto the
  main Hono app via `registerMcp(app)`.
- `src/tidal.ts` — shared helpers extracted from `worker.ts` (token refresh,
  item fetching, sync engine, owner/member resolution) so worker routes and MCP
  tools use the same code without circular imports.
- **Identity bridge**: the `/mcp/authorize` endpoint requires the app's normal
  Tidal session cookie (bouncing through `/auth/login?redirect=…` if needed),
  shows a consent page, and binds the issued MCP token to the `tidal_user_id`.
  Tool calls resolve the user's *most recent* D1 session and reuse the existing
  `refreshAccessToken()` — the Tidal tokens never leave the server, and the MCP
  client never sees them (per the spec's no-token-passthrough rule).
- **Token storage**: our own opaque tokens (`tcp_at_…`/`tcp_rt_…`), stored as
  SHA-256 hashes in `mcp_tokens`. Access tokens live 1h, refresh tokens 30d
  with rotation on every refresh. Cron cleans up expired rows.
- **CSRF on consent**: the pending authorization is stored server-side
  (`mcp_auth_requests`) and the form carries only an opaque `request_id`; the
  approving cookie session must match the one that opened the page.
- **Scopes**: `playlists:read`, `playlists:write`, `shares:read`,
  `shares:write` — enforced per tool; a client that requests no scope gets all.

### Tools shipped (14)

`whoami`, `list_playlists`, `get_playlist`, `search_tracks`, `create_playlist`,
`add_tracks_to_playlist` (dedupes against existing items),
`remove_tracks_from_playlist` (resolves `meta.itemId`), `list_shared_playlists`,
`get_shared_playlist` (members + reactions + comment counts), `create_share_link`,
`sync_shared_playlist` (participants only, uses the sync lock),
`react_to_track`, `comment_on_track`, `get_track_comments`.

### Migration

`migrations/005_mcp_oauth.sql` adds `mcp_clients`, `mcp_auth_requests`,
`mcp_auth_codes`, `mcp_tokens` (mirrored in `schema.sql`). Deploy workflow runs
it automatically on push to main.

### Notes / follow-ups

- The MCP server is only useful to users who have logged into the web app at
  least once (that's what creates the D1 session with Tidal tokens).
- Revocation is coarse: logging out of the web app clears Tidal tokens, which
  breaks tool calls, but MCP tokens themselves currently live until expiry.
  A `/mcp/revoke` (RFC 7009) endpoint + per-connection management UI would be
  a nice follow-up.
- Search/metadata calls hardcode `countryCode=US` like the rest of the app.
