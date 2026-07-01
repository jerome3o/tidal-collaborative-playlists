// Shared helpers: crypto utilities, session lookup, Tidal token refresh,
// playlist item fetching, and the bidirectional sync engine.
// Used by both the web app routes (worker.ts) and the MCP server (mcp.ts).

export type Env = {
  Bindings: {
    DB: D1Database;
    TIDAL_CLIENT_ID: string;
    TIDAL_CLIENT_SECRET: string;
    TIDAL_AUTH_BASE: string;
    TIDAL_API_BASE: string;
    APP_URL: string;
  };
};

export function generateId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Base64Url(plain: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(plain: string): Promise<string> {
  const data = new TextEncoder().encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function base64UrlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function getSession(db: D1Database, sessionId: string | undefined) {
  if (!sessionId) return null;
  // Exclude logged-out sessions (access_token cleared on logout)
  return db.prepare('SELECT * FROM sessions WHERE id = ? AND access_token != \'\'').bind(sessionId).first();
}

/** Find the most recent usable session for a Tidal user (survives re-logins) */
export async function getLatestSessionForUser(db: D1Database, tidalUserId: string) {
  return db
    .prepare(
      'SELECT * FROM sessions WHERE tidal_user_id = ? AND access_token != \'\' ORDER BY updated_at DESC LIMIT 1',
    )
    .bind(tidalUserId)
    .first();
}

export type PlaylistItem = { id: string; type: string; meta?: { itemId?: string; addedAt?: string } };

/** Fetch all items from a playlist, handling cursor pagination */
export async function fetchAllPlaylistItems(
  apiBase: string,
  playlistId: string,
  token: string,
): Promise<PlaylistItem[]> {
  const allItems: PlaylistItem[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ include: 'items' });
    if (cursor) params.set('page[cursor]', cursor);

    const url = `${apiBase}/playlists/${playlistId}/relationships/items?${params}`;
    console.log(`[fetchItems] GET ${url} (page ${page})`);

    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.api+json',
      },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      if (resp.status === 404) {
        console.warn(`[fetchItems] Playlist ${playlistId} not found (404) — may have been deleted from Tidal`);
        return allItems; // Return whatever we have (likely empty)
      }
      console.error(`[fetchItems] Failed for playlist ${playlistId}: ${resp.status} ${errText}`);
      break;
    }

    const body = (await resp.json()) as {
      data: PlaylistItem[];
      links?: { next?: string };
    };

    const pageItems = body.data || [];
    if (page === 0 && pageItems.length > 0) {
      console.log(`[fetchItems] Playlist ${playlistId} sample item: type=${pageItems[0].type} id=${pageItems[0].id}`);
    }
    console.log(`[fetchItems] Playlist ${playlistId} page ${page}: got ${pageItems.length} items`);
    allItems.push(...pageItems);

    // Check for next page cursor
    if (body.links?.next) {
      const nextUrl = new URL(body.links.next, apiBase);
      cursor = nextUrl.searchParams.get('page[cursor]') || undefined;
      if (!cursor) break;
    } else {
      break;
    }
  }

  console.log(`[fetchItems] Playlist ${playlistId}: total ${allItems.length} items`);
  return allItems;
}

const SYNC_LOCK_TTL_SECONDS = 60; // Lock expires after 60s to prevent deadlocks

/** Try to acquire a sync lock for a shared playlist. Returns true if acquired. */
export async function acquireSyncLock(db: D1Database, shareId: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  // Only acquire if no lock or lock has expired
  const result = await db.prepare(
    'UPDATE shared_playlists SET sync_started_at = ? WHERE id = ? AND (sync_started_at IS NULL OR sync_started_at < ?)',
  )
    .bind(now, shareId, now - SYNC_LOCK_TTL_SECONDS)
    .run();
  const acquired = (result.meta.changes ?? 0) > 0;
  console.log(`[sync] Lock ${acquired ? 'acquired' : 'BLOCKED (another sync in progress)'} for share ${shareId}`);
  return acquired;
}

export async function releaseSyncLock(db: D1Database, shareId: string): Promise<void> {
  await db.prepare('UPDATE shared_playlists SET sync_started_at = NULL WHERE id = ?')
    .bind(shareId)
    .run();
  console.log(`[sync] Lock released for share ${shareId}`);
}

