// ── State ─────────────────────────────────────────────────────────────
let state = { loggedIn: false, userId: null };
let syncPollTimer = null;

const $ = (sel) => document.querySelector(sel);
const main = () => $('#main');
const nav = () => $('#nav');

// ── Router ───────────────────────────────────────────────────────────
function getRoute() {
  const hash = window.location.hash.slice(1) || '/';
  return hash;
}

function navigate(path) {
  window.location.hash = path;
}

window.addEventListener('hashchange', () => {
  // Clear any polling timer when navigating away
  if (syncPollTimer) {
    clearInterval(syncPollTimer);
    syncPollTimer = null;
  }
  render();
});

// ── API helpers ──────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const resp = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (resp.status === 401) {
    state.loggedIn = false;
    render();
    return null;
  }
  return resp.json();
}

function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// ── Init ─────────────────────────────────────────────────────────────
async function init() {
  const me = await api('/auth/me');
  if (me) {
    state.loggedIn = me.loggedIn;
    state.userId = me.userId;
  }
  render();
}

// ── Render ───────────────────────────────────────────────────────────
function render() {
  const route = getRoute();

  // Nav
  if (state.loggedIn) {
    nav().innerHTML = `<a href="/auth/logout" class="btn btn-danger btn-small">Logout</a>`;
  } else {
    nav().innerHTML = '';
  }

  // Route matching
  if (route.startsWith('/join/')) {
    const shareId = route.split('/join/')[1];
    renderJoin(shareId);
  } else if (route.startsWith('/playlist/')) {
    const playlistId = route.split('/playlist/')[1];
    renderPlaylistDetail(playlistId);
  } else if (route.startsWith('/shared/')) {
    const shareId = route.split('/shared/')[1];
    renderSharedDetail(shareId);
  } else {
    renderHome();
  }
}

// ── Home ─────────────────────────────────────────────────────────────
async function renderHome() {
  if (!state.loggedIn) {
    main().innerHTML = `
      <div class="empty-state">
        <h2>Tidal Collaborative Playlists</h2>
        <p>Share and sync playlists with friends on Tidal</p>
        <a href="/auth/login" class="btn btn-primary">Login with Tidal</a>
      </div>
    `;
    return;
  }

  main().innerHTML = '<div class="loading">Loading your playlists...</div>';

  // Load playlists and shares in parallel
  const [playlistData, sharesData] = await Promise.all([
    api('/api/tidal/userCollectionPlaylists/me/relationships/items?include=items&countryCode=US'),
    api('/api/my-shares'),
  ]);

  let html = '';

  // Shared playlists section
  if (sharesData?.shares?.length > 0 || sharesData?.memberships?.length > 0) {
    html += '<div class="section-title">Collaborative Playlists</div>';

    for (const share of (sharesData.shares || [])) {
      html += `
        <div class="card" onclick="navigate('/shared/${share.id}')">
          <h3>${escHtml(share.name || 'Untitled')} <span class="badge">Owner</span></h3>
          <p>Playlist ID: ${share.tidal_playlist_id}</p>
        </div>
      `;
    }

    for (const mem of (sharesData.memberships || [])) {
      html += `
        <div class="card" onclick="navigate('/shared/${mem.shared_playlist_id}')">
          <h3>${escHtml(mem.name || 'Untitled')} <span class="badge">Member</span></h3>
          <p>Your copy: ${mem.their_playlist_id || 'pending'}</p>
        </div>
      `;
    }
  }

  // Tidal playlists section
  html += '<div class="section-title">Your Tidal Playlists</div>';

  if (playlistData?.included) {
    const playlists = playlistData.included.filter((r) => r.type === 'playlists');
    if (playlists.length === 0) {
      html += '<p style="color: var(--text-dim); padding: 12px 0;">No playlists found.</p>';
    }
    for (const pl of playlists) {
      const attrs = pl.attributes || {};
      html += `
        <div class="card" onclick="navigate('/playlist/${pl.id}')">
          <h3>${escHtml(attrs.name || 'Untitled')}</h3>
          <p>${attrs.numberOfItems || 0} tracks${attrs.description ? ' · ' + escHtml(attrs.description) : ''}</p>
        </div>
      `;
    }
  } else if (playlistData?.data) {
    // Fallback: items are in data array as relationships
    const items = playlistData.data;
    if (items.length === 0) {
      html += '<p style="color: var(--text-dim); padding: 12px 0;">No playlists found.</p>';
    }
    for (const item of items) {
      html += `
        <div class="card" onclick="navigate('/playlist/${item.id}')">
          <h3>Playlist</h3>
          <p>ID: ${item.id}</p>
        </div>
      `;
    }
  } else {
    html += '<p style="color: var(--text-dim); padding: 12px 0;">Could not load playlists. The API may require a different country code.</p>';
  }

  main().innerHTML = html;
}

