import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  type Env,
  generateId,
  sha256Base64Url,
  base64UrlEncode,
  getSession,
  refreshAccessToken,
  acquireSyncLock,
  releaseSyncLock,
  syncSharedPlaylist,
  syncAllPlaylists,
  findOwnerSession,
  findMemberEntries,
} from './tidal';
import { registerMcp, cleanupMcpTokens } from './mcp';

const app = new Hono<Env>();

// Remote MCP server + OAuth endpoints (see src/mcp.ts)
registerMcp(app);

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

  // Fetch user profile from Tidal to get user ID and display name
  let tidalUserId: string | null = null;
  let displayName: string | null = null;

  if (tokens.user?.userId) {
    tidalUserId = tokens.user.userId;
  }

  // Call /users/me to get user ID and name
  try {
    const userResp = await fetch(`${c.env.TIDAL_API_BASE}/users/me`, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/vnd.api+json',
      },
    });
    if (userResp.ok) {
      const userData = (await userResp.json()) as {
        data: { id: string; attributes: { firstName?: string; lastName?: string } };
      };
      tidalUserId = tidalUserId || userData.data.id;
      const first = userData.data.attributes.firstName || '';
      const last = userData.data.attributes.lastName || '';
      displayName = [first, last].filter(Boolean).join(' ') || null;
      console.log(`[auth] User profile: id=${tidalUserId} name=${displayName}`);
    }
  } catch (e) {
    console.warn(`[auth] Failed to fetch user profile: ${e}`);
  }

  await c.env.DB.prepare(
    'INSERT INTO sessions (id, tidal_user_id, access_token, refresh_token, token_expires_at, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(sessionId, tidalUserId, tokens.access_token, tokens.refresh_token, now + tokens.expires_in, displayName, now, now)
    .run();

  // Backfill stable tidal_user_id on older records that only had session_id.
  // This fixes visibility after re-login: old shared_playlists / playlist_members
  // rows created before tidal_user_id tracking was added now get linked.
  if (tidalUserId) {
    // Collect old session IDs that belong to this user:
    // 1) Sessions that already have this tidal_user_id (from previous logins after the fix)
    const oldSessions = await c.env.DB.prepare(
      'SELECT id FROM sessions WHERE tidal_user_id = ? AND id != ?',
    )
      .bind(tidalUserId, sessionId)
      .all();
    const oldSessionIds = oldSessions.results.map((s) => s.id as string);

    // 2) The session from the cookie the user had BEFORE this login — this links
    //    pre-migration sessions (tidal_user_id = NULL) to this Tidal user.
    const prevSessionId = getCookie(c, 'session');
    if (prevSessionId && prevSessionId !== sessionId && !oldSessionIds.includes(prevSessionId)) {
      oldSessionIds.push(prevSessionId);
      // Also set tidal_user_id on the old session itself for future lookups
      await c.env.DB.prepare(
        'UPDATE sessions SET tidal_user_id = ?, display_name = COALESCE(display_name, ?) WHERE id = ? AND tidal_user_id IS NULL',
      )
        .bind(tidalUserId, displayName, prevSessionId)
        .run();
    }

    if (oldSessionIds.length > 0) {
      await c.env.DB.batch([
        // Update shared_playlists where owner_tidal_user_id is still NULL
        ...oldSessionIds.map((oldId) =>
          c.env.DB.prepare(
            'UPDATE shared_playlists SET owner_tidal_user_id = ? WHERE owner_session_id = ? AND owner_tidal_user_id IS NULL',
          ).bind(tidalUserId, oldId),
        ),
        // Backfill playlist_members
        ...oldSessionIds.map((oldId) =>
          c.env.DB.prepare(
            'UPDATE playlist_members SET tidal_user_id = ? WHERE session_id = ? AND tidal_user_id IS NULL',
          ).bind(tidalUserId, oldId),
        ),
      ]);
      console.log(`[auth] Backfilled tidal_user_id=${tidalUserId} on ${oldSessionIds.length} old sessions' records`);
    }
  }

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
    // Don't delete the session row — it's referenced by FK constraints in
    // shared_playlists, playlist_members, reactions, comments.
    // Instead, wipe the tokens so the session can't be used for API calls.
    await c.env.DB.prepare(
      'UPDATE sessions SET access_token = \'\', refresh_token = NULL, token_expires_at = 0, updated_at = ? WHERE id = ?',
    )
      .bind(Math.floor(Date.now() / 1000), sessionId)
      .run();
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
  return c.json({ loggedIn: true, userId: session.tidal_user_id, displayName: session.display_name });
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

  // Check if this playlist is already shared
  const existing = await c.env.DB.prepare(
    'SELECT id FROM shared_playlists WHERE tidal_playlist_id = ?',
  )
    .bind(playlistId)
    .first<{ id: string }>();

  if (existing) {
    return c.json({ shareId: existing.id, shareUrl: `${c.env.APP_URL}/#/shared/${existing.id}` });
  }

  const shareId = generateId().slice(0, 12);

  await c.env.DB.prepare(
    'INSERT INTO shared_playlists (id, tidal_playlist_id, owner_session_id, owner_tidal_user_id, name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(shareId, playlistId, sessionId, session.tidal_user_id, name, Math.floor(Date.now() / 1000))
    .run();

  return c.json({ shareId, shareUrl: `${c.env.APP_URL}/#/shared/${shareId}` });
});

