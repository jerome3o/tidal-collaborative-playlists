import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

type Env = {
  Bindings: {
    DB: D1Database;
    TIDAL_CLIENT_ID: string;
    TIDAL_CLIENT_SECRET: string;
    TIDAL_AUTH_BASE: string;
    TIDAL_API_BASE: string;
    APP_URL: string;
  };
};

const app = new Hono<Env>();

// ── Helpers ──────────────────────────────────────────────────────────

function generateId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Base64Url(plain: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getSession(db: D1Database, sessionId: string | undefined) {
  if (!sessionId) return null;
  return db.prepare('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first();
}

/** Fetch all items from a playlist, handling cursor pagination */
async function fetchAllPlaylistItems(
  apiBase: string,
  playlistId: string,
  token: string,
): Promise<Array<{ id: string; type: string }>> {
  const allItems: Array<{ id: string; type: string }> = [];
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
      console.error(`[fetchItems] Failed for playlist ${playlistId}: ${resp.status} ${errText}`);
      break;
    }

    const body = (await resp.json()) as {
      data: Array<{ id: string; type: string }>;
      links?: { next?: string };
    };

    const pageItems = body.data || [];
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

/** Merge items from all playlists (owner + members), then write the union back to all */
async function syncSharedPlaylist(
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
      console.log(`[sync] Read ${items.length} items from ${entry.label} playlist ${entry.playlistId}`);

      for (const item of items) {
        const key = `${item.type}:${item.id}`;
        if (!mergedMap.has(key)) {
          mergedMap.set(key, { id: item.id, type: item.type });
          orderedKeys.push(key);
        }
      }
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

      // Read current items in this playlist
      const currentItems = await fetchAllPlaylistItems(apiBase, entry.playlistId, token);
      const currentSet = new Set(currentItems.map((item) => `${item.type}:${item.id}`));

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
      console.log(`[sync] POST ${postUrl} for ${entry.label}: adding ${missingItems.length} missing items (has ${currentItems.length}, merged total ${mergedItems.length})`);

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
        const errMsg = `Failed to add items to playlist ${entry.playlistId} for ${entry.label}: HTTP ${resp.status} ${err}`;
        console.error(`[sync] ${errMsg}`);
        errors.push(errMsg);
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

/** Sync all shared playlists for all members (used by cron) */
async function syncAllPlaylists(
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
    const ownerSession = await db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .bind(shared.owner_session_id)
      .first();
    if (!ownerSession) {
      errors.push(`Shared ${shared.id}: owner session expired`);
      failed++;
      continue;
    }

    const members = await db
      .prepare(
        `SELECT pm.shared_playlist_id, pm.session_id, pm.their_playlist_id,
                s.id as s_id, s.tidal_user_id, s.access_token, s.refresh_token,
                s.token_expires_at, s.created_at as s_created_at, s.updated_at as s_updated_at
         FROM playlist_members pm
         JOIN sessions s ON pm.session_id = s.id
         WHERE pm.shared_playlist_id = ?`,
      )
      .bind(shared.id)
      .all();

    const memberEntries = members.results
      .filter((m) => m.their_playlist_id)
      .map((m) => ({
        session: {
          id: m.s_id,
          tidal_user_id: m.tidal_user_id,
          access_token: m.access_token,
          refresh_token: m.refresh_token,
          token_expires_at: m.token_expires_at,
          created_at: m.s_created_at,
          updated_at: m.s_updated_at,
        } as Record<string, unknown>,
        playlistId: m.their_playlist_id as string,
      }));

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
  }

  return { synced, failed, errors };
}

async function refreshAccessToken(
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

// ── Auth Routes ──────────────────────────────────────────────────────

// Debug endpoint: shows what we'd send to Tidal (remove once auth works)
app.get('/auth/debug', async (c) => {
  const redirectUri = `${c.env.APP_URL}/auth/callback`;
  return c.json({
    message: 'Check these values against your Tidal developer app settings',
    client_id: c.env.TIDAL_CLIENT_ID,
    redirect_uri: redirectUri,
    scopes: 'playlists.read playlists.write collection.read collection.write user.read',
    authorize_url: `${c.env.TIDAL_AUTH_BASE}/authorize`,
    app_url: c.env.APP_URL,
    hints: [
      'Ensure client_id matches your Tidal developer dashboard exactly',
      'Ensure redirect_uri is registered in your Tidal app settings (exact match required, including trailing slash)',
      'Ensure the scopes are enabled for your app in the Tidal dashboard',
    ],
  });
});

app.get('/auth/login', async (c) => {
  const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = generateId();
  const redirectAfter = c.req.query('redirect') || '/';

  await c.env.DB.prepare(
    'INSERT INTO pkce_state (state, code_verifier, redirect_after, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(state, codeVerifier, redirectAfter, Math.floor(Date.now() / 1000))
    .run();

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: c.env.TIDAL_CLIENT_ID,
    redirect_uri: `${c.env.APP_URL}/auth/callback`,
    scope: 'playlists.read playlists.write collection.read collection.write user.read',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return c.redirect(`${c.env.TIDAL_AUTH_BASE}/authorize?${params}`);
});

app.get('/auth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    return c.json({ error: c.req.query('error_description') || error }, 400);
  }

  if (!code || !state) {
    return c.json({ error: 'Missing code or state' }, 400);
  }

  const pkce = await c.env.DB.prepare('SELECT * FROM pkce_state WHERE state = ?')
    .bind(state)
    .first<{ code_verifier: string; redirect_after: string }>();

  if (!pkce) {
    return c.json({ error: 'Invalid state' }, 400);
  }

  // Clean up PKCE state
  await c.env.DB.prepare('DELETE FROM pkce_state WHERE state = ?').bind(state).run();

  // Exchange code for tokens
  const tokenResp = await fetch('https://auth.tidal.com/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: c.env.TIDAL_CLIENT_ID,
      client_secret: c.env.TIDAL_CLIENT_SECRET,
      redirect_uri: `${c.env.APP_URL}/auth/callback`,
      code_verifier: pkce.code_verifier,
    }),
  });

  if (!tokenResp.ok) {
    const errBody = await tokenResp.text();
    return c.json({ error: 'Token exchange failed', details: errBody }, 500);
  }

  const tokens = (await tokenResp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    user?: { userId: string };
  };

  const now = Math.floor(Date.now() / 1000);
  const sessionId = generateId();

  // Try to extract user ID from the token response or make a /me call
  let tidalUserId: string | null = null;
  if (tokens.user?.userId) {
    tidalUserId = tokens.user.userId;
  }

  await c.env.DB.prepare(
    'INSERT INTO sessions (id, tidal_user_id, access_token, refresh_token, token_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(sessionId, tidalUserId, tokens.access_token, tokens.refresh_token, now + tokens.expires_in, now, now)
    .run();

  setCookie(c, 'session', sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });

  return c.redirect(pkce.redirect_after || '/');
});