/** Merge items from all playlists (owner + members), then write the union back to all */
export async function syncSharedPlaylist(
  db: D1Database,
  apiBase: string,
  clientId: string,
  clientSecret: string,
  shared: Record<string, unknown>,
  ownerSession: Record<string, unknown>,
  memberEntries: Array<{ session: Record<string, unknown>; playlistId: string }>,
): Promise<{ success: boolean; itemCount: number; errors: string[] }> {
  const errors: string[] = [];

  console.log(`[sync] Starting sync for shared playlist ${shared.id}, source: ${shared.tidal_playlist_id}, members: ${memberEntries.length}`);

  // Collect items from ALL playlists (owner + every member)
  const allPlaylistIds: Array<{ playlistId: string; session: Record<string, unknown>; label: string }> = [
    { playlistId: shared.tidal_playlist_id as string, session: ownerSession, label: `owner(${ownerSession.id})` },
    ...memberEntries.map((m) => ({ playlistId: m.playlistId, session: m.session, label: `member(${m.session.id})` })),
  ];

  // Use a map to deduplicate by "type:id" (same track shouldn't appear twice)
  const mergedMap = new Map<string, { id: string; type: string }>();
  // Track the order: items seen first keep their position
  const orderedKeys: string[] = [];

  for (const entry of allPlaylistIds) {
    try {
      console.log(`[sync] Refreshing token for ${entry.label}, playlist ${entry.playlistId}`);
      const token = await refreshAccessToken(db, entry.session, clientId, clientSecret);
      console.log(`[sync] Token refreshed OK for ${entry.label}`);

      const items = await fetchAllPlaylistItems(apiBase, entry.playlistId, token);
      const uniqueBefore = mergedMap.size;
      for (const item of items) {
        const key = `${item.type}:${item.id}`;
        if (!mergedMap.has(key)) {
          mergedMap.set(key, { id: item.id, type: item.type });
          orderedKeys.push(key);
        }
      }
      const newUnique = mergedMap.size - uniqueBefore;
      console.log(`[sync] Read ${items.length} items from ${entry.label} playlist ${entry.playlistId} (${newUnique} new unique, ${items.length - newUnique} dupes/overlap)`);
    } catch (e) {
      const errMsg = `Failed to read playlist ${entry.playlistId} for ${entry.label}: ${e}`;
      console.error(`[sync] ${errMsg}`);
      errors.push(errMsg);
    }
  }

  const mergedItems = orderedKeys.map((key) => mergedMap.get(key)!);
  console.log(`[sync] Merged result: ${mergedItems.length} unique items from ${allPlaylistIds.length} playlists`);

  // For each playlist, figure out what items are missing and POST only those
  for (const entry of allPlaylistIds) {
    try {
      const token = await refreshAccessToken(db, entry.session, clientId, clientSecret);

      // Read current items in this playlist (re-read to catch concurrent changes)
      const currentItems = await fetchAllPlaylistItems(apiBase, entry.playlistId, token);
      const currentSet = new Set(currentItems.map((item) => `${item.type}:${item.id}`));
      const dupesInPlaylist = currentItems.length - currentSet.size;
      if (dupesInPlaylist > 0) {
        console.warn(`[sync] ${entry.label} playlist ${entry.playlistId} has ${dupesInPlaylist} duplicate items (${currentItems.length} total, ${currentSet.size} unique)`);
      }

      // Find items that need to be added
      const missingItems = mergedItems.filter((item) => !currentSet.has(`${item.type}:${item.id}`));

      if (missingItems.length === 0) {
        console.log(`[sync] ${entry.label} playlist ${entry.playlistId} already up to date (${currentItems.length} items)`);
        continue;
      }

      const postUrl = `${apiBase}/playlists/${entry.playlistId}/relationships/items`;
      const postBody = JSON.stringify({
        data: missingItems.map((item) => ({ id: item.id, type: item.type })),
      });
      const itemSummary = missingItems.slice(0, 5).map((i) => `${i.type}:${i.id}`).join(', ');
      console.log(`[sync] POST ${postUrl} for ${entry.label}: adding ${missingItems.length} missing items (has ${currentSet.size} unique/${currentItems.length} total, merged ${mergedItems.length}): [${itemSummary}${missingItems.length > 5 ? ', ...' : ''}]`);

      const resp = await fetch(postUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
        },
        body: postBody,
      });

      if (!resp.ok) {
        const err = await resp.text();
        if (resp.status === 404) {
          console.warn(`[sync] Playlist ${entry.playlistId} for ${entry.label} not found (404) — skipping (may have been deleted from Tidal)`);
        } else if (resp.status === 429) {
          const retryAfter = resp.headers.get('retry-after') || '?';
          console.warn(`[sync] Rate limited (429) adding to playlist ${entry.playlistId} for ${entry.label}, retry-after: ${retryAfter}s — will retry next sync cycle`);
        } else {
          const errMsg = `Failed to add items to playlist ${entry.playlistId} for ${entry.label}: HTTP ${resp.status} ${err}`;
          console.error(`[sync] ${errMsg}`);
          errors.push(errMsg);
        }
      } else {
        console.log(`[sync] Successfully added ${missingItems.length} items to ${entry.label} playlist ${entry.playlistId}`);
      }
    } catch (e) {
      const errMsg = `Failed to sync playlist ${entry.playlistId} for ${entry.label}: ${e}`;
      console.error(`[sync] ${errMsg}`);
      errors.push(errMsg);
    }
  }

  console.log(`[sync] Sync complete: ${mergedItems.length} merged items, ${errors.length} errors`);
  return { success: errors.length === 0, itemCount: mergedItems.length, errors };
}