app.delete('/api/share/:id', async (c) => {
  const shareId = c.req.param('id');
  const sessionId = getCookie(c, 'session');
  const session = await getSession(c.env.DB, sessionId);
  if (!session) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const shared = await c.env.DB.prepare('SELECT * FROM shared_playlists WHERE id = ?')
    .bind(shareId)
    .first();

  if (!shared) {
    return c.json({ error: 'Not found' }, 404);
  }

  // Check ownership by session_id OR tidal_user_id (survives re-login)
  const isOwner =
    shared.owner_session_id === sessionId ||
    (session.tidal_user_id && shared.owner_tidal_user_id === session.tidal_user_id);
  if (!isOwner) {
    return c.json({ error: 'Only the owner can delete a shared playlist' }, 403);
  }

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM playlist_members WHERE shared_playlist_id = ?').bind(shareId),
    c.env.DB.prepare('DELETE FROM shared_playlists WHERE id = ?').bind(shareId),
  ]);

  console.log(`[share] Deleted shared playlist ${shareId}`);
  return c.json({ success: true });
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
    'SELECT pm.*, s.tidal_user_id, s.display_name FROM playlist_members pm JOIN sessions s ON pm.session_id = s.id WHERE pm.shared_playlist_id = ?',
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

  // Check if this user is already a member (by tidal_user_id or session_id)
  const tidalUserId = session.tidal_user_id as string | null;
  const existingMember = tidalUserId
    ? await c.env.DB.prepare(
        'SELECT * FROM playlist_members WHERE shared_playlist_id = ? AND (tidal_user_id = ? OR session_id = ?)',
      ).bind(shareId, tidalUserId, sessionId).first()
    : await c.env.DB.prepare(
        'SELECT * FROM playlist_members WHERE shared_playlist_id = ? AND session_id = ?',
      ).bind(shareId, sessionId).first();

  const isRejoin = !!existingMember;
  if (isRejoin) {
    console.log(`[join] Re-join detected for member ${existingMember.id}, old playlist: ${existingMember.their_playlist_id}`);
  }

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

  if (isRejoin) {
    await c.env.DB.prepare(
      'UPDATE playlist_members SET session_id = ?, tidal_user_id = ?, their_playlist_id = ?, joined_at = ? WHERE id = ?',
    )
      .bind(sessionId, session.tidal_user_id, theirPlaylistId, Math.floor(Date.now() / 1000), existingMember.id)
      .run();
    console.log(`[join] Re-joined: updated member ${existingMember.id} with new playlist ${theirPlaylistId}`);
  } else {
    await c.env.DB.prepare(
      'INSERT INTO playlist_members (shared_playlist_id, session_id, tidal_user_id, their_playlist_id, joined_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(shareId, sessionId, session.tidal_user_id, theirPlaylistId, Math.floor(Date.now() / 1000))
      .run();
    console.log(`[join] Member saved: share=${shareId} session=${sessionId} playlist=${theirPlaylistId}`);
  }

  return c.json({ success: true, theirPlaylistId, rejoin: isRejoin });
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

  const ownerSession = await findOwnerSession(c.env.DB, shared as Record<string, unknown>);
  if (!ownerSession) {
    console.error(`[manualSync] Owner session not found for share ${shareId}`);
    return c.json({ error: 'Owner session expired' }, 400);
  }

  console.log(`[manualSync] Owner session found (${ownerSession.id}), querying members...`);

  const memberEntries = await findMemberEntries(c.env.DB, shareId);

  console.log(`[manualSync] Found ${memberEntries.length} members with valid sessions`);

  if (memberEntries.length === 0) {
    console.log(`[manualSync] No members to sync, returning early`);
    return c.json({ success: true, itemCount: 0, message: 'No members to sync yet' });
  }

  if (!await acquireSyncLock(c.env.DB, shareId)) {
    console.log(`[manualSync] Sync already in progress for ${shareId}, skipping`);
    return c.json({ success: true, itemCount: 0, message: 'Sync already in progress' });
  }

  try {
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
  } finally {
    await releaseSyncLock(c.env.DB, shareId);
  }
});