app.get('/auth/logout', async (c) => {
  const sessionId = getCookie(c, 'session');
  if (sessionId) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
  }
  deleteCookie(c, 'session', { path: '/' });
  return c.redirect('/');
});

app.get('/auth/me', async (c) => {
  const sessionId = getCookie(c, 'session');
  const session = await getSession(c.env.DB, sessionId);
  if (!session) {
    return c.json({ loggedIn: false });
  }
  return c.json({ loggedIn: true, userId: session.tidal_user_id });
});

// ── Tidal API Proxy ──────────────────────────────────────────────────

const handleTidalMutation = async (c: Context<Env>) => {
  const sessionId = getCookie(c, 'session');
  const session = await getSession(c.env.DB, sessionId);
  if (!session) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const accessToken = await refreshAccessToken(
    c.env.DB,
    session as Record<string, unknown>,
    c.env.TIDAL_CLIENT_ID,
    c.env.TIDAL_CLIENT_SECRET,
  );

  const tidalPath = c.req.path.replace('/api/tidal', '');
  const url = new URL(`${c.env.TIDAL_API_BASE}${tidalPath}`);

  const reqUrl = new URL(c.req.url);
  reqUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const body = ['POST', 'PATCH', 'PUT'].includes(c.req.method)
    ? await c.req.text()
    : undefined;

  const resp = await fetch(url.toString(), {
    method: c.req.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.api+json',
      ...(body ? { 'Content-Type': 'application/vnd.api+json' } : {}),
    },
    body,
  });

  const respBody = await resp.text();
  return c.newResponse(respBody, resp.status as 200, {
    'Content-Type': resp.headers.get('Content-Type') || 'application/json',
  });
};

