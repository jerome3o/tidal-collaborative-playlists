// Remote MCP server + OAuth 2.1 authorization server.
//
// Lets AI agents (Claude custom connectors, Claude Code, MCP Inspector, etc.)
// connect to this worker and manage the user's Tidal playlists.
//
// Implements the MCP authorization spec (2025-06-18):
//   - RFC 9728 Protected Resource Metadata  (/.well-known/oauth-protected-resource)
//   - RFC 8414 Authorization Server Metadata (/.well-known/oauth-authorization-server)
//   - RFC 7591 Dynamic Client Registration   (POST /mcp/register)
//   - OAuth 2.1 authorization code + PKCE(S256) + refresh token rotation
//   - RFC 8707 resource indicator validation
//
// Transport: stateless Streamable HTTP — POST /mcp with JSON responses.
// MCP access tokens are minted by us and bound to a tidal_user_id; the user's
// Tidal tokens never leave the server (tool calls proxy through D1 sessions).

import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  type Env,
  generateId,
  sha256Base64Url,
  sha256Hex,
  getSession,
  getLatestSessionForUser,
  refreshAccessToken,
  fetchAllPlaylistItems,
  acquireSyncLock,
  releaseSyncLock,
  syncSharedPlaylist,
  findOwnerSession,
  findMemberEntries,
} from './tidal';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = {
  name: 'tidal-collaborative-playlists',
  title: 'Tidal Collaborative Playlists',
  version: '1.0.0',
};

const ALL_SCOPES = ['playlists:read', 'playlists:write', 'shares:read', 'shares:write'];
const ACCESS_TOKEN_TTL = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days, sliding on refresh
const AUTH_CODE_TTL = 60 * 10; // 10 minutes
const CONSENT_REQUEST_TTL = 60 * 10; // 10 minutes

type Ctx = Context<Env>;

const now = () => Math.floor(Date.now() / 1000);

function mcpResourceUrl(appUrl: string): string {
  return `${appUrl.replace(/\/$/, '')}/mcp`;
}

function normalizeResource(uri: string): string {
  return uri.replace(/\/$/, '').toLowerCase();
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── OAuth metadata documents ─────────────────────────────────────────

function protectedResourceMetadata(appUrl: string) {
  const base = appUrl.replace(/\/$/, '');
  return {
    resource: mcpResourceUrl(base),
    authorization_servers: [base],
    scopes_supported: ALL_SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Tidal Collaborative Playlists MCP',
    resource_documentation: base,
  };
}

function authorizationServerMetadata(appUrl: string) {
  const base = appUrl.replace(/\/$/, '');
  return {
    issuer: base,
    authorization_endpoint: `${base}/mcp/authorize`,
    token_endpoint: `${base}/mcp/token`,
    registration_endpoint: `${base}/mcp/register`,
    scopes_supported: ALL_SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    service_documentation: base,
  };
}

// ── Client registration helpers ──────────────────────────────────────

function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash) return false;
  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  if (scheme === 'https') return true;
  if (scheme === 'http') {
    // Loopback only (Claude Code / local MCP clients)
    return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  }
  // Native apps use private-use URI schemes (RFC 8252), e.g. cursor://, vscode://
  return !['javascript', 'data', 'file', 'vbscript', 'blob'].includes(scheme);
}

// ── Token helpers ────────────────────────────────────────────────────

type McpAuth = {
  tokenId: string;
  clientId: string;
  tidalUserId: string;
  scopes: string[];
};

async function authenticateBearer(c: Ctx): Promise<McpAuth | null> {
  const header = c.req.header('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const tokenHash = await sha256Hex(match[1].trim());
  const row = await c.env.DB.prepare(
    'SELECT * FROM mcp_tokens WHERE access_token_hash = ? AND access_expires_at > ?',
  )
    .bind(tokenHash, now())
    .first();
  if (!row) return null;

  // Best-effort usage tracking; don't block the request on it
  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?')
      .bind(now(), row.id)
      .run(),
  );

  return {
    tokenId: row.id as string,
    clientId: row.client_id as string,
    tidalUserId: row.tidal_user_id as string,
    scopes: ((row.scope as string) || '').split(' ').filter(Boolean),
  };
}

function unauthorized(c: Ctx, description: string) {
  const metaUrl = `${c.env.APP_URL.replace(/\/$/, '')}/.well-known/oauth-protected-resource/mcp`;
  return c.newResponse(
    JSON.stringify({ error: 'invalid_token', error_description: description }),
    401,
    {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer error="invalid_token", error_description="${description}", resource_metadata="${metaUrl}"`,
    },
  );
}

// ── Tidal API helpers for tools ──────────────────────────────────────

type TidalContext = {
  session: Record<string, unknown>;
  token: string;
  apiBase: string;
  db: D1Database;
};

async function getTidalContext(c: Ctx, auth: McpAuth): Promise<TidalContext> {
  const session = await getLatestSessionForUser(c.env.DB, auth.tidalUserId);
  if (!session) {
    throw new Error(
      'No active Tidal session for your account. Open the web app, log in with Tidal again, then retry.',
    );
  }
  const token = await refreshAccessToken(
    c.env.DB,
    session as Record<string, unknown>,
    c.env.TIDAL_CLIENT_ID,
    c.env.TIDAL_CLIENT_SECRET,
  );
  return { session: session as Record<string, unknown>, token, apiBase: c.env.TIDAL_API_BASE, db: c.env.DB };
}

async function tidalFetch(
  ctx: TidalContext,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<Record<string, unknown>> {
  const url = path.startsWith('http') ? path : `${ctx.apiBase}${path}`;
  const resp = await fetch(url, {
    method: init?.method || 'GET',
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: 'application/vnd.api+json',
      ...(init?.body ? { 'Content-Type': 'application/vnd.api+json' } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });

  if (resp.status === 429) {
    const retryAfter = resp.headers.get('retry-after') || 'a bit';
    throw new Error(`Tidal rate limit hit (429). Wait ${retryAfter}s and try again.`);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Tidal API ${init?.method || 'GET'} ${path} failed: HTTP ${resp.status} ${text.slice(0, 500)}`);
  }
  if (resp.status === 204 || resp.headers.get('content-length') === '0') return {};
  const text = await resp.text();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

type JsonApiResource = {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: Array<{ id: string; type: string }> | { id: string; type: string } }>;
  meta?: Record<string, unknown>;
};