// ── My shared playlists ──────────────────────────────────────────────

app.get('/api/my-shares', async (c) => {
  const sessionId = getCookie(c, 'session');
  if (!sessionId) return c.json({ shares: [], memberships: [] });

  const session = await getSession(c.env.DB, sessionId);
  if (!session) return c.json({ shares: [], memberships: [] });

  const tidalUserId = session.tidal_user_id as string | null;

  // Find shares by tidal_user_id (stable across re-logins) or session_id (legacy fallback)
  const shares = await c.env.DB.prepare(
    'SELECT * FROM shared_playlists WHERE owner_tidal_user_id = ? OR owner_session_id = ? ORDER BY created_at DESC',
  )
    .bind(tidalUserId, sessionId)
    .all();

  const memberships = await c.env.DB.prepare(
    'SELECT pm.*, sp.name, sp.tidal_playlist_id FROM playlist_members pm JOIN shared_playlists sp ON pm.shared_playlist_id = sp.id WHERE pm.tidal_user_id = ? OR pm.session_id = ? ORDER BY pm.joined_at DESC',
  )
    .bind(tidalUserId, sessionId)
    .all();

  console.log(`[my-shares] session=${sessionId?.slice(0, 8)}... tidal_user_id=${tidalUserId} → ${shares.results.length} owned, ${memberships.results.length} memberships`);
  return c.json({ shares: shares.results, memberships: memberships.results });
});

// ── Reactions ────────────────────────────────────────────────────────

// Get all reactions for all tracks in a shared playlist
app.get('/api/share/:id/reactions', async (c) => {
  const shareId = c.req.param('id');
  const result = await c.env.DB.prepare(
    'SELECT track_id, emoji, COUNT(*) as count FROM reactions WHERE shared_playlist_id = ? GROUP BY track_id, emoji',
  )
    .bind(shareId)
    .all();

  // Also get the current user's reactions
  const sessionId = getCookie(c, 'session');
  let myReactions: Record<string, unknown>[] = [];
  if (sessionId) {
    const myResult = await c.env.DB.prepare(
      'SELECT track_id, emoji FROM reactions WHERE shared_playlist_id = ? AND session_id = ?',
    )
      .bind(shareId, sessionId)
      .all();
    myReactions = myResult.results;
  }

  return c.json({ reactions: result.results, myReactions });
});