/** Find the owner session for a shared playlist (by stable user id, then legacy session id) */
export async function findOwnerSession(db: D1Database, shared: Record<string, unknown>) {
  let ownerSession = shared.owner_tidal_user_id
    ? await db.prepare('SELECT * FROM sessions WHERE tidal_user_id = ? ORDER BY updated_at DESC LIMIT 1')
        .bind(shared.owner_tidal_user_id).first()
    : null;
  if (!ownerSession) {
    ownerSession = await db.prepare('SELECT * FROM sessions WHERE id = ?')
      .bind(shared.owner_session_id).first();
  }
  return ownerSession;
}

/** Resolve each member of a share to their best (most recent) session + playlist copy */
export async function findMemberEntries(
  db: D1Database,
  shareId: string,
): Promise<Array<{ session: Record<string, unknown>; playlistId: string }>> {
  const memberRows = await db.prepare(
    'SELECT session_id, their_playlist_id, tidal_user_id FROM playlist_members WHERE shared_playlist_id = ?',
  )
    .bind(shareId)
    .all();

  const memberEntryPromises = memberRows.results
    .filter((m) => m.their_playlist_id)
    .map(async (m) => {
      // Find best session: by tidal_user_id (latest), then by session_id
      let s = m.tidal_user_id
        ? await db.prepare('SELECT * FROM sessions WHERE tidal_user_id = ? ORDER BY updated_at DESC LIMIT 1')
            .bind(m.tidal_user_id).first()
        : null;
      if (!s) {
        s = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(m.session_id).first();
      }
      if (!s) return null;
      return {
        session: s as Record<string, unknown>,
        playlistId: m.their_playlist_id as string,
      };
    });

  const resolved = await Promise.all(memberEntryPromises);
  return resolved.filter((e): e is NonNullable<typeof e> => e !== null);
}

/** Sync all shared playlists for all members (used by cron) */
export async function syncAllPlaylists(
  db: D1Database,
  apiBase: string,
  clientId: string,
  clientSecret: string,
): Promise<{ synced: number; failed: number; errors: string[] }> {
  const sharedPlaylists = await db.prepare('SELECT * FROM shared_playlists').all();
  let synced = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const shared of sharedPlaylists.results) {
    const ownerSession = await findOwnerSession(db, shared as Record<string, unknown>);
    if (!ownerSession) {
      errors.push(`Shared ${shared.id}: owner session expired`);
      failed++;
      continue;
    }

    const memberEntries = await findMemberEntries(db, shared.id as string);

    if (!await acquireSyncLock(db, shared.id as string)) {
      console.log(`[sync] Sync already in progress for ${shared.id}, skipping`);
      continue;
    }

    try {
      const result = await syncSharedPlaylist(
        db,
        apiBase,
        clientId,
        clientSecret,
        shared as Record<string, unknown>,
        ownerSession as Record<string, unknown>,
        memberEntries,
      );

      if (result.success) {
        synced++;
      } else {
        failed++;
        errors.push(...result.errors);
      }
    } finally {
      await releaseSyncLock(db, shared.id as string);
    }
  }

  return { synced, failed, errors };
}

export async function refreshAccessToken(
  db: D1Database,
  session: Record<string, unknown>,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = (session.token_expires_at as number) - now;
  if (expiresIn > 60) {
    console.log(`[auth] Token for session ${session.id} still valid (expires in ${expiresIn}s)`);
    return session.access_token as string;
  }

  if (!session.refresh_token) {
    console.error(`[auth] No refresh token for session ${session.id}`);
    throw new Error('No refresh token available');
  }

  console.log(`[auth] Refreshing token for session ${session.id} (expired ${-expiresIn}s ago)`);

  const resp = await fetch('https://auth.tidal.com/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refresh_token as string,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    console.error(`[auth] Token refresh failed for session ${session.id}: HTTP ${resp.status} ${errBody}`);
    throw new Error(`Token refresh failed: ${resp.status} ${errBody}`);
  }

  console.log(`[auth] Token refreshed successfully for session ${session.id}`);

  const tokens = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const expiresAt = now + tokens.expires_in;
  await db
    .prepare(
      'UPDATE sessions SET access_token = ?, refresh_token = COALESCE(?, refresh_token), token_expires_at = ?, updated_at = ? WHERE id = ?',
    )
    .bind(tokens.access_token, tokens.refresh_token ?? null, expiresAt, now, session.id)
    .run();

  return tokens.access_token;
}
