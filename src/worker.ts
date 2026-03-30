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

async function refreshAccessToken(
  db: D1Database,
  session: Record<string, unknown>,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if ((session.token_expires_at as number) > now + 60) {
    return session.access_token as string;
  }

  if (!session.refresh_token) {
    throw new Error('No refresh token available');
  }

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
    throw new Error(`Token refresh failed: ${resp.status}`);
  }

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

  const accessToken = await refreshAccessToken(
    c.env.DB,
    session as Record<string, unknown>,
    c.env.TIDAL_CLIENT_ID,
    c.env.TIDAL_CLIENT_SECRET,
  );

  // Get the source playlist details
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
  }

  // Create a copy of the playlist in the joining user's account
  const createResp = await fetch(`${c.env.TIDAL_API_BASE}/playlists`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: {
        attributes: {
          name: `${playlistName} (synced)`,
          description: `Synced from collaborative playlist`,
          privacy: 'PRIVATE',
        },
        type: 'playlists',
      },
    }),
  });

  let theirPlaylistId: string | null = null;
  if (createResp.ok) {
    const createData = (await createResp.json()) as { data: { id: string } };
    theirPlaylistId = createData.data.id;
  }

  await c.env.DB.prepare(
    'INSERT OR REPLACE INTO playlist_members (shared_playlist_id, session_id, their_playlist_id, joined_at) VALUES (?, ?, ?, ?)',
  )
    .bind(shareId, sessionId, theirPlaylistId, Math.floor(Date.now() / 1000))
    .run();

  return c.json({ success: true, theirPlaylistId });
});

// ── Sync endpoint: copy items from source to member playlists ────────

app.post('/api/share/:id/sync', async (c) => {
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

  // Get the owner's session to read the source playlist
  const ownerSession = await c.env.DB.prepare('SELECT * FROM sessions WHERE id = ?')
    .bind(shared.owner_session_id)
    .first();
  if (!ownerSession) {
    return c.json({ error: 'Owner session expired' }, 400);
  }

  const ownerToken = await refreshAccessToken(
    c.env.DB,
    ownerSession as Record<string, unknown>,
    c.env.TIDAL_CLIENT_ID,
    c.env.TIDAL_CLIENT_SECRET,
  );

  // Get source playlist items
  const itemsResp = await fetch(
    `${c.env.TIDAL_API_BASE}/playlists/${shared.tidal_playlist_id}/relationships/items?include=items`,
    {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        Accept: 'application/vnd.api+json',
      },
    },
  );

  if (!itemsResp.ok) {
    return c.json({ error: 'Failed to fetch source playlist items' }, 500);
  }

  const itemsData = (await itemsResp.json()) as {
    data: Array<{ id: string; type: string }>;
  };
  const items = itemsData.data || [];

  // Sync to the requesting user's playlist copy
  const member = await c.env.DB.prepare(
    'SELECT * FROM playlist_members WHERE shared_playlist_id = ? AND session_id = ?',
  )
    .bind(shareId, sessionId)
    .first();

  if (!member?.their_playlist_id) {
    return c.json({ error: 'No playlist copy found. Join first.' }, 400);
  }

  const userToken = await refreshAccessToken(
    c.env.DB,
    session as Record<string, unknown>,
    c.env.TIDAL_CLIENT_ID,
    c.env.TIDAL_CLIENT_SECRET,
  );

  // Replace all items in the user's copy
  if (items.length > 0) {
    const syncResp = await fetch(
      `${c.env.TIDAL_API_BASE}/playlists/${member.their_playlist_id}/relationships/items`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${userToken}`,
          Accept: 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json',
        },
        body: JSON.stringify({
          data: items.map((item) => ({
            id: item.id,
            type: item.type,
          })),
        }),
      },
    );

    if (!syncResp.ok) {
      const err = await syncResp.text();
      return c.json({ error: 'Sync failed', details: err }, 500);
    }
  }

  return c.json({ success: true, itemCount: items.length });
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

export default app;