// Toggle a reaction on a track (add if not exists, remove if exists)
app.post('/api/share/:id/reactions', async (c) => {
  const shareId = c.req.param('id');
  const sessionId = getCookie(c, 'session');
  if (!sessionId) return c.json({ error: 'Not authenticated' }, 401);

  const session = await getSession(c.env.DB, sessionId);
  if (!session) return c.json({ error: 'Not authenticated' }, 401);

  const { trackId, emoji } = await c.req.json<{ trackId: string; emoji: string }>();

  // Check if reaction already exists
  const existing = await c.env.DB.prepare(
    'SELECT id FROM reactions WHERE shared_playlist_id = ? AND track_id = ? AND session_id = ? AND emoji = ?',
  )
    .bind(shareId, trackId, sessionId, emoji)
    .first();

  if (existing) {
    await c.env.DB.prepare('DELETE FROM reactions WHERE id = ?').bind(existing.id).run();
    return c.json({ action: 'removed' });
  } else {
    await c.env.DB.prepare(
      'INSERT INTO reactions (shared_playlist_id, track_id, session_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(shareId, trackId, sessionId, emoji, Math.floor(Date.now() / 1000))
      .run();
    return c.json({ action: 'added' });
  }
});

// ── Comments ─────────────────────────────────────────────────────────

// Get comments for a specific track in a shared playlist
app.get('/api/share/:id/comments/:trackId', async (c) => {
  const shareId = c.req.param('id');
  const trackId = c.req.param('trackId');

  const result = await c.env.DB.prepare(
    'SELECT c.id, c.body, c.display_name, c.created_at, c.session_id FROM comments c WHERE c.shared_playlist_id = ? AND c.track_id = ? ORDER BY c.created_at ASC',
  )
    .bind(shareId, trackId)
    .all();

  const sessionId = getCookie(c, 'session');

  return c.json({
    comments: result.results.map((comment) => ({
      ...comment,
      isMe: comment.session_id === sessionId,
    })),
  });
});

// Get comment counts for all tracks in a shared playlist
app.get('/api/share/:id/comment-counts', async (c) => {
  const shareId = c.req.param('id');
  const result = await c.env.DB.prepare(
    'SELECT track_id, COUNT(*) as count FROM comments WHERE shared_playlist_id = ? GROUP BY track_id',
  )
    .bind(shareId)
    .all();

  return c.json({ counts: result.results });
});

// Post a comment on a track
app.post('/api/share/:id/comments/:trackId', async (c) => {
  const shareId = c.req.param('id');
  const trackId = c.req.param('trackId');
  const sessionId = getCookie(c, 'session');
  if (!sessionId) return c.json({ error: 'Not authenticated' }, 401);

  const session = await getSession(c.env.DB, sessionId);
  if (!session) return c.json({ error: 'Not authenticated' }, 401);

  const { body, displayName } = await c.req.json<{ body: string; displayName?: string }>();

  if (!body || body.trim().length === 0) {
    return c.json({ error: 'Comment cannot be empty' }, 400);
  }

  const result = await c.env.DB.prepare(
    'INSERT INTO comments (shared_playlist_id, track_id, session_id, display_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, created_at',
  )
    .bind(shareId, trackId, sessionId, displayName || null, body.trim(), Math.floor(Date.now() / 1000))
    .first();

  return c.json({ success: true, comment: result });
});

// Delete a comment (only the author can delete)
app.delete('/api/share/:id/comments/:trackId/:commentId', async (c) => {
  const commentId = c.req.param('commentId');
  const sessionId = getCookie(c, 'session');
  if (!sessionId) return c.json({ error: 'Not authenticated' }, 401);

  const comment = await c.env.DB.prepare('SELECT session_id FROM comments WHERE id = ?')
    .bind(commentId)
    .first();

  if (!comment) return c.json({ error: 'Not found' }, 404);
  if (comment.session_id !== sessionId) return c.json({ error: 'Not your comment' }, 403);

  await c.env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(commentId).run();
  return c.json({ success: true });
});

// ── Debug / diagnostic endpoints ─────────────────────────────────────

// Public: show all shared playlists and sessions (no secrets)
app.get('/api/debug/state', async (c) => {
  const shares = await c.env.DB.prepare('SELECT id, tidal_playlist_id, owner_session_id, owner_tidal_user_id, name, created_at FROM shared_playlists').all();
  const members = await c.env.DB.prepare('SELECT shared_playlist_id, session_id, tidal_user_id, their_playlist_id, joined_at FROM playlist_members').all();
  const sessions = await c.env.DB.prepare('SELECT id, tidal_user_id, display_name, token_expires_at, created_at, updated_at FROM sessions').all();
  const now = Math.floor(Date.now() / 1000);
  return c.json({
    shares: shares.results,
    members: members.results,
    sessions: sessions.results.map((s) => ({
      ...s,
      tokenExpired: (s.token_expires_at as number) < now,
    })),
  });
});

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
      cleanupMcpTokens(env.DB).catch((err) => console.error('MCP token cleanup error:', err)),
    );
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