// ── Playlist Detail ──────────────────────────────────────────────────
async function renderPlaylistDetail(playlistId) {
  main().innerHTML = '<div class="loading">Loading playlist...</div>';

  const [plData, itemsData] = await Promise.all([
    api(`/api/tidal/playlists/${playlistId}?countryCode=US`),
    api(`/api/tidal/playlists/${playlistId}/relationships/items?include=items&countryCode=US`),
  ]);

  const attrs = plData?.data?.attributes || {};
  const included = itemsData?.included || [];
  const orderedIds = (itemsData?.data || []).map((item) => `${item.type}:${item.id}`);
  const resourceMap = {};
  for (const res of included) {
    resourceMap[`${res.type}:${res.id}`] = res;
  }
  let items;
  if (orderedIds.length > 0) {
    items = orderedIds.map((key) => resourceMap[key]).filter(Boolean);
  } else {
    items = included.filter((r) => r.type === 'tracks' || r.type === 'videos');
  }

  let html = `
    <button class="back-btn" onclick="navigate('/')">&larr; Back</button>
    <h2>
      <a href="https://tidal.com/browse/playlist/${playlistId}" target="_blank" style="color: var(--text); text-decoration: none;">
        ${escHtml(attrs.name || 'Playlist')}
      </a>
    </h2>
    <p style="color: var(--text-dim); margin-bottom: 16px;">
      ${attrs.numberOfItems || items.length || 0} tracks
      ${attrs.description ? ' · ' + escHtml(attrs.description) : ''}
    </p>
    <div class="card-actions" style="margin-bottom: 16px;">
      <a href="https://tidal.com/browse/playlist/${playlistId}" target="_blank" class="btn btn-secondary btn-small" style="text-decoration: none;">Open in Tidal</a>
      <button class="btn btn-primary btn-small" onclick="sharePlaylist('${playlistId}', '${escAttr(attrs.name || 'Playlist')}')">
        Share for Collaboration
      </button>
    </div>
  `;

  if (items.length > 0) {
    html += '<ul class="track-list">';
    items.forEach((item, i) => {
      const ta = item.attributes || {};
      const isTrack = item.type === 'tracks';
      const tidalUrl = `https://tidal.com/browse/${isTrack ? 'track' : 'video'}/${item.id}`;
      const version = ta.version ? ` (${ta.version})` : '';
      const duration = ta.duration ? formatDuration(ta.duration) : '';

      let artistNames = '';
      const artistRels = item.relationships?.artists?.data;
      if (artistRels) {
        const names = artistRels.map((a) => {
          const artist = resourceMap[`artists:${a.id}`];
          return artist?.attributes?.name || '';
        }).filter(Boolean);
        artistNames = names.join(', ');
      }

      html += `
        <li>
          <a href="${tidalUrl}" target="_blank" style="display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit; flex: 1;">
            <span class="track-num">${i + 1}</span>
            <div class="track-info">
              <div>${escHtml(ta.title || 'Unknown')}${escHtml(version)}</div>
              ${artistNames ? `<div class="track-artist">${escHtml(artistNames)}</div>` : ''}
            </div>
            ${duration ? `<span style="color: var(--text-dim); font-size: 0.8rem; flex-shrink: 0;">${duration}</span>` : ''}
          </a>
        </li>
      `;
    });
    html += '</ul>';
  } else {
    html += '<p style="color: var(--text-dim);">No tracks in this playlist.</p>';
  }

  main().innerHTML = html;
}

// ── Share a playlist ─────────────────────────────────────────────────
async function sharePlaylist(playlistId, name) {
  const result = await api('/api/share', {
    method: 'POST',
    body: JSON.stringify({ playlistId, name }),
  });

  if (result?.shareUrl) {
    toast('Share link created!');
    navigate(`/shared/${result.shareId}`);
  } else {
    toast('Failed to create share link');
  }
}
// Expose to onclick
window.sharePlaylist = sharePlaylist;