app.get('/api/tidal/*', async (c) => {
  const sessionId = getCookie(c, 'session');
  const session = await getSession(c.env.DB, sessionId);
  if (!session) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const accessToken = await refreshAccessToken(
    c.env.DB,
    session as Record<string, unknown>,
    c.env.TIDAL_CLIENT_ID,
    c.env.TIDAL_CLIENT_SECRET,
  );

  // Strip /api/tidal prefix to get the Tidal API path
  const tidalPath = c.req.path.replace('/api/tidal', '');
  const url = new URL(`${c.env.TIDAL_API_BASE}${tidalPath}`);

  // Forward query parameters
  const reqUrl = new URL(c.req.url);
  reqUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.api+json',
    },
  });

  const body = await resp.text();
  return c.newResponse(body, resp.status as 200, {
    'Content-Type': resp.headers.get('Content-Type') || 'application/json',
  });
});

// Tidal API proxy for mutations (POST, PATCH, DELETE)
app.post('/api/tidal/*', handleTidalMutation);
app.patch('/api/tidal/*', handleTidalMutation);
app.put('/api/tidal/*', handleTidalMutation);
app.delete('/api/tidal/*', handleTidalMutation);

// ── Share / Collaboration Routes ─────────────────────────────────────

app.post('/api/share', async (c) => {
  const sessionId = getCookie(c, 'session');
  const session = await getSession(c.env.DB, sessionId);
  if (!session) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const { playlistId, name } = await c.req.json<{ playlistId: string; name: string }>();
  const shareId = generateId().slice(0, 12);

  await c.env.DB.prepare(
    'INSERT INTO shared_playlists (id, tidal_playlist_id, owner_session_id, name, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(shareId, playlistId, sessionId, name, Math.floor(Date.now() / 1000))
    .run();

  return c.json({ shareId, shareUrl: `${c.env.APP_URL}/join/${shareId}` });
});

app.get('/api/share/:id', async (c) => {
  const shareId = c.req.param('id');
  const shared = await c.env.DB.prepare('SELECT * FROM shared_playlists WHERE id = ?')
    .bind(shareId)
    .first();

  if (!shared) {
    return c.json({ error: 'Not found' }, 404);
  }

  const members = await c.env.DB.prepare(
    'SELECT pm.*, s.tidal_user_id FROM playlist_members pm JOIN sessions s ON pm.session_id = s.id WHERE pm.shared_playlist_id = ?',
  )
    .bind(shareId)
    .all();

  return c.json({ shared, members: members.results });
});

app.post('/api/share/:id/join', async (c) => {
  const shareId = c.req.param('id');
  const sessionId = getCookie(c, 'session');
  console.log(`[join] Join request for share ${shareId} from session ${sessionId}`);

  const session = await getSession(c.env.DB, sessionId);
  if (!session) {
    console.error(`[join] No session found for ${sessionId}`);
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const shared = await c.env.DB.prepare('SELECT * FROM shared_playlists WHERE id = ?')
    .bind(shareId)
    .first();

  if (!shared) {
    console.error(`[join] Shared playlist ${shareId} not found`);
    return c.json({ error: 'Not found' }, 404);
  }

  console.log(`[join] Found shared playlist: ${shared.name}, source: ${shared.tidal_playlist_id}`);

  const accessToken = await refreshAccessToken(
    c.env.DB,
    session as Record<string, unknown>,
    c.env.TIDAL_CLIENT_ID,
    c.env.TIDAL_CLIENT_SECRET,
  );

  // Get the source playlist details
  console.log(`[join] Fetching source playlist details: ${shared.tidal_playlist_id}`);
  const playlistResp = await fetch(
    `${c.env.TIDAL_API_BASE}/playlists/${shared.tidal_playlist_id}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.api+json',
      },
    },
  );

  let playlistName = shared.name || 'Shared Playlist';
  if (playlistResp.ok) {
    const playlistData = (await playlistResp.json()) as {
      data: { attributes: { name: string } };
    };
    playlistName = playlistData.data.attributes.name;
    console.log(`[join] Source playlist name: ${playlistName}`);
  } else {
    const errText = await playlistResp.text();
    console.warn(`[join] Could not fetch source playlist details: ${playlistResp.status} ${errText}`);
  }

  // Create a copy of the playlist in the joining user's account
  const createBody = JSON.stringify({
    data: {
      attributes: {
        name: `${playlistName} (synced)`,
        description: 'Synced from collaborative playlist',
      },
      type: 'playlists',
    },
  });
  console.log(`[join] Creating playlist copy: POST ${c.env.TIDAL_API_BASE}/playlists body=${createBody}`);

  const createResp = await fetch(`${c.env.TIDAL_API_BASE}/playlists`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    },
    body: createBody,
  });

  if (!createResp.ok) {
    const errBody = await createResp.text();
    console.error(`[join] Failed to create playlist copy: ${createResp.status} ${errBody}`);
    return c.json({
      error: 'Failed to create playlist copy in your Tidal account',
      status: createResp.status,
      details: errBody,
    }, 500);
  }

  const createData = (await createResp.json()) as { data: { id: string } };
  const theirPlaylistId = createData.data.id;
  console.log(`[join] Created playlist copy: ${theirPlaylistId}`);

  await c.env.DB.prepare(
    'INSERT OR REPLACE INTO playlist_members (shared_playlist_id, session_id, their_playlist_id, joined_at) VALUES (?, ?, ?, ?)',
  )
    .bind(shareId, sessionId, theirPlaylistId, Math.floor(Date.now() / 1000))
    .run();

  console.log(`[join] Member saved: share=${shareId} session=${sessionId} playlist=${theirPlaylistId}`);
  return c.json({ success: true, theirPlaylistId });
});

// ── Sync endpoint: copy items from source to member playlists ────────

app.post('/api/share/:id/sync', async (c) => {
  const shareId = c.req.param('id');
  const sessionId = getCookie(c, 'session');
  console.log(`[manualSync] Sync request for share ${shareId} from session ${sessionId}`);

  const session = await getSession(c.env.DB, sessionId);
  if (!session) {
    console.error(`[manualSync] No session for ${sessionId}`);
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const shared = await c.env.DB.prepare('SELECT * FROM shared_playlists WHERE id = ?')
    .bind(shareId)
    .first();
  if (!shared) {
    console.error(`[manualSync] Shared playlist ${shareId} not found`);
    return c.json({ error: 'Not found' }, 404);
  }

  const ownerSession = await c.env.DB.prepare('SELECT * FROM sessions WHERE id = ?')
    .bind(shared.owner_session_id)
    .first();
  if (!ownerSession) {
    console.error(`[manualSync] Owner session ${shared.owner_session_id} not found`);
    return c.json({ error: 'Owner session expired' }, 400);
  }

  console.log(`[manualSync] Owner session found, querying members...`);

  // Get all members for bidirectional sync
  const members = await c.env.DB.prepare(
    `SELECT pm.session_id, pm.their_playlist_id,
            s.id as s_id, s.tidal_user_id, s.access_token, s.refresh_token,
            s.token_expires_at, s.created_at as s_created_at, s.updated_at as s_updated_at
     FROM playlist_members pm
     JOIN sessions s ON pm.session_id = s.id
     WHERE pm.shared_playlist_id = ?`,
  )
    .bind(shareId)
    .all();

  const memberEntries = members.results
    .filter((m) => m.their_playlist_id)
    .map((m) => ({
      session: {
        id: m.s_id,
        tidal_user_id: m.tidal_user_id,
        access_token: m.access_token,
        refresh_token: m.refresh_token,
        token_expires_at: m.token_expires_at,
        created_at: m.s_created_at,
        updated_at: m.s_updated_at,
      } as Record<string, unknown>,
      playlistId: m.their_playlist_id as string,
    }));

  console.log(`[manualSync] Found ${members.results.length} member rows, ${memberEntries.length} with playlist IDs`);

  if (memberEntries.length === 0) {
    console.log(`[manualSync] No members to sync, returning early`);
    return c.json({ success: true, itemCount: 0, message: 'No members to sync yet' });
  }

  const result = await syncSharedPlaylist(
    c.env.DB,
    c.env.TIDAL_API_BASE,
    c.env.TIDAL_CLIENT_ID,
    c.env.TIDAL_CLIENT_SECRET,
    shared as Record<string, unknown>,
    ownerSession as Record<string, unknown>,
    memberEntries,
  );

  if (!result.success) {
    return c.json({ error: 'Sync had errors', details: result.errors }, 500);
  }

  return c.json({ success: true, itemCount: result.itemCount });
});

// ── My shared playlists ──────────────────────────────────────────────

app.get('/api/my-shares', async (c) => {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) return c.json({ shares: [], memberships: [] });

  const shares = await c.env.DB.prepare(
    'SELECT * FROM shared_playlists WHERE owner_session_id = ? ORDER BY created_at DESC',
  )
    .bind(sessionId)
    .all();

  const memberships = await c.env.DB.prepare(
    'SELECT pm.*, sp.name, sp.tidal_playlist_id FROM playlist_members pm JOIN shared_playlists sp ON pm.shared_playlist_id = sp.id WHERE pm.session_id = ? ORDER BY pm.joined_at DESC',
  )
    .bind(sessionId)
    .all();

  return c.json({ shares: shares.results, memberships: memberships.results });
});

// ── Debug / diagnostic endpoint ──────────────────────────────────────

app.get('/api/debug/share/:id', async (c) => {
  const shareId = c.req.param('id');
  const sessionId = getCookie(c, 'session');

  const shared = await c.env.DB.prepare('SELECT * FROM shared_playlists WHERE id = ?')
    .bind(shareId)
    .first();

  if (!shared) return c.json({ error: 'Shared playlist not found' }, 404);

  const ownerSession = await c.env.DB.prepare('SELECT id, tidal_user_id, token_expires_at FROM sessions WHERE id = ?')
    .bind(shared.owner_session_id)
    .first();

  const members = await c.env.DB.prepare(
    `SELECT pm.session_id, pm.their_playlist_id, s.tidal_user_id, s.token_expires_at
     FROM playlist_members pm
     JOIN sessions s ON pm.session_id = s.id
     WHERE pm.shared_playlist_id = ?`,
  )
    .bind(shareId)
    .all();

  const now = Math.floor(Date.now() / 1000);

  return c.json({
    shared,
    currentSessionId: sessionId,
    ownerSession: ownerSession
      ? { ...ownerSession, tokenExpired: (ownerSession.token_expires_at as number) < now }
      : null,
    members: members.results.map((m) => ({
      ...m,
      tokenExpired: (m.token_expires_at as number) < now,
      isCurrentUser: m.session_id === sessionId,
    })),
  });
});

// ── Sync status endpoint (for frontend polling) ─────────────────────

app.get('/api/share/:id/sync-status', async (c) => {
  const shareId = c.req.param('id');
  const shared = await c.env.DB.prepare('SELECT * FROM shared_playlists WHERE id = ?')
    .bind(shareId)
    .first();
  if (!shared) return c.json({ error: 'Not found' }, 404);

  const members = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM playlist_members WHERE shared_playlist_id = ?',
  )
    .bind(shareId)
    .first<{ count: number }>();

  return c.json({
    playlistId: shared.tidal_playlist_id,
    name: shared.name,
    memberCount: members?.count || 0,
    lastChecked: new Date().toISOString(),
  });
});

// ── Export with scheduled handler ────────────────────────────────────

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env['Bindings'], ctx: ExecutionContext) {
    ctx.waitUntil(
      syncAllPlaylists(env.DB, env.TIDAL_API_BASE, env.TIDAL_CLIENT_ID, env.TIDAL_CLIENT_SECRET)
        .then((result) => {
          console.log(
            `Cron sync complete: ${result.synced} synced, ${result.failed} failed`,
            result.errors.length > 0 ? result.errors : '',
          );
        })
        .catch((err) => {
          console.error('Cron sync error:', err);
        }),
    );
  },
};