type TrackSummary = {
  id: string;
  title: string;
  artists: string[];
  album?: string;
  durationSeconds?: number;
  explicit?: boolean;
  isrc?: string;
  popularity?: number;
  url: string;
};

function parseIsoDuration(iso: unknown): number | undefined {
  if (typeof iso !== 'string') return undefined;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return undefined;
  return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2] || '0', 10) * 60) + Math.round(parseFloat(m[3] || '0'));
}

/** Batch-fetch track metadata (with artist names) for a list of track IDs */
async function fetchTrackSummaries(ctx: TidalContext, trackIds: string[]): Promise<Map<string, TrackSummary>> {
  const result = new Map<string, TrackSummary>();
  const CHUNK = 20;

  for (let i = 0; i < trackIds.length; i += CHUNK) {
    const chunk = trackIds.slice(i, i + CHUNK);
    const params = new URLSearchParams({ countryCode: 'US' });
    params.append('include', 'artists');
    params.append('include', 'albums');
    for (const id of chunk) params.append('filter[id]', id);

    let body: Record<string, unknown>;
    try {
      body = await tidalFetch(ctx, `/tracks?${params}`);
    } catch (e) {
      console.warn(`[mcp] Track metadata batch failed, returning bare IDs: ${e}`);
      for (const id of chunk) {
        result.set(id, { id, title: '(metadata unavailable)', artists: [], url: `https://tidal.com/track/${id}` });
      }
      continue;
    }

    const included = (body.included as JsonApiResource[]) || [];
    const artistNames = new Map<string, string>();
    const albumTitles = new Map<string, string>();
    for (const res of included) {
      if (res.type === 'artists') artistNames.set(res.id, (res.attributes?.name as string) || '');
      if (res.type === 'albums') albumTitles.set(res.id, (res.attributes?.title as string) || '');
    }

    for (const track of (body.data as JsonApiResource[]) || []) {
      const attrs = track.attributes || {};
      const artistRel = track.relationships?.artists?.data;
      const artistIds = Array.isArray(artistRel) ? artistRel.map((a) => a.id) : [];
      const albumRel = track.relationships?.albums?.data;
      const albumIds = Array.isArray(albumRel) ? albumRel.map((a) => a.id) : [];
      result.set(track.id, {
        id: track.id,
        title: (attrs.title as string) || '(untitled)',
        artists: artistIds.map((id) => artistNames.get(id)).filter(Boolean) as string[],
        album: albumIds.map((id) => albumTitles.get(id)).filter(Boolean)[0],
        durationSeconds: parseIsoDuration(attrs.duration),
        explicit: attrs.explicit as boolean | undefined,
        isrc: attrs.isrc as string | undefined,
        popularity: attrs.popularity as number | undefined,
        url: `https://tidal.com/track/${track.id}`,
      });
    }
  }

  return result;
}

// ── Tool definitions ─────────────────────────────────────────────────

type ToolDef = {
  name: string;
  title: string;
  description: string;
  scope: string | null;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
  handler: (c: Ctx, auth: McpAuth, args: Record<string, unknown>) => Promise<unknown>;
};

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (required) throw new Error(`Missing required argument: ${key}`);
  return '';
}

function strArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string')) {
    throw new Error(`Argument ${key} must be a non-empty array of strings`);
  }
  return v as string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'whoami',
    title: 'Who am I',
    description: 'Get the connected Tidal account: user ID, display name, and the scopes this connection was granted.',
    scope: null,
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (c, auth) => {
      const session = await getLatestSessionForUser(c.env.DB, auth.tidalUserId);
      return {
        tidalUserId: auth.tidalUserId,
        displayName: (session?.display_name as string) || null,
        grantedScopes: auth.scopes,
        appUrl: c.env.APP_URL,
      };
    },
  },
  {
    name: 'list_playlists',
    title: 'List my playlists',
    description: 'List the playlists in the user\'s Tidal collection (owned and saved). Returns playlist IDs, names, descriptions and track counts.',
    scope: 'playlists:read',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (c, auth) => {
      const ctx = await getTidalContext(c, auth);
      const playlists: Array<Record<string, unknown>> = [];
      let url = `/userCollectionPlaylists/me/relationships/items?include=items&countryCode=US`;

      for (let page = 0; page < 10 && url; page++) {
        const body = await tidalFetch(ctx, url);
        for (const res of (body.included as JsonApiResource[]) || []) {
          if (res.type !== 'playlists') continue;
          const a = res.attributes || {};
          playlists.push({
            id: res.id,
            name: a.name,
            description: a.description || undefined,
            numberOfItems: a.numberOfItems,
            accessType: a.accessType,
            lastModifiedAt: a.lastModifiedAt,
            url: `https://tidal.com/playlist/${res.id}`,
          });
        }
        const next = (body.links as { next?: string } | undefined)?.next;
        url = next ? next : '';
      }

      return { count: playlists.length, playlists };
    },
  },
  {
    name: 'get_playlist',
    title: 'Get playlist tracks',
    description: 'Get a playlist\'s details and its tracks (title, artists, album, duration). Use offset/limit to page through large playlists.',
    scope: 'playlists:read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        playlistId: { type: 'string', description: 'Tidal playlist ID (UUID)' },
        offset: { type: 'number', description: 'Skip this many items (default 0)' },
        limit: { type: 'number', description: 'Max tracks to return (default 100, max 250)' },
      },
      required: ['playlistId'],
      additionalProperties: false,
    },
    handler: async (c, auth, args) => {
      const ctx = await getTidalContext(c, auth);
      const playlistId = str(args, 'playlistId');
      const offset = Math.max(0, Number(args.offset) || 0);
      const limit = Math.min(250, Math.max(1, Number(args.limit) || 100));

      const meta = await tidalFetch(ctx, `/playlists/${encodeURIComponent(playlistId)}?countryCode=US`);
      const attrs = (meta.data as JsonApiResource | undefined)?.attributes || {};

      const items = await fetchAllPlaylistItems(ctx.apiBase, playlistId, ctx.token);
      const pageItems = items.slice(offset, offset + limit);
      const trackIds = pageItems.filter((i) => i.type === 'tracks').map((i) => i.id);
      const summaries = await fetchTrackSummaries(ctx, [...new Set(trackIds)]);

      return {
        playlist: {
          id: playlistId,
          name: attrs.name,
          description: attrs.description || undefined,
          numberOfItems: attrs.numberOfItems,
          accessType: attrs.accessType,
          url: `https://tidal.com/playlist/${playlistId}`,
        },
        totalItems: items.length,
        offset,
        returned: pageItems.length,
        tracks: pageItems.map((item, idx) => ({
          position: offset + idx,
          type: item.type,
          ...(item.type === 'tracks'
            ? summaries.get(item.id) || { id: item.id, title: '(unknown)' }
            : { id: item.id }),
        })),
      };
    },
  },
  {
    name: 'search_tracks',
    title: 'Search Tidal tracks',
    description: 'Search the Tidal catalog for tracks by free-text query (song name, artist, lyrics keywords). Returns track IDs usable with add_tracks_to_playlist.',
    scope: 'playlists:read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text, e.g. "bicep glue" or "daft punk around the world"' },
        limit: { type: 'number', description: 'Max results (default 10, max 20)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (c, auth, args) => {
      const ctx = await getTidalContext(c, auth);
      const query = str(args, 'query');
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 10));

      const body = await tidalFetch(
        ctx,
        `/searchResults/${encodeURIComponent(query)}/relationships/tracks?countryCode=US&include=tracks`,
      );
      const ids = (((body.data as JsonApiResource[]) || []).map((r) => r.id)).slice(0, limit);
      const summaries = await fetchTrackSummaries(ctx, ids);

      return {
        query,
        results: ids.map((id) => summaries.get(id) || { id, title: '(unknown)' }),
      };
    },
  },
  {
    name: 'create_playlist',
    title: 'Create a playlist',
    description: 'Create a new playlist in the user\'s Tidal account. Returns the new playlist ID.',
    scope: 'playlists:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Playlist name' },
        description: { type: 'string', description: 'Optional playlist description' },
        accessType: { type: 'string', enum: ['PUBLIC', 'UNLISTED'], description: 'Optional visibility (omit for Tidal default)' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (c, auth, args) => {
      const ctx = await getTidalContext(c, auth);
      const attributes: Record<string, unknown> = { name: str(args, 'name') };
      const description = str(args, 'description', false);
      if (description) attributes.description = description;
      if (args.accessType === 'PUBLIC' || args.accessType === 'UNLISTED') attributes.accessType = args.accessType;

      const body = await tidalFetch(ctx, '/playlists', {
        method: 'POST',
        body: { data: { type: 'playlists', attributes } },
      });
      const created = body.data as JsonApiResource;
      return {
        created: true,
        playlistId: created.id,
        name: created.attributes?.name,
        url: `https://tidal.com/playlist/${created.id}`,
      };
    },
  },
  {
    name: 'add_tracks_to_playlist',
    title: 'Add tracks to a playlist',
    description: 'Append tracks to a Tidal playlist by track ID (get IDs from search_tracks or get_playlist). Skips tracks already in the playlist.',
    scope: 'playlists:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        playlistId: { type: 'string', description: 'Tidal playlist ID' },
        trackIds: { type: 'array', items: { type: 'string' }, description: 'Track IDs to add, in order' },
      },
      required: ['playlistId', 'trackIds'],
      additionalProperties: false,
    },
    handler: async (c, auth, args) => {
      const ctx = await getTidalContext(c, auth);
      const playlistId = str(args, 'playlistId');
      const trackIds = strArray(args, 'trackIds');

      // Skip tracks that are already present (Tidal happily adds duplicates)
      const existing = await fetchAllPlaylistItems(ctx.apiBase, playlistId, ctx.token);
      const existingIds = new Set(existing.filter((i) => i.type === 'tracks').map((i) => i.id));
      const toAdd = [...new Set(trackIds)].filter((id) => !existingIds.has(id));

      const CHUNK = 50;
      for (let i = 0; i < toAdd.length; i += CHUNK) {
        await tidalFetch(ctx, `/playlists/${encodeURIComponent(playlistId)}/relationships/items`, {
          method: 'POST',
          body: { data: toAdd.slice(i, i + CHUNK).map((id) => ({ id, type: 'tracks' })) },
        });
      }

      return {
        added: toAdd.length,
        skippedAlreadyPresent: trackIds.length - toAdd.length,
        playlistUrl: `https://tidal.com/playlist/${playlistId}`,
      };
    },
  },
  {
    name: 'remove_tracks_from_playlist',
    title: 'Remove tracks from a playlist',
    description: 'Remove tracks from a Tidal playlist by track ID. Removes every occurrence of each given track.',
    scope: 'playlists:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        playlistId: { type: 'string', description: 'Tidal playlist ID' },
        trackIds: { type: 'array', items: { type: 'string' }, description: 'Track IDs to remove' },
      },
      required: ['playlistId', 'trackIds'],
      additionalProperties: false,
    },
    handler: async (c, auth, args) => {
      const ctx = await getTidalContext(c, auth);
      const playlistId = str(args, 'playlistId');
      const targetIds = new Set(strArray(args, 'trackIds'));

      // The DELETE endpoint needs the playlist-item ID (meta.itemId), not just the track ID
      const items = await fetchAllPlaylistItems(ctx.apiBase, playlistId, ctx.token);
      const toRemove = items.filter((i) => targetIds.has(i.id));
      const missingMeta = toRemove.filter((i) => !i.meta?.itemId);
      if (missingMeta.length > 0) {
        throw new Error('Tidal did not return itemId metadata for playlist items; cannot remove safely. Try again.');
      }

      const CHUNK = 50;
      for (let i = 0; i < toRemove.length; i += CHUNK) {
        await tidalFetch(ctx, `/playlists/${encodeURIComponent(playlistId)}/relationships/items`, {
          method: 'DELETE',
          body: {
            data: toRemove.slice(i, i + CHUNK).map((item) => ({
              id: item.id,
              type: item.type,
              meta: { itemId: item.meta!.itemId },
            })),
          },
        });
      }

      const foundIds = new Set(toRemove.map((i) => i.id));
      return {
        removedItems: toRemove.length,
        notFoundInPlaylist: [...targetIds].filter((id) => !foundIds.has(id)),
        playlistUrl: `https://tidal.com/playlist/${playlistId}`,
      };
    },
  },
  {
    name: 'list_shared_playlists',
    title: 'List collaborative playlists',
    description: 'List the collaborative (shared) playlists the user owns or has joined in this app, with share IDs and member info.',
    scope: 'shares:read',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (c, auth) => {
      const db = c.env.DB;
      const session = await getLatestSessionForUser(db, auth.tidalUserId);
      const sessionId = (session?.id as string) || '';

      const shares = await db.prepare(
        'SELECT id, tidal_playlist_id, name, created_at FROM shared_playlists WHERE owner_tidal_user_id = ? OR owner_session_id = ? ORDER BY created_at DESC',
      ).bind(auth.tidalUserId, sessionId).all();

      const memberships = await db.prepare(
        `SELECT pm.shared_playlist_id, pm.their_playlist_id, pm.joined_at, sp.name, sp.tidal_playlist_id
         FROM playlist_members pm JOIN shared_playlists sp ON pm.shared_playlist_id = sp.id
         WHERE pm.tidal_user_id = ? OR pm.session_id = ? ORDER BY pm.joined_at DESC`,
      ).bind(auth.tidalUserId, sessionId).all();

      const appUrl = c.env.APP_URL.replace(/\/$/, '');
      return {
        owned: shares.results.map((s) => ({
          shareId: s.id,
          name: s.name,
          sourcePlaylistId: s.tidal_playlist_id,
          shareUrl: `${appUrl}/#/shared/${s.id}`,
        })),
        joined: memberships.results.map((m) => ({
          shareId: m.shared_playlist_id,
          name: m.name,
          myPlaylistCopyId: m.their_playlist_id,
          shareUrl: `${appUrl}/#/shared/${m.shared_playlist_id}`,
        })),
      };
    },
  },
  {
    name: 'get_shared_playlist',
    title: 'Get collaborative playlist details',
    description: 'Get a collaborative playlist\'s members, emoji reactions per track, and comment counts. Use the shareId from list_shared_playlists.',
    scope: 'shares:read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { shareId: { type: 'string', description: 'Share ID' } },
      required: ['shareId'],
      additionalProperties: false,
    },
    handler: async (c, auth, args) => {
      const db = c.env.DB;
      const shareId = str(args, 'shareId');
      const shared = await db.prepare('SELECT id, tidal_playlist_id, name, created_at FROM shared_playlists WHERE id = ?')
        .bind(shareId).first();
      if (!shared) throw new Error(`Shared playlist ${shareId} not found`);

      const members = await db.prepare(
        `SELECT pm.their_playlist_id, pm.joined_at, s.display_name, s.tidal_user_id
         FROM playlist_members pm JOIN sessions s ON pm.session_id = s.id
         WHERE pm.shared_playlist_id = ?`,
      ).bind(shareId).all();

      const reactions = await db.prepare(
        'SELECT track_id, emoji, COUNT(*) as count FROM reactions WHERE shared_playlist_id = ? GROUP BY track_id, emoji',
      ).bind(shareId).all();

      const commentCounts = await db.prepare(
        'SELECT track_id, COUNT(*) as count FROM comments WHERE shared_playlist_id = ? GROUP BY track_id',
      ).bind(shareId).all();

      return {
        share: {
          shareId: shared.id,
          name: shared.name,
          sourcePlaylistId: shared.tidal_playlist_id,
          shareUrl: `${c.env.APP_URL.replace(/\/$/, '')}/#/shared/${shared.id}`,
        },
        members: members.results.map((m) => ({
          displayName: m.display_name,
          tidalUserId: m.tidal_user_id,
          playlistCopyId: m.their_playlist_id,
        })),
        reactions: reactions.results,
        commentCounts: commentCounts.results,
      };
    },
  },
  {
    name: 'create_share_link',
    title: 'Share a playlist',
    description: 'Create a collaborative share link for one of the user\'s Tidal playlists so friends can join and sync it.',
    scope: 'shares:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        playlistId: { type: 'string', description: 'Tidal playlist ID to share' },
        name: { type: 'string', description: 'Display name for the share (defaults to the playlist name)' },
      },
      required: ['playlistId'],
      additionalProperties: false,
    },
    handler: async (c, auth, args) => {
      const ctx = await getTidalContext(c, auth);
      const playlistId = str(args, 'playlistId');
      const appUrl = c.env.APP_URL.replace(/\/$/, '');

      const existing = await c.env.DB.prepare('SELECT id FROM shared_playlists WHERE tidal_playlist_id = ?')
        .bind(playlistId).first<{ id: string }>();
      if (existing) {
        return { shareId: existing.id, shareUrl: `${appUrl}/#/shared/${existing.id}`, alreadyShared: true };
      }

      let name = str(args, 'name', false);
      if (!name) {
        const meta = await tidalFetch(ctx, `/playlists/${encodeURIComponent(playlistId)}?countryCode=US`);
        name = ((meta.data as JsonApiResource | undefined)?.attributes?.name as string) || 'Shared Playlist';
      }

      const shareId = generateId().slice(0, 12);
      await c.env.DB.prepare(
        'INSERT INTO shared_playlists (id, tidal_playlist_id, owner_session_id, owner_tidal_user_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(shareId, playlistId, ctx.session.id, auth.tidalUserId, name, now())
        .run();

      return { shareId, name, shareUrl: `${appUrl}/#/shared/${shareId}`, alreadyShared: false };
    },
  },
  {
    name: 'sync_shared_playlist',
    title: 'Sync a collaborative playlist',
    description: 'Trigger a bidirectional sync of a collaborative playlist: merges tracks across the owner\'s and all members\' copies. Only owners/members can sync.',
    scope: 'shares:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: { shareId: { type: 'string', description: 'Share ID' } },
      required: ['shareId'],
      additionalProperties: false,
    },
    handler: async (c, auth, args) => {
      const db = c.env.DB;
      const shareId = str(args, 'shareId');
      const shared = await db.prepare('SELECT * FROM shared_playlists WHERE id = ?').bind(shareId).first();
      if (!shared) throw new Error(`Shared playlist ${shareId} not found`);

      // Only participants may trigger a sync
      const isOwner = shared.owner_tidal_user_id === auth.tidalUserId;
      const isMember = await db.prepare(
        'SELECT 1 FROM playlist_members WHERE shared_playlist_id = ? AND tidal_user_id = ?',
      ).bind(shareId, auth.tidalUserId).first();
      if (!isOwner && !isMember) {
        throw new Error('You are not the owner or a member of this shared playlist.');
      }

      const ownerSession = await findOwnerSession(db, shared as Record<string, unknown>);
      if (!ownerSession) throw new Error('Owner session expired — the owner needs to log in to the web app again.');

      const memberEntries = await findMemberEntries(db, shareId);
      if (memberEntries.length === 0) {
        return { synced: false, message: 'No members have joined yet — nothing to sync.' };
      }

      if (!await acquireSyncLock(db, shareId)) {
        return { synced: false, message: 'A sync is already in progress for this playlist.' };
      }
      try {
        const result = await syncSharedPlaylist(
          db,
          c.env.TIDAL_API_BASE,
          c.env.TIDAL_CLIENT_ID,
          c.env.TIDAL_CLIENT_SECRET,
          shared as Record<string, unknown>,
          ownerSession as Record<string, unknown>,
          memberEntries,
        );
        return { synced: result.success, mergedTrackCount: result.itemCount, errors: result.errors };
      } finally {
        await releaseSyncLock(db, shareId);
      }
    },
  },
  {
    name: 'react_to_track',
    title: 'React to a track',
    description: 'Toggle an emoji reaction on a track in a collaborative playlist (adds it, or removes it if you already reacted with that emoji).',
    scope: 'shares:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        shareId: { type: 'string', description: 'Share ID' },
        trackId: { type: 'string', description: 'Tidal track ID' },
        emoji: { type: 'string', description: 'Emoji, e.g. 🔥 ❤️ 👍' },
      },
      required: ['shareId', 'trackId', 'emoji'],
      additionalProperties: false,
    },
    handler: async (c, auth, args) => {
      const db = c.env.DB;
      const shareId = str(args, 'shareId');
      const trackId = str(args, 'trackId');
      const emoji = str(args, 'emoji').slice(0, 16);

      const shared = await db.prepare('SELECT id FROM shared_playlists WHERE id = ?').bind(shareId).first();
      if (!shared) throw new Error(`Shared playlist ${shareId} not found`);

      const session = await getLatestSessionForUser(db, auth.tidalUserId);
      if (!session) throw new Error('No active session — log in to the web app again.');

      const existing = await db.prepare(
        'SELECT id FROM reactions WHERE shared_playlist_id = ? AND track_id = ? AND session_id = ? AND emoji = ?',
      ).bind(shareId, trackId, session.id, emoji).first();

      if (existing) {
        await db.prepare('DELETE FROM reactions WHERE id = ?').bind(existing.id).run();
        return { action: 'removed', emoji, trackId };
      }
      await db.prepare(
        'INSERT INTO reactions (shared_playlist_id, track_id, session_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(shareId, trackId, session.id, emoji, now()).run();
      return { action: 'added', emoji, trackId };
    },
  },
  {
    name: 'comment_on_track',
    title: 'Comment on a track',
    description: 'Post a comment on a track in a collaborative playlist. The comment appears in the web app for all members.',
    scope: 'shares:write',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        shareId: { type: 'string', description: 'Share ID' },
        trackId: { type: 'string', description: 'Tidal track ID' },
        body: { type: 'string', description: 'Comment text' },
      },
      required: ['shareId', 'trackId', 'body'],
      additionalProperties: false,
    },
    handler: async (c, auth, args) => {
      const db = c.env.DB;
      const shareId = str(args, 'shareId');
      const trackId = str(args, 'trackId');
      const body = str(args, 'body').slice(0, 2000);

      const shared = await db.prepare('SELECT id FROM shared_playlists WHERE id = ?').bind(shareId).first();
      if (!shared) throw new Error(`Shared playlist ${shareId} not found`);

      const session = await getLatestSessionForUser(db, auth.tidalUserId);
      if (!session) throw new Error('No active session — log in to the web app again.');

      const displayName = (session.display_name as string) || null;
      const result = await db.prepare(
        'INSERT INTO comments (shared_playlist_id, track_id, session_id, display_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, created_at',
      ).bind(shareId, trackId, session.id, displayName, body, now()).first();

      return { posted: true, commentId: result?.id, displayName };
    },
  },
  {
    name: 'get_track_comments',
    title: 'Get track comments',
    description: 'Read the comment thread for a track in a collaborative playlist.',
    scope: 'shares:read',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        shareId: { type: 'string', description: 'Share ID' },
        trackId: { type: 'string', description: 'Tidal track ID' },
      },
      required: ['shareId', 'trackId'],
      additionalProperties: false,
    },
    handler: async (c, auth, args) => {
      const db = c.env.DB;
      const shareId = str(args, 'shareId');
      const trackId = str(args, 'trackId');

      const rows = await db.prepare(
        'SELECT id, body, display_name, created_at FROM comments WHERE shared_playlist_id = ? AND track_id = ? ORDER BY created_at ASC',
      ).bind(shareId, trackId).all();

      return {
        trackId,
        comments: rows.results.map((r) => ({
          id: r.id,
          author: r.display_name || 'Anonymous',
          body: r.body,
          createdAt: new Date((r.created_at as number) * 1000).toISOString(),
        })),
      };
    },
  },
];