// ── Shared Detail ────────────────────────────────────────────────────
async function renderSharedDetail(shareId) {
  main().innerHTML = '<div class="loading">Loading shared playlist...</div>';

  const data = await api(`/api/share/${shareId}`);
  if (!data?.shared) {
    main().innerHTML = `
      <button class="back-btn" onclick="navigate('/')">&larr; Back</button>
      <div class="empty-state"><h2>Not found</h2><p>This shared playlist doesn't exist.</p></div>
    `;
    return;
  }

  // Fetch the playlist items in parallel with the share data render
  const tidalPlaylistId = data.shared.tidal_playlist_id;
  const shareUrl = `${window.location.origin}/#/join/${shareId}`;
  const members = data.members || [];

  let html = `
    <button class="back-btn" onclick="navigate('/')">&larr; Back</button>
    <h2>
      <a href="https://tidal.com/browse/playlist/${tidalPlaylistId}" target="_blank" style="color: var(--text); text-decoration: none;">
        ${escHtml(data.shared.name || 'Shared Playlist')}
      </a>
    </h2>
    <p style="color: var(--text-dim); margin-bottom: 16px;">
      <a href="https://tidal.com/browse/playlist/${tidalPlaylistId}" target="_blank" class="btn btn-secondary btn-small" style="text-decoration: none;">
        Open in Tidal
      </a>
    </p>

    <div class="section-title">Share Link</div>
    <div class="share-link">
      <input type="text" value="${escAttr(shareUrl)}" readonly id="share-url">
      <button class="btn btn-secondary btn-small" onclick="copyShareLink()">Copy</button>
    </div>

    <div class="section-title">Members (${members.length})</div>
  `;

  if (members.length === 0) {
    html += '<p style="color: var(--text-dim); padding: 8px 0;">No one has joined yet. Share the link above!</p>';
  } else {
    for (const m of members) {
      html += `
        <div class="card" style="cursor: default;">
          <h3>User ${m.tidal_user_id || 'Unknown'}</h3>
          <p>Their playlist copy: ${m.their_playlist_id || 'pending'}</p>
        </div>
      `;
    }
  }

  html += `
    <div style="margin-top: 16px; display: flex; align-items: center; gap: 12px;">
      <button class="btn btn-primary" onclick="syncPlaylist('${shareId}')">Sync Now</button>
      <span id="auto-sync-status" style="color: var(--text-dim); font-size: 0.8rem;">Auto-sync every 3 min</span>
    </div>
    <div id="last-sync" style="color: var(--text-dim); font-size: 0.8rem; margin-top: 8px;"></div>
    <div class="section-title">Tracks</div>
    <div id="track-list"><div class="loading">Loading tracks...</div></div>

    <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--surface2);">
      <button class="btn btn-danger btn-small" onclick="deleteShare('${shareId}')">Delete Shared Playlist</button>
    </div>
  `;

  main().innerHTML = html;

  // Load tracks
  loadSharedPlaylistTracks(tidalPlaylistId);

  // Start auto-polling every 3 minutes while viewing this page
  if (syncPollTimer) clearInterval(syncPollTimer);
  updateSyncTimestamp();
  syncPollTimer = setInterval(async () => {
    const statusEl = $('#auto-sync-status');
    if (statusEl) statusEl.textContent = 'Syncing...';
    const result = await api(`/api/share/${shareId}/sync`, { method: 'POST' });
    if (statusEl) {
      if (result?.success) {
        statusEl.textContent = `Auto-synced ${result.itemCount} items`;
      } else {
        statusEl.textContent = 'Auto-sync: ' + (result?.error || 'failed');
      }
    }
    updateSyncTimestamp();
  }, 3 * 60 * 1000);
}

async function loadSharedPlaylistTracks(tidalPlaylistId) {
  const container = $('#track-list');
  if (!container) return;

  const itemsData = await api(`/api/tidal/playlists/${tidalPlaylistId}/relationships/items?include=items&countryCode=US`);

  if (!itemsData) {
    container.innerHTML = '<p style="color: var(--text-dim);">Could not load tracks.</p>';
    return;
  }

  // included contains the full track/video objects with attributes
  const included = itemsData.included || [];
  // data contains the relationship items in playlist order
  const orderedIds = (itemsData.data || []).map((item) => `${item.type}:${item.id}`);

  // Build a lookup map from included resources
  const resourceMap = {};
  for (const res of included) {
    resourceMap[`${res.type}:${res.id}`] = res;
  }

  // Get items in playlist order, falling back to included order
  let items;
  if (orderedIds.length > 0) {
    items = orderedIds.map((key) => resourceMap[key]).filter(Boolean);
  } else {
    items = included.filter((r) => r.type === 'tracks' || r.type === 'videos');
  }

  if (items.length === 0) {
    container.innerHTML = '<p style="color: var(--text-dim);">No tracks yet.</p>';
    return;
  }

  let html = '<ul class="track-list">';
  items.forEach((item, i) => {
    const attrs = item.attributes || {};
    const title = attrs.title || 'Unknown';
    const version = attrs.version ? ` (${attrs.version})` : '';
    const isTrack = item.type === 'tracks';
    const tidalUrl = `https://tidal.com/browse/${isTrack ? 'track' : 'video'}/${item.id}`;
    const duration = attrs.duration ? formatDuration(attrs.duration) : '';

    // Get artist names from relationships if available
    let artistNames = '';
    const artistRels = item.relationships?.artists?.data;
    if (artistRels) {
      const names = artistRels.map((a) => {
        const artist = resourceMap[`artists:${a.id}`];
        return artist?.attributes?.name || '';
      }).filter(Boolean);
      artistNames = names.join(', ');
    }

    html += `
      <li>
        <a href="${tidalUrl}" target="_blank" style="display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit; flex: 1;">
          <span class="track-num">${i + 1}</span>
          <div class="track-info">
            <div>${escHtml(title)}${escHtml(version)}</div>
            ${artistNames ? `<div class="track-artist">${escHtml(artistNames)}</div>` : ''}
          </div>
          ${duration ? `<span style="color: var(--text-dim); font-size: 0.8rem; flex-shrink: 0;">${duration}</span>` : ''}
        </a>
      </li>
    `;
  });
  html += '</ul>';

  container.innerHTML = html;
}

