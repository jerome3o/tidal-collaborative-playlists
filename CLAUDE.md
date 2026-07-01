# Tidal Collaborative Playlists

PWA that lets Tidal users share playlists and sync them bidirectionally. Hosted on Cloudflare Workers with D1 for storage.

## Quick Reference

- **Build/type-check**: `npx tsc --noEmit`
- **Dev server**: `npm run dev` (requires `.dev.vars` with secrets — see `.dev.vars.example`)
- **Deploy**: `npm run deploy` (or push to `main` for CI deploy)
- **Init local DB**: `npm run db:init`
- **Run migrations**: `npx wrangler d1 execute tidal-collab-db --remote --file=./migrations/NNN.sql`

## Architecture

Single Cloudflare Worker (Hono framework) serves both the API and static frontend.

```
src/worker.ts     — Web app routes: Tidal OAuth, API proxy, shares, sync, reactions, comments
src/tidal.ts      — Shared helpers: token refresh, playlist item fetching, sync engine
src/mcp.ts        — Remote MCP server + its OAuth 2.1 authorization server
public/           — Static frontend (vanilla JS PWA, no build step)
  app.js          — SPA router, all UI rendering
  style.css       — Dark theme styles
  sw.js           — Service worker for offline PWA
schema.sql        — Full DB schema (for fresh installs)
migrations/       — Incremental D1 migrations (run in order by deploy workflow)
wrangler.toml     — Cloudflare Workers config (D1 binding, cron, env vars)
```

## How the App Works

1. User logs in via **Tidal OAuth2 PKCE** — tokens stored server-side in D1
2. User picks a playlist and creates a **share link**
3. Friend opens link, logs in, clicks **"Join & Create Copy"** — creates a playlist in their Tidal account
4. **Bidirectional sync** merges items from all copies (owner + members), POSTs missing items to each
5. Sync runs: manually (button), auto-poll (3min while page open), cron (every 15min)

## Tidal API Gotchas

- **No PUT on playlist items** — `/playlists/{id}/relationships/items` only supports GET, POST, DELETE, PATCH. Sync uses POST to add missing items.
- **PATCH on items** requires `itemId` (the playlist-item ID, not the track ID) — it's for reordering, not replacing
- **Playlist creation**: don't send `privacy` field — use `accessType: "PUBLIC" | "UNLISTED"` or omit for default
- **Rate limits**: undocumented, app is in "Development mode" with strict quotas. 429s include `retry_after` header.
- **Token expiry**: access tokens last 24h, refresh is handled in `refreshAccessToken()`
- **User profile**: `GET /users/me` returns `firstName`, `lastName` (requires `user.read` scope)
- **Base URL**: `https://openapi.tidal.com/v2/` — all requests need `Accept: application/vnd.api+json`

## Session & Identity Model

Sessions are tied to `tidal_user_id` (stable across re-logins), not just `session_id` (changes each login). All ownership and membership queries use `tidal_user_id` with fallback to `session_id` for backward compatibility. When looking up sessions for sync, always find the **most recent** session for a `tidal_user_id`.

## Database

D1 SQLite with these tables:
- `sessions` — OAuth tokens, tidal_user_id, display_name
- `shared_playlists` — shared playlist links, owner identity
- `playlist_members` — who joined, their playlist copy ID
- `reactions` — emoji reactions per track per user (toggle)
- `comments` — threaded comments per track
- `pkce_state` — temporary PKCE verifiers during OAuth flow
- `mcp_clients` / `mcp_auth_requests` / `mcp_auth_codes` / `mcp_tokens` — MCP OAuth (dynamic client registration, consent requests, hashed access/refresh tokens)

Migrations in `migrations/` are run in filename order by the deploy workflow before deploying.

## Deployment

- **CI/CD**: GitHub Actions deploys on push to `main` (`.github/workflows/deploy.yml`)
- **Setup**: `.github/workflows/setup.yml` (manual dispatch) creates D1 DB, runs schema, sets secrets
- **Secrets needed**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TIDAL_CLIENT_ID`, `TIDAL_CLIENT_SECRET` in GitHub Actions
- **Tidal dashboard**: redirect URI must be `https://tidal-collaborative-playlists.jeromeswannack.workers.dev/auth/callback`

## Remote MCP Server (for end users' AI agents)

The worker doubles as a remote MCP server so users can connect Claude (or any MCP client) to their Tidal account. Implemented in `src/mcp.ts`:

- **Endpoint**: `https://<worker>/mcp` — stateless Streamable HTTP (POST JSON-RPC, JSON responses; GET returns 405; no sessions, no SSE)
- **Auth**: full OAuth 2.1 authorization server — RFC 9728/8414 discovery under `/.well-known/`, RFC 7591 dynamic client registration at `/mcp/register`, PKCE-S256 authorize + consent page at `/mcp/authorize` (requires the app's session cookie; bounces through `/auth/login?redirect=…` when logged out), token endpoint at `/mcp/token` with refresh token rotation
- **Identity bridge**: MCP tokens are bound to `tidal_user_id`; tool calls resolve the user's most recent D1 session and reuse `refreshAccessToken()`. Tidal tokens are never sent to MCP clients.
- **Scopes**: `playlists:read`, `playlists:write`, `shares:read`, `shares:write` — enforced per tool
- **Tools** (14): whoami, list_playlists, get_playlist, search_tracks, create_playlist, add/remove_tracks_to/from_playlist, list/get_shared_playlist(s), create_share_link, sync_shared_playlist, react_to_track, comment_on_track, get_track_comments
- **Logs**: `[mcp]` and `[mcp-oauth]` prefixes; cron cleans expired OAuth rows
- **Connecting from claude.ai**: Settings → Connectors → Add custom connector → paste the `/mcp` URL

## MCP Tools

When Cloudflare MCP tools are available, use them to:
- Read worker logs (look for `[sync]`, `[auth]`, `[join]`, `[manualSync]`, `[fetchItems]` prefixes)
- Query D1 directly to inspect sessions, shared playlists, members
- Check cron trigger execution results

## Debug Endpoints

These exist for troubleshooting (consider removing for production):
- `GET /auth/debug` — shows OAuth config being sent to Tidal
- `GET /api/debug/share/:id` — shared playlist state, member sessions, token expiry
- `GET /api/debug/state` — all shares, members, sessions (no tokens/secrets)

## Dev Log

See `dev-log/` for detailed session notes, bugs encountered, and decisions made.