// ── MCP JSON-RPC handling ────────────────────────────────────────────

function jsonRpcResult(c: Ctx, id: unknown, result: unknown) {
  return c.json({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(c: Ctx, id: unknown, code: number, message: string) {
  return c.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

async function handleMcpRequest(c: Ctx, auth: McpAuth, msg: Record<string, unknown>) {
  const { method, id } = msg as { method: string; id: unknown };
  const params = (msg.params as Record<string, unknown>) || {};

  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion as string | undefined;
      const protocolVersion =
        requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
      return jsonRpcResult(c, id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Tools for managing the connected user\'s Tidal playlists and this app\'s collaborative playlists. ' +
          'Track IDs come from search_tracks or get_playlist; share IDs come from list_shared_playlists. ' +
          'Playlist edits are made directly in the user\'s real Tidal account.',
      });
    }

    case 'ping':
      return jsonRpcResult(c, id, {});

    case 'tools/list':
      return jsonRpcResult(c, id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: !t.readOnly },
        })),
      });

    case 'tools/call': {
      const name = params.name as string;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return jsonRpcError(c, id, -32602, `Unknown tool: ${name}`);

      if (tool.scope && !auth.scopes.includes(tool.scope)) {
        return jsonRpcResult(c, id, {
          content: [{ type: 'text', text: `This connection was not granted the "${tool.scope}" scope. Reconnect and approve it to use ${name}.` }],
          isError: true,
        });
      }

      try {
        const result = await tool.handler(c, auth, (params.arguments as Record<string, unknown>) || {});
        console.log(`[mcp] tool ${name} OK for user ${auth.tidalUserId}`);
        return jsonRpcResult(c, id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[mcp] tool ${name} failed for user ${auth.tidalUserId}: ${message}`);
        return jsonRpcResult(c, id, {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        });
      }
    }

    default:
      return jsonRpcError(c, id, -32601, `Method not found: ${method}`);
  }
}

// ── Consent page ─────────────────────────────────────────────────────

function consentPage(opts: {
  requestId: string;
  clientName: string;
  redirectHost: string;
  scopes: string[];
  displayName: string;
}): string {
  const scopeDescriptions: Record<string, string> = {
    'playlists:read': 'Read your Tidal playlists and search the catalog',
    'playlists:write': 'Create playlists and add/remove tracks in your Tidal account',
    'shares:read': 'See your collaborative playlists, reactions and comments',
    'shares:write': 'Share playlists, trigger syncs, react and comment',
  };
  const scopeList = opts.scopes
    .map((s) => `<li><strong>${escHtml(s)}</strong> — ${escHtml(scopeDescriptions[s] || s)}</li>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${escHtml(opts.clientName)}</title>
<style>
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: #0e0e10; color: #eaeaea;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #1a1a1e; border: 1px solid #2a2a30; border-radius: 12px; padding: 32px; max-width: 440px; margin: 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #9a9aa2; font-size: 14px; margin-bottom: 20px; }
  ul { padding-left: 20px; color: #c8c8d0; font-size: 14px; line-height: 1.7; }
  .warn { font-size: 13px; color: #9a9aa2; margin: 16px 0 24px; }
  .row { display: flex; gap: 12px; }
  button { flex: 1; padding: 12px; border-radius: 8px; border: none; font-size: 15px; font-weight: 600; cursor: pointer; }
  .approve { background: #33ffee; color: #000; }
  .deny { background: #2a2a30; color: #eaeaea; }
</style>
</head>
<body>
<div class="card">
  <h1>Connect &ldquo;${escHtml(opts.clientName)}&rdquo;?</h1>
  <div class="sub">Signed in as <strong>${escHtml(opts.displayName)}</strong> · redirects to <strong>${escHtml(opts.redirectHost)}</strong></div>
  <p style="font-size:14px">This AI client is asking to access your Tidal account through Tidal Collaborative Playlists. It will be able to:</p>
  <ul>${scopeList}</ul>
  <div class="warn">Changes made by this client affect your real Tidal playlists. You can revoke access anytime by logging out of the web app.</div>
  <div class="row">
    <form method="POST" action="/mcp/authorize/decision" style="flex:1;display:flex">
      <input type="hidden" name="request_id" value="${escHtml(opts.requestId)}">
      <input type="hidden" name="action" value="deny">
      <button class="deny" type="submit">Deny</button>
    </form>
    <form method="POST" action="/mcp/authorize/decision" style="flex:1;display:flex">
      <input type="hidden" name="request_id" value="${escHtml(opts.requestId)}">
      <input type="hidden" name="action" value="approve">
      <button class="approve" type="submit">Approve</button>
    </form>
  </div>
</div>
</body>
</html>`;
}

// ── Route registration ───────────────────────────────────────────────

export function registerMcp(app: Hono<Env>) {
  // Permissive CORS for browser-based MCP clients (e.g. MCP Inspector).
  // claude.ai connects server-side, so this is a convenience, not a requirement.
  app.use('/.well-known/*', corsMiddleware);
  app.use('/mcp', corsMiddleware);
  app.use('/mcp/*', corsMiddleware);

  // ── Discovery metadata ─────────────────────────────────────────────

  const prm = (c: Ctx) => c.json(protectedResourceMetadata(c.env.APP_URL));
  app.get('/.well-known/oauth-protected-resource', prm);
  app.get('/.well-known/oauth-protected-resource/mcp', prm);

  const asm = (c: Ctx) => c.json(authorizationServerMetadata(c.env.APP_URL));
  app.get('/.well-known/oauth-authorization-server', asm);
  app.get('/.well-known/oauth-authorization-server/mcp', asm);
  // Some clients fall back to OIDC discovery
  app.get('/.well-known/openid-configuration', asm);

  // ── Dynamic Client Registration (RFC 7591) ─────────────────────────

  app.post('/mcp/register', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_client_metadata', error_description: 'Body must be JSON' }, 400);
    }

    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
      return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be an array of 1-10 URIs' }, 400);
    }
    for (const uri of redirectUris) {
      if (typeof uri !== 'string' || !isAllowedRedirectUri(uri)) {
        return c.json({ error: 'invalid_redirect_uri', error_description: `Redirect URI not allowed: ${uri}` }, 400);
      }
    }

    const authMethod = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(authMethod)) {
      return c.json({ error: 'invalid_client_metadata', error_description: `Unsupported token_endpoint_auth_method: ${authMethod}` }, 400);
    }

    const clientId = `tcp_client_${generateId().slice(0, 32)}`;
    const clientSecret = authMethod === 'none' ? null : generateId();
    const clientName = (typeof body.client_name === 'string' ? body.client_name : 'MCP Client').slice(0, 100);
    const createdAt = now();

    await c.env.DB.prepare(
      'INSERT INTO mcp_clients (client_id, client_secret, client_name, redirect_uris, token_endpoint_auth_method, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(clientId, clientSecret, clientName, JSON.stringify(redirectUris), authMethod, createdAt)
      .run();

    console.log(`[mcp-oauth] Registered client ${clientId} (${clientName}) redirects=${JSON.stringify(redirectUris)}`);

    return c.json(
      {
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: createdAt,
        client_name: clientName,
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: authMethod,
        scope: ALL_SCOPES.join(' '),
      },
      201,
    );
  });

  // ── Authorization endpoint ─────────────────────────────────────────

  app.get('/mcp/authorize', async (c) => {
    const q = (name: string) => c.req.query(name) || '';
    const clientId = q('client_id');
    const redirectUri = q('redirect_uri');
    const state = q('state');

    const client = await c.env.DB.prepare('SELECT * FROM mcp_clients WHERE client_id = ?').bind(clientId).first();
    if (!client) {
      return c.html('<h2>Authorization error</h2><p>Unknown client_id. The MCP client may need to re-register.</p>', 400);
    }
    const registeredUris = JSON.parse(client.redirect_uris as string) as string[];
    if (!redirectUri || !registeredUris.includes(redirectUri)) {
      // Never redirect to an unregistered URI
      return c.html('<h2>Authorization error</h2><p>redirect_uri does not match the registered value.</p>', 400);
    }

    const errRedirect = (error: string, description: string) => {
      const url = new URL(redirectUri);
      url.searchParams.set('error', error);
      url.searchParams.set('error_description', description);
      if (state) url.searchParams.set('state', state);
      return c.redirect(url.toString());
    };

    if (q('response_type') !== 'code') return errRedirect('unsupported_response_type', 'Only response_type=code is supported');
    const codeChallenge = q('code_challenge');
    if (!codeChallenge) return errRedirect('invalid_request', 'PKCE is required: missing code_challenge');
    const challengeMethod = q('code_challenge_method') || 'S256';
    if (challengeMethod !== 'S256') return errRedirect('invalid_request', 'Only code_challenge_method=S256 is supported');

    const resource = q('resource');
    if (resource && normalizeResource(resource) !== normalizeResource(mcpResourceUrl(c.env.APP_URL))) {
      return errRedirect('invalid_target', `Unknown resource. This server's resource is ${mcpResourceUrl(c.env.APP_URL)}`);
    }

    const requestedScopes = q('scope').split(' ').map((s) => s.trim()).filter(Boolean);
    const unknownScopes = requestedScopes.filter((s) => !ALL_SCOPES.includes(s));
    if (unknownScopes.length > 0) return errRedirect('invalid_scope', `Unknown scope(s): ${unknownScopes.join(', ')}`);
    const grantedScopes = requestedScopes.length > 0 ? requestedScopes : ALL_SCOPES;

    // The user must be logged in with Tidal; bounce through the app's own login
    const sessionId = getCookie(c, 'session');
    const session = await getSession(c.env.DB, sessionId);
    if (!session || !session.tidal_user_id) {
      const here = new URL(c.req.url);
      const returnTo = here.pathname + here.search;
      return c.redirect(`/auth/login?redirect=${encodeURIComponent(returnTo)}`);
    }

    // Store the pending request server-side; the consent form only carries an
    // opaque request_id, so a cross-site POST can't forge an approval.
    const requestId = generateId();
    await c.env.DB.prepare(
      'INSERT INTO mcp_auth_requests (id, session_id, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, resource, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(requestId, sessionId, clientId, redirectUri, grantedScopes.join(' '), state || null, codeChallenge, challengeMethod, resource || null, now())
      .run();

    // Opportunistic cleanup of stale consent requests
    c.executionCtx.waitUntil(
      c.env.DB.prepare('DELETE FROM mcp_auth_requests WHERE created_at < ?').bind(now() - CONSENT_REQUEST_TTL).run(),
    );

    return c.html(
      consentPage({
        requestId,
        clientName: client.client_name as string,
        redirectHost: new URL(redirectUri).host || redirectUri,
        scopes: grantedScopes,
        displayName: (session.display_name as string) || `Tidal user ${session.tidal_user_id}`,
      }),
    );
  });

  app.post('/mcp/authorize/decision', async (c) => {
    const form = await c.req.parseBody();
    const requestId = typeof form.request_id === 'string' ? form.request_id : '';
    const action = typeof form.action === 'string' ? form.action : '';

    const request = await c.env.DB.prepare('SELECT * FROM mcp_auth_requests WHERE id = ?').bind(requestId).first();
    if (request) {
      await c.env.DB.prepare('DELETE FROM mcp_auth_requests WHERE id = ?').bind(requestId).run();
    }
    if (!request || (request.created_at as number) < now() - CONSENT_REQUEST_TTL) {
      return c.html('<h2>Authorization error</h2><p>This request has expired. Go back to your MCP client and try connecting again.</p>', 400);
    }

    // The approving browser session must be the one that saw the consent page
    const sessionId = getCookie(c, 'session');
    const session = await getSession(c.env.DB, sessionId);
    if (!sessionId || sessionId !== request.session_id || !session?.tidal_user_id) {
      return c.html('<h2>Authorization error</h2><p>Session mismatch. Log in and try connecting again.</p>', 403);
    }

    const redirectUrl = new URL(request.redirect_uri as string);
    if (request.state) redirectUrl.searchParams.set('state', request.state as string);

    if (action !== 'approve') {
      redirectUrl.searchParams.set('error', 'access_denied');
      redirectUrl.searchParams.set('error_description', 'The user denied the request');
      console.log(`[mcp-oauth] User ${session.tidal_user_id} denied client ${request.client_id}`);
      return c.redirect(redirectUrl.toString());
    }

    const code = `tcp_ac_${generateId()}`;
    await c.env.DB.prepare(
      'INSERT INTO mcp_auth_codes (code, client_id, tidal_user_id, redirect_uri, scope, code_challenge, code_challenge_method, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        code,
        request.client_id,
        session.tidal_user_id,
        request.redirect_uri,
        request.scope,
        request.code_challenge,
        request.code_challenge_method,
        request.resource,
        now(),
        now() + AUTH_CODE_TTL,
      )
      .run();

    console.log(`[mcp-oauth] User ${session.tidal_user_id} approved client ${request.client_id} scopes="${request.scope}"`);
    redirectUrl.searchParams.set('code', code);
    return c.redirect(redirectUrl.toString());
  });

  // ── Token endpoint ─────────────────────────────────────────────────

  app.post('/mcp/token', async (c) => {
    const tokenError = (status: 400 | 401, error: string, description: string) =>
      c.newResponse(JSON.stringify({ error, error_description: description }), status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 401 ? { 'WWW-Authenticate': 'Basic realm="mcp"' } : {}),
      });

    let params: Record<string, string> = {};
    const contentType = c.req.header('Content-Type') || '';
    try {
      if (contentType.includes('application/json')) {
        const body = (await c.req.json()) as Record<string, unknown>;
        for (const [k, v] of Object.entries(body)) if (typeof v === 'string') params[k] = v;
      } else {
        const body = await c.req.parseBody();
        for (const [k, v] of Object.entries(body)) if (typeof v === 'string') params[k] = v;
      }
    } catch {
      return tokenError(400, 'invalid_request', 'Could not parse request body');
    }

    // Client authentication: HTTP Basic or body params
    let clientId = params.client_id || '';
    let clientSecret = params.client_secret || '';
    const basic = (c.req.header('Authorization') || '').match(/^Basic\s+(.+)$/i);
    if (basic) {
      try {
        const [id, ...rest] = atob(basic[1]).split(':');
        clientId = decodeURIComponent(id);
        clientSecret = decodeURIComponent(rest.join(':'));
      } catch {
        return tokenError(401, 'invalid_client', 'Malformed Basic authorization header');
      }
    }
    if (!clientId) return tokenError(400, 'invalid_request', 'Missing client_id');

    const client = await c.env.DB.prepare('SELECT * FROM mcp_clients WHERE client_id = ?').bind(clientId).first();
    if (!client) return tokenError(401, 'invalid_client', 'Unknown client');
    if (client.client_secret && client.client_secret !== clientSecret) {
      return tokenError(401, 'invalid_client', 'Invalid client credentials');
    }

    const resource = params.resource || '';
    if (resource && normalizeResource(resource) !== normalizeResource(mcpResourceUrl(c.env.APP_URL))) {
      return tokenError(400, 'invalid_target', 'Unknown resource');
    }

    const issueTokens = async (tidalUserId: string, scope: string, existingRowId?: string) => {
      const accessToken = `tcp_at_${generateId()}`;
      const refreshToken = `tcp_rt_${generateId()}`;
      const accessHash = await sha256Hex(accessToken);
      const refreshHash = await sha256Hex(refreshToken);
      const ts = now();

      if (existingRowId) {
        await c.env.DB.prepare(
          'UPDATE mcp_tokens SET access_token_hash = ?, refresh_token_hash = ?, access_expires_at = ?, refresh_expires_at = ?, last_used_at = ? WHERE id = ?',
        )
          .bind(accessHash, refreshHash, ts + ACCESS_TOKEN_TTL, ts + REFRESH_TOKEN_TTL, ts, existingRowId)
          .run();
      } else {
        await c.env.DB.prepare(
          'INSERT INTO mcp_tokens (id, access_token_hash, refresh_token_hash, client_id, tidal_user_id, scope, access_expires_at, refresh_expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
          .bind(generateId(), accessHash, refreshHash, clientId, tidalUserId, scope, ts + ACCESS_TOKEN_TTL, ts + REFRESH_TOKEN_TTL, ts, ts)
          .run();
      }

      return c.newResponse(
        JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: ACCESS_TOKEN_TTL,
          refresh_token: refreshToken,
          scope,
        }),
        200,
        { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      );
    };

    if (params.grant_type === 'authorization_code') {
      const code = params.code || '';
      if (!code) return tokenError(400, 'invalid_request', 'Missing code');

      const row = await c.env.DB.prepare('SELECT * FROM mcp_auth_codes WHERE code = ?').bind(code).first();
      // Single use: delete immediately, even if subsequent checks fail
      if (row) await c.env.DB.prepare('DELETE FROM mcp_auth_codes WHERE code = ?').bind(code).run();

      if (!row || (row.expires_at as number) < now()) return tokenError(400, 'invalid_grant', 'Authorization code invalid or expired');
      if (row.client_id !== clientId) return tokenError(400, 'invalid_grant', 'Code was issued to a different client');
      if (params.redirect_uri && params.redirect_uri !== row.redirect_uri) {
        return tokenError(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
      }

      const verifier = params.code_verifier || '';
      if (!verifier) return tokenError(400, 'invalid_request', 'Missing code_verifier (PKCE required)');
      if ((await sha256Base64Url(verifier)) !== row.code_challenge) {
        return tokenError(400, 'invalid_grant', 'PKCE verification failed');
      }

      console.log(`[mcp-oauth] Issued tokens for user ${row.tidal_user_id} to client ${clientId}`);
      return issueTokens(row.tidal_user_id as string, row.scope as string);
    }

    if (params.grant_type === 'refresh_token') {
      const provided = params.refresh_token || '';
      if (!provided) return tokenError(400, 'invalid_request', 'Missing refresh_token');

      const hash = await sha256Hex(provided);
      const row = await c.env.DB.prepare('SELECT * FROM mcp_tokens WHERE refresh_token_hash = ?').bind(hash).first();
      if (!row || (row.refresh_expires_at as number) < now()) {
        return tokenError(400, 'invalid_grant', 'Refresh token invalid or expired');
      }
      if (row.client_id !== clientId) return tokenError(400, 'invalid_grant', 'Refresh token was issued to a different client');

      console.log(`[mcp-oauth] Rotated tokens for user ${row.tidal_user_id} client ${clientId}`);
      return issueTokens(row.tidal_user_id as string, row.scope as string, row.id as string);
    }

    return tokenError(400, 'unsupported_grant_type', `Unsupported grant_type: ${params.grant_type || '(none)'}`);
  });

  // ── MCP endpoint (Streamable HTTP, stateless JSON mode) ────────────

  app.post('/mcp', async (c) => {
    const auth = await authenticateBearer(c);
    if (!auth) return unauthorized(c, 'Missing or invalid access token');

    let msg: unknown;
    try {
      msg = await c.req.json();
    } catch {
      return jsonRpcError(c, null, -32700, 'Parse error: body must be JSON');
    }

    if (Array.isArray(msg)) {
      return jsonRpcError(c, null, -32600, 'JSON-RPC batching is not supported');
    }
    const m = msg as Record<string, unknown>;
    if (!m || typeof m !== 'object') {
      return jsonRpcError(c, null, -32600, 'Invalid request');
    }

    // Notifications and client->server responses get 202 with no body
    if (typeof m.method !== 'string' || m.id === undefined || m.id === null) {
      return c.body(null, 202);
    }

    return handleMcpRequest(c, auth, m);
  });

  // Streamable HTTP: we don't offer a server-initiated SSE stream or sessions
  app.get('/mcp', (c) => c.newResponse('This MCP server only supports POST (stateless Streamable HTTP).', 405, { Allow: 'POST' }));
  app.delete('/mcp', (c) => c.newResponse(null, 405, { Allow: 'POST' }));
}

// Hono middleware typed loosely to keep registration simple
async function corsMiddleware(c: Ctx, next: () => Promise<void>) {
  if (c.req.method === 'OPTIONS') {
    return c.newResponse(null, 204, corsHeaders());
  }
  await next();
  for (const [k, v] of Object.entries(corsHeaders())) {
    c.res.headers.set(k, v);
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
    'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
    'Access-Control-Max-Age': '86400',
  };
}

/** Cron cleanup of expired MCP OAuth artifacts */
export async function cleanupMcpTokens(db: D1Database): Promise<void> {
  const ts = now();
  await db.batch([
    db.prepare('DELETE FROM mcp_auth_codes WHERE expires_at < ?').bind(ts),
    db.prepare('DELETE FROM mcp_auth_requests WHERE created_at < ?').bind(ts - CONSENT_REQUEST_TTL),
    db.prepare('DELETE FROM mcp_tokens WHERE refresh_expires_at < ?').bind(ts),
  ]);
}
