# Dev Log — Tidal Collaborative Playlists

## Session 1 — 2026-03-30 — Initial Build & Iteration

### Research Phase

Researched Tidal's API capabilities extensively. Key findings:

- **Official API** at `https://openapi.tidal.com/v2/`, JSON:API spec compliant
- **Official SDK packages**: `@tidal-music/api` (v0.15.0), `@tidal-music/auth` (v1.6.0)
- **OAuth2 with PKCE** (Authorization Code flow) for user login
- **Auth endpoints**: `https://login.tidal.com/authorize`, `https://auth.tidal.com/v1/oauth2/token`
- **Scopes**: `user.read`, `playlists.read`, `playlists.write`, `collection.read`, `collection.write`
- **Full playlist CRUD** including items management and native collaborator endpoints
- **User profile**: `GET /users/me` returns `firstName`, `lastName`, `email`, `country`
- Developer portal at https://developer.tidal.com — apps start in "Development mode" with strict rate limits, need manual review for production

**Important API quirk discovered during development**: `PUT` is NOT supported on `/playlists/{id}/relationships/items`. Only `GET`, `POST`, `DELETE`, and `PATCH` are supported. The PATCH requires `itemId` (playlist-item ID) and is for reordering, not replacing.

### Architecture Decisions

- **Cloudflare Workers + D1** — single deployment, no separate frontend/backend
- **Hono** framework for routing — lightweight, good CF Workers support
- **Server-side OAuth** — tokens stored in D1, session cookie for browser
- **No build step for frontend** — vanilla JS, served as static assets from `/public`
- **PWA** — manifest.json + service worker for installability
- **Sync strategy**: Bidirectional merge — reads items from ALL playlists (owner + members), deduplicates, POSTs missing items to each playlist. This was chosen over one-way sync so any member can add songs.

### What Was Built

1. **OAuth2 PKCE flow** — `/auth/login` → Tidal → `/auth/callback` → session cookie
2. **Tidal API proxy** — `/api/tidal/*` forwards to Tidal API with auth
3. **Share system** — create share links, join flow creates playlist copy in member's Tidal account
4. **Bidirectional sync** — merges items from all members, POSTs missing items
5. **Cron trigger** — every 15 min background sync of all shared playlists
6. **Frontend auto-poll** — every 3 min while viewing a shared playlist
7. **Emoji reactions** — toggle reactions on tracks, quick emoji picker
8. **Comment threads** — per-track comment threads with display names
9. **Tidal deep links** — tracks and playlists link to `tidal.com/browse/...` which opens the Tidal app on mobile
10. **GitHub Actions** — setup workflow (creates D1 DB, sets secrets) + deploy on merge to main

### Bugs Fixed During Development

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Tidal login error 11102 | `APP_URL` env var was `undefined` (wrangler secret not set) | Hardcoded in `wrangler.toml` `[vars]` since it's not sensitive |
| Sync returning empty errors | Using `PUT` on playlist items endpoint (405 Method Not Allowed with empty body) | Changed to POST-only strategy: read current items, diff, POST missing ones |
| Owner can't see shared playlist after re-login | `owner_session_id` changes every login | Added `owner_tidal_user_id` column, query by `tidal_user_id` |
| Sync fails after owner/member re-login | Old session gone, sync can't find tokens | Look up most recent session by `tidal_user_id` with fallback |
| Playlist creation during join fails silently | Sent `privacy: 'PRIVATE'` (invalid field) | Removed — Tidal defaults are fine |
| GitHub Actions can't push back to repo | Default `GITHUB_TOKEN` lacks write permissions | Added `permissions: contents: write` to workflow |
| Duplicate shared playlists created | No uniqueness check on `tidal_playlist_id` | Added `UNIQUE` constraint + dedup migration |
| Column collision in sync query | `SELECT pm.*, s.*` — both have `id` column | Used explicit column aliases |

### Database Migrations

- `001_dedup_shared_playlists.sql` — Remove duplicate shares, add unique index
- `002_reactions_comments.sql` — Add reactions and comments tables with indexes
- `003_stable_user_ids.sql` — Add `display_name` to sessions, `owner_tidal_user_id` to shared_playlists, `tidal_user_id` to playlist_members, backfill from existing data

### Environment & Secrets

**GitHub Actions Secrets needed:**
- `CLOUDFLARE_API_TOKEN` — "Edit Cloudflare Workers" template from CF dashboard
- `CLOUDFLARE_ACCOUNT_ID` — from CF dashboard sidebar
- `TIDAL_CLIENT_ID` — from https://developer.tidal.com app registration
- `TIDAL_CLIENT_SECRET` — same

**Cloudflare Worker Secrets (set by setup workflow):**
- `TIDAL_CLIENT_ID`
- `TIDAL_CLIENT_SECRET`

**Cloudflare Worker Vars (in wrangler.toml):**
- `TIDAL_AUTH_BASE` = `https://login.tidal.com`
- `TIDAL_API_BASE` = `https://openapi.tidal.com/v2`
- `APP_URL` = `https://tidal-collaborative-playlists.jeromeswannack.workers.dev`

**Tidal Developer Dashboard:**
- Redirect URI must be set to: `https://tidal-collaborative-playlists.jeromeswannack.workers.dev/auth/callback`
- Scopes enabled: `user.read`, `playlists.read`, `playlists.write`, `collection.read`, `collection.write`

### Debug Endpoints

- `/auth/debug` — shows OAuth config (client_id, redirect_uri, scopes)
- `/api/debug/share/:id` — shows shared playlist state, owner/member sessions, token expiry
- `/api/debug/state` — shows all shared playlists, members, and sessions (no tokens)

### Known Issues / TODO

- The debug state endpoint is public — should be removed or secured before production
- The `/auth/debug` endpoint should be removed once OAuth is stable
- Tidal app is in "Development mode" — will need review for production use with more users
- No way to remove a song from the shared playlist (only add) — would need DELETE support
- No pagination in the frontend track list — only shows first page of items
- Comment display names fall back to "Anonymous" if user hasn't logged out/in since the display_name migration
- Old sessions accumulate in D1 — no cleanup/expiry mechanism yet