function formatDuration(iso) {
  // Parse ISO 8601 duration like PT2M58S or PT3H5M2S
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '';
  const h = parseInt(match[1] || '0');
  const m = parseInt(match[2] || '0');
  const s = parseInt(match[3] || '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateSyncTimestamp() {
  const el = $('#last-sync');
  if (el) el.textContent = `Last checked: ${new Date().toLocaleTimeString()}`;
}

function copyShareLink() {
  const input = $('#share-url');
  if (input) {
    navigator.clipboard.writeText(input.value).then(() => toast('Link copied!'));
  }
}
window.copyShareLink = copyShareLink;

async function syncPlaylist(shareId) {
  toast('Syncing...');
  const result = await api(`/api/share/${shareId}/sync`, { method: 'POST' });
  if (result?.success) {
    toast(`Synced ${result.itemCount} items!`);
  } else {
    toast(result?.error || 'Sync failed');
  }
}
window.syncPlaylist = syncPlaylist;

async function deleteShare(shareId) {
  if (!confirm('Delete this shared playlist? Members will keep their copies but syncing will stop.')) return;
  const result = await api(`/api/share/${shareId}`, { method: 'DELETE' });
  if (result?.success) {
    toast('Shared playlist deleted');
    navigate('/');
  } else {
    toast(result?.error || 'Failed to delete');
  }
}
window.deleteShare = deleteShare;

// ── Join ─────────────────────────────────────────────────────────────
async function renderJoin(shareId) {
  if (!state.loggedIn) {
    main().innerHTML = `
      <div class="join-hero">
        <h2>You've been invited!</h2>
        <p>Someone wants to share a Tidal playlist with you. Log in to join.</p>
        <a href="/auth/login?redirect=${encodeURIComponent('/#/join/' + shareId)}" class="btn btn-primary">
          Login with Tidal to Join
        </a>
      </div>
    `;
    return;
  }

  main().innerHTML = '<div class="loading">Joining playlist...</div>';

  const data = await api(`/api/share/${shareId}`);
  if (!data?.shared) {
    main().innerHTML = `
      <div class="empty-state">
        <h2>Not found</h2>
        <p>This shared playlist doesn't exist or has been removed.</p>
        <button class="btn btn-secondary" onclick="navigate('/')">Go Home</button>
      </div>
    `;
    return;
  }

  main().innerHTML = `
    <div class="join-hero">
      <h2>${escHtml(data.shared.name || 'Shared Playlist')}</h2>
      <p>Join this collaborative playlist to get a synced copy in your Tidal library.</p>
      <button class="btn btn-primary" onclick="doJoin('${shareId}')">Join & Create Copy</button>
      <br><br>
      <button class="btn btn-secondary" onclick="navigate('/')">Cancel</button>
    </div>
  `;
}

async function doJoin(shareId) {
  main().innerHTML = '<div class="loading">Creating your copy...</div>';
  const result = await api(`/api/share/${shareId}/join`, { method: 'POST' });
  if (result?.success) {
    toast('Joined! A copy has been created in your Tidal library.');
    navigate(`/shared/${shareId}`);
  } else {
    toast(result?.error || 'Failed to join');
    navigate('/');
  }
}
window.doJoin = doJoin;

// ── Helpers ──────────────────────────────────────────────────────────
function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── PWA ──────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── Boot ─────────────────────────────────────────────────────────────
init();
