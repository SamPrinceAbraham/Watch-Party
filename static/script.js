/* =============================================
   PartyHub – Multi-Mode Client Script
   =============================================
   Modes: watch (YouTube) | listen (Spotify) | read (Book/Manga)
   ============================================= */

// ---- Global State ----
const socket = io();
let roomId = null;
let username = null;
let roomMode = 'watch';
let isHost = false;

// YouTube
let ytPlayer = null;
let ytReady = false;
let ytSyncing = false;   // guard flag

// Spotify
let spotifyController = null;
let spSyncing = false;

// Read
let pages = [];
let currentPage = 0;

// Local
let localPlayer = null;
let localSyncing = false;

// =============================================
//  HELPERS
// =============================================

function getParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

function getInitials(name) {
  return (name || '?').slice(0, 2).toUpperCase();
}

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.style.borderColor = '#ef4444'; el.style.boxShadow = '0 0 0 3px rgba(239,68,68,0.18)'; }
  const hint = document.getElementById(id + 'Error');
  if (hint) hint.textContent = msg;
  setTimeout(() => {
    if (el) { el.style.borderColor = ''; el.style.boxShadow = ''; }
    if (hint) hint.textContent = '';
  }, 3000);
}

// Apply mode class to <body> for CSS accent switching
function applyMode(mode) {
  document.body.classList.remove('mode-watch', 'mode-listen', 'mode-read', 'mode-local');
  document.body.classList.add('mode-' + mode);
}

// =============================================
//  CHAT
// =============================================

function appendChat({ username: user, text }) {
  const box = document.getElementById('chatBox');
  if (!box) return;
  const isSystem = user === 'System';
  const div = document.createElement('div');
  div.className = 'chat-message';
  div.innerHTML = `
    <div class="chat-avatar ${isSystem ? 'system-avatar' : ''}">${isSystem ? '🔔' : getInitials(user)}</div>
    <div>
      <div class="chat-username ${isSystem ? 'system' : ''}">${user}</div>
      <div class="chat-text">${text}</div>
    </div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function sendMessage() {
  const input = document.getElementById('messageInput');
  if (!input || !input.value.trim()) return;
  socket.emit('chat', { room: roomId, username, text: input.value.trim() });
  input.value = '';
}

// =============================================
//  REACTIONS
// =============================================

function sendReaction(emoji) {
  socket.emit('reaction', { room: roomId, emoji });
  spawnEmoji(emoji);
}

function spawnEmoji(emoji) {
  const overlay = document.getElementById('reactionOverlay');
  if (!overlay) return;
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;
  el.style.left = (12 + Math.random() * 60) + '%';
  overlay.appendChild(el);
  setTimeout(() => el.remove(), 2900);
}

// =============================================
//  YOUTUBE (Watch Mode)
// =============================================

function extractYoutubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// Called by YouTube IFrame API when ready
window.onYouTubeIframeAPIReady = function () {
  ytReady = true;
};

// Safety check: if API already loaded before this script
if (window.YT && window.YT.Player) {
  ytReady = true;
}

function createYtPlayer(videoId, startTime, isPlaying) {
  const placeholder = document.getElementById('ytPlaceholder');
  if (placeholder) placeholder.style.display = 'none';

  ytPlayer = new YT.Player('ytPlayer', {
    width: '100%', height: '100%',
    videoId: videoId,
    playerVars: {
      autoplay: isPlaying ? 1 : 0,
      controls: 1,
      modestbranding: 1,
      rel: 0,
      start: Math.floor(startTime || 0),
    },
    events: {
      onReady: (e) => {
        if (isPlaying) e.target.playVideo();
      },
      onStateChange: (e) => {
        if (ytSyncing) return;
        const t = e.target.getCurrentTime();
        if (e.data === YT.PlayerState.PLAYING) {
          socket.emit('yt_play', { room: roomId, time: t });
        } else if (e.data === YT.PlayerState.PAUSED) {
          socket.emit('yt_pause', { room: roomId, time: t });
        }
      },
    }
  });

  // Periodic time broadcast (drift correction)
  setInterval(() => {
    if (ytPlayer && typeof ytPlayer.getCurrentTime === 'function' && !ytSyncing) {
      socket.emit('yt_time_update', { room: roomId, time: ytPlayer.getCurrentTime() });
    }
  }, 4000);
}

function ytTogglePlay() {
  if (!ytPlayer || typeof ytPlayer.getPlayerState !== 'function') return;
  const state = ytPlayer.getPlayerState();
  state === YT.PlayerState.PLAYING ? ytPlayer.pauseVideo() : ytPlayer.playVideo();
}

// =============================================
//  SPOTIFY (Listen Mode)
// =============================================

function spotifyUrlToUri(url) {
  // Convert https://open.spotify.com/track/ID → spotify:track:ID
  const m = url.match(/open\.spotify\.com\/(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/);
  return m ? `spotify:${m[1]}:${m[2]}` : url;
}

function initSpotifyEmbed(uri) {
  const placeholder = document.getElementById('spotifyPlaceholder');
  if (placeholder) placeholder.style.display = 'none';

  // Show play/pause buttons
  const pp = ['spPlayBtn', 'spPauseBtn'];
  pp.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'inline-flex'; });

  window.onSpotifyIframeApiReady = (IFrameAPI) => {
    const element = document.getElementById('spotify-embed');
    const options = { uri, height: '380' };
    IFrameAPI.createController(element, options, (controller) => {
      spotifyController = controller;

      controller.addListener('playback_update', (e) => {
        if (spSyncing) return;
        const { position, isPaused } = e.data;
        const posSec = position / 1000;
        if (!isPaused) {
          socket.emit('spotify_play', { room: roomId, pos: posSec });
        }
      });
    });
  };

  // If API already loaded, trigger manually
  if (window.SpotifyIframeApi) {
    window.onSpotifyIframeApiReady(window.SpotifyIframeApi);
  }
}

function spotifyPlay() {
  if (spotifyController) {
    spotifyController.play();
    socket.emit('spotify_play', { room: roomId, pos: 0 });
  }
}

function spotifyPause() {
  if (spotifyController) {
    spotifyController.pause();
    socket.emit('spotify_pause', { room: roomId, pos: 0 });
  }
}

// =============================================
//  READ MODE (Book / Manga)
// =============================================

function loadPages(pageArray, startPage) {
  pages = pageArray || [];
  currentPage = startPage || 0;

  const totalEl = document.getElementById('totalPages');
  const placeholder = document.getElementById('readPlaceholder');
  const img = document.getElementById('pageImage');

  if (!pages.length) return;

  if (placeholder) placeholder.style.display = 'none';
  if (totalEl) totalEl.textContent = pages.length;

  renderPage(currentPage);

  // Host-only controls
  if (isHost) {
    const hint = document.getElementById('hostOnlyHint');
    if (hint) hint.style.display = 'inline';
    enableNavButtons();
  }
}

function renderPage(idx) {
  const img = document.getElementById('pageImage');
  const curr = document.getElementById('currentPage');
  if (!img || !pages.length) return;

  img.style.display = 'block';
  img.src = pages[idx];
  if (curr) curr.textContent = idx + 1;

  // Update nav button states (host only)
  const prev = document.getElementById('prevBtn');
  const next = document.getElementById('nextBtn');
  if (prev) prev.disabled = idx === 0;
  if (next) next.disabled = idx === pages.length - 1;
}

function enableNavButtons() {
  const prev = document.getElementById('prevBtn');
  const next = document.getElementById('nextBtn');
  if (prev) prev.disabled = currentPage === 0;
  if (next) next.disabled = !pages.length || currentPage === pages.length - 1;
}

function changePage(delta) {
  if (!isHost) return;
  const newPage = currentPage + delta;
  if (newPage < 0 || newPage >= pages.length) return;
  currentPage = newPage;
  renderPage(currentPage);
  socket.emit('page_change', { room: roomId, page: currentPage });
}

// =============================================
//  LOCAL VIDEO (Local Mode)
// =============================================

function setupLocalVideo() {
  localPlayer = document.getElementById('localPlayer');
  if (!localPlayer) return;

  // For host, keep controls. For viewers, turn them off to block desync
  if (isHost) {
    localPlayer.setAttribute('controls', 'true');
    localPlayer.style.pointerEvents = 'auto';
  } else {
    localPlayer.removeAttribute('controls');
    localPlayer.style.pointerEvents = 'none';
  }

  // Host event listeners
  localPlayer.onplay = () => {
    if (localSyncing || !isHost) return;
    socket.emit('local_play', { room: roomId, time: localPlayer.currentTime });
  };
  localPlayer.onpause = () => {
    if (localSyncing || !isHost) return;
    socket.emit('local_pause', { room: roomId, time: localPlayer.currentTime });
  };
  localPlayer.onseeked = () => {
    if (localSyncing || !isHost) return;
    socket.emit('local_seek', { room: roomId, time: localPlayer.currentTime });
  };

  // Drift correction loop
  setInterval(() => {
    if (localPlayer && !localSyncing && localPlayer.src) {
      socket.emit('local_time_update', { room: roomId, time: localPlayer.currentTime });
    }
  }, 4000);
}

function loadLocalVideo(path, time, playing) {
  const placeholder = document.getElementById('localPlaceholder');
  if (placeholder) placeholder.style.display = 'none';

  if (!localPlayer) setupLocalVideo();

  localPlayer.src = `/video/${roomId}`;
  localPlayer.style.display = 'block';
  localPlayer.currentTime = time || 0;

  if (playing) {
    const p = localPlayer.play();
    if (p !== undefined) p.catch(e => console.log('Autoplay blocked:', e));
  }
}

// =============================================
//  SOCKET EVENTS
// =============================================

socket.on('connect', () => {
  console.log('Connected');
  if (roomId && username) emitJoin();
});

socket.on('room_state', (state) => {
  roomMode = state.mode;
  isHost = state.is_host;
  applyMode(roomMode);
  showPanel(roomMode);
  updateModePill(roomMode);

  if (isHost) {
    const badge = document.getElementById('hostBadge');
    if (badge) badge.style.display = 'inline';
    const changeBtn = document.getElementById('changeContentBtn');
    if (changeBtn) changeBtn.style.display = 'inline-flex';
    appendChat({ username: 'System', text: '👑 You are the host — you control the room' });
  }

  // Watch (YouTube)
  if (roomMode === 'watch' && state.yt_url) {
    const videoId = extractYoutubeId(state.yt_url);
    if (videoId) {
      if (ytReady) {
        createYtPlayer(videoId, state.yt_time, state.yt_playing);
      } else {
        const interval = setInterval(() => {
          if (ytReady) {
            clearInterval(interval);
            createYtPlayer(videoId, state.yt_time, state.yt_playing);
          }
        }, 200);
      }
    }
  }

  // Listen (Spotify)
  if (roomMode === 'listen' && state.spotify_uri) {
    initSpotifyEmbed(state.spotify_uri);
  }

  // Read
  if (roomMode === 'read' && state.pages && state.pages.length) {
    loadPages(state.pages, state.current_page);
  }

  // Local
  if (roomMode === 'local' && state.local_path) {
    loadLocalVideo(state.local_path, state.local_time, state.local_playing);
  }
});

socket.on('viewer_count', (count) => {
  const el = document.getElementById('viewerCount');
  if (el) el.textContent = count + ' watching';
});

socket.on('chat', appendChat);

socket.on('reaction', ({ emoji }) => spawnEmoji(emoji));

socket.on('host_changed', () => {
  isHost = true;
  const badge = document.getElementById('hostBadge');
  if (badge) badge.style.display = 'inline';
  const changeBtn = document.getElementById('changeContentBtn');
  if (changeBtn) changeBtn.style.display = 'inline-flex';
  if (roomMode === 'read') enableNavButtons();
  if (roomMode === 'local' && localPlayer) {
    localPlayer.setAttribute('controls', 'true');
    localPlayer.style.pointerEvents = 'auto';
  }
  showToast('👑 You are now the host');
  appendChat({ username: 'System', text: '👑 You are now the host' });
});

// YouTube sync events
socket.on('yt_play', (time) => {
  if (!ytPlayer || typeof ytPlayer.seekTo !== 'function') return;
  ytSyncing = true;
  ytPlayer.seekTo(time, true);
  ytPlayer.playVideo();
  setTimeout(() => { ytSyncing = false; }, 600);
});

socket.on('yt_pause', (time) => {
  if (!ytPlayer || typeof ytPlayer.seekTo !== 'function') return;
  ytSyncing = true;
  ytPlayer.seekTo(time, true);
  ytPlayer.pauseVideo();
  setTimeout(() => { ytSyncing = false; }, 600);
});

socket.on('yt_seek', (time) => {
  if (!ytPlayer || typeof ytPlayer.seekTo !== 'function') return;
  ytSyncing = true;
  ytPlayer.seekTo(time, true);
  setTimeout(() => { ytSyncing = false; }, 600);
});

socket.on('yt_resync', (serverTime) => {
  if (!ytPlayer || typeof ytPlayer.seekTo !== 'function') return;
  ytSyncing = true;
  ytPlayer.seekTo(serverTime, true);
  setTimeout(() => { ytSyncing = false; }, 600);
});

// Spotify sync events
socket.on('spotify_play', (pos) => {
  if (!spotifyController) return;
  spSyncing = true;
  spotifyController.seek(pos);
  spotifyController.play();
  setTimeout(() => { spSyncing = false; }, 600);
});

socket.on('spotify_pause', () => {
  if (!spotifyController) return;
  spSyncing = true;
  spotifyController.pause();
  setTimeout(() => { spSyncing = false; }, 600);
});

socket.on('spotify_seek', (pos) => {
  if (!spotifyController) return;
  spSyncing = true;
  spotifyController.seek(pos);
  setTimeout(() => { spSyncing = false; }, 600);
});

// Read mode sync
socket.on('page_change', (page) => {
  currentPage = page;
  renderPage(currentPage);
});

// Local mode sync
socket.on('local_play', (time) => {
  if (!localPlayer) return;
  localSyncing = true;
  localPlayer.currentTime = time;
  const p = localPlayer.play();
  if (p !== undefined) p.catch(e => console.log('Play blocked', e));
  setTimeout(() => { localSyncing = false; }, 600);
});

socket.on('local_pause', (time) => {
  if (!localPlayer) return;
  localSyncing = true;
  localPlayer.currentTime = time;
  localPlayer.pause();
  setTimeout(() => { localSyncing = false; }, 600);
});

socket.on('local_seek', (time) => {
  if (!localPlayer) return;
  localSyncing = true;
  localPlayer.currentTime = time;
  setTimeout(() => { localSyncing = false; }, 600);
});

socket.on('local_resync', (serverTime) => {
  if (!localPlayer) return;
  localSyncing = true;
  localPlayer.currentTime = serverTime;
  setTimeout(() => { localSyncing = false; }, 600);
});

// Content updated (host changed video/song/book)
socket.on('content_updated', (data) => {
  showToast('🔄 Content updated by host');
  if (roomMode === 'watch' && data.yt_url) {
    const videoId = extractYoutubeId(data.yt_url);
    if (videoId) {
      if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
        ytPlayer.loadVideoById(videoId, 0);
      } else {
        createYtPlayer(videoId, 0, false);
      }
    }
  } else if (roomMode === 'listen' && data.spotify_uri) {
    // Re-init spotify embed (safest way to change content)
    const container = document.getElementById('spotify-embed');
    if (container) container.innerHTML = '';
    initSpotifyEmbed(data.spotify_uri);
  } else if (roomMode === 'read' && data.pages) {
    loadPages(data.pages, 0);
  } else if (roomMode === 'local' && data.local_path) {
    loadLocalVideo(data.local_path, 0, false);
  }
});

// =============================================
//  ROOM INIT
// =============================================

function emitJoin() {
  socket.emit('join', {
    room: roomId,
    user: username,
    mode: getParam('mode') || 'watch',
    ytUrl: getParam('ytUrl') || '',
    spotifyUri: getParam('spotifyUri') || '',
    pages: getParam('pages') ? JSON.parse(getParam('pages')) : [],
    localPath: getParam('localPath') || '',
  });
}

function initRoom() {
  roomId = getParam('id');
  if (!roomId) { window.location.href = '/'; return; }

  // Show room ID & name in topbar
  const idBadge = document.getElementById('roomIdBadge');
  if (idBadge) idBadge.textContent = roomId;
  const titleEl = document.getElementById('roomTitle');
  const name = getParam('name');
  if (titleEl && name) titleEl.textContent = decodeURIComponent(name);

  // Apply mode from URL
  const mode = getParam('mode') || 'watch';
  applyMode(mode);
  updateModePill(mode);

  // Show username modal
  const modal = document.getElementById('usernameModal');
  if (modal) modal.classList.remove('hidden');
}

function confirmUsername() {
  const input = document.getElementById('usernameInput');
  if (!input || !input.value.trim()) { input.focus(); return; }
  username = input.value.trim();
  document.getElementById('usernameModal').classList.add('hidden');
  emitJoin();
}

// =============================================
//  PANEL SWITCHING
// =============================================

function showPanel(mode) {
  ['watchPanel', 'listenPanel', 'readPanel', 'localPanel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const targets = { watch: 'watchPanel', listen: 'listenPanel', read: 'readPanel', local: 'localPanel' };
  const el = document.getElementById(targets[mode]);
  if (el) el.style.display = 'flex';
}

function updateModePill(mode) {
  const pill = document.getElementById('modePill');
  if (!pill) return;
  const labels = { watch: '🎬 Watch', listen: '🎵 Listen', read: '📚 Read', local: '🎥 Local' };
  pill.textContent = labels[mode] || mode;
  pill.className = 'mode-pill ' + mode;
}

// =============================================
//  CREATE ROOM PAGE
// =============================================

function switchMode(mode) {
  ['watch', 'listen', 'read', 'local'].forEach(m => {
    const tab = document.getElementById('tab' + m.charAt(0).toUpperCase() + m.slice(1));
    if (tab) tab.className = 'mode-tab ' + m + (m === mode ? ' active' : '');
    const fields = document.getElementById(m + 'Fields');
    if (fields) fields.style.display = m === mode ? 'block' : 'none';
  });
  document.getElementById('selectedMode').value = mode;
  applyMode(mode);
}

function createRoom() {
  const roomName = document.getElementById('roomName')?.value.trim();
  const mode = document.getElementById('selectedMode')?.value || 'watch';

  if (!roomName) { showError('roomName', 'Please enter a room name'); return; }

  const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
  const params = new URLSearchParams({ id: roomId, name: roomName, mode });

  if (mode === 'watch') {
    const ytUrl = document.getElementById('ytUrl')?.value.trim();
    if (ytUrl) params.set('ytUrl', ytUrl);
  } else if (mode === 'listen') {
    const spotifyUrl = document.getElementById('spotifyUrl')?.value.trim();
    if (spotifyUrl) {
      const uri = spotifyUrlToUri(spotifyUrl);
      params.set('spotifyUri', uri);
    }
  } else if (mode === 'read') {
    const raw = document.getElementById('pageUrls')?.value.trim();
    if (raw) {
      const pages = raw.split('\n').map(l => l.trim()).filter(Boolean);
      params.set('pages', JSON.stringify(pages));
    }
  } else if (mode === 'local') {
    const localPath = document.getElementById('localPath')?.value.trim();
    if (localPath) params.set('localPath', localPath);
  }

  window.location.href = '/room?' + params.toString();
}

// =============================================
//  JOIN EXISTING ROOM (landing page)
// =============================================

async function joinExistingRoom() {
  const input = document.getElementById('joinRoomId');
  if (!input) return;
  const id = input.value.trim().toUpperCase();
  if (!id) { input.focus(); return; }

  const btn = document.getElementById('joinBtn');
  if (btn) { btn.textContent = 'Checking…'; btn.disabled = true; }

  try {
    const resp = await fetch(`/api/room/${id}`);
    if (resp.ok) {
      const data = await resp.json();
      window.location.href = `/room?id=${id}&mode=${data.mode}`;
    } else {
      showError('joinRoomId', '⚠ Room not found — check the ID and try again');
      if (btn) { btn.textContent = 'Join →'; btn.disabled = false; }
    }
  } catch {
    showError('joinRoomId', 'Connection error — try again');
    if (btn) { btn.textContent = 'Join →'; btn.disabled = false; }
  }
}

// =============================================
//  CHANGE CONTENT (Room Page)
// =============================================

function openChangeContentModal() {
  if (!isHost) return;
  const modal = document.getElementById('changeContentModal');
  if (!modal) return;

  // Show correct fields
  ['modalWatch', 'modalListen', 'modalRead', 'modalLocal'].forEach(m => {
    const el = document.getElementById(m + 'Fields');
    if (el) el.style.display = 'none';
  });

  const target = roomMode.charAt(0).toUpperCase() + roomMode.slice(1);
  const fields = document.getElementById('modal' + target + 'Fields');
  if (fields) fields.style.display = 'block';

  modal.classList.remove('hidden');
}

function closeChangeContentModal() {
  const modal = document.getElementById('changeContentModal');
  if (modal) modal.classList.add('hidden');
}

function updateContent() {
  if (!isHost) return;
  const data = { room: roomId };

  if (roomMode === 'watch') {
    const url = document.getElementById('newYtUrl')?.value.trim();
    if (!url) return;
    data.ytUrl = url;
  } else if (roomMode === 'listen') {
    const url = document.getElementById('newSpotifyUrl')?.value.trim();
    if (!url) return;
    data.spotifyUri = spotifyUrlToUri(url);
  } else if (roomMode === 'read') {
    const raw = document.getElementById('newPageUrls')?.value.trim();
    if (!raw) return;
    data.pages = raw.split('\n').map(l => l.trim()).filter(Boolean);
  } else if (roomMode === 'local') {
    const localPath = document.getElementById('newLocalPath')?.value.trim();
    if (!localPath) return;
    data.localPath = localPath;
  }

  socket.emit('set_content', data);
  closeChangeContentModal();
}

// =============================================
//  SHARE
// =============================================

function copyLink() {
  navigator.clipboard.writeText(window.location.href)
    .then(() => showToast('✓ Link copied!'))
    .catch(() => showToast('URL: ' + window.location.href));
}

// =============================================
//  KEYBOARD SHORTCUTS
// =============================================

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.activeElement.id === 'messageInput') sendMessage();
  if (e.key === 'Enter' && document.activeElement.id === 'usernameInput') confirmUsername();
  if (e.key === 'ArrowRight' && isHost && roomMode === 'read') changePage(1);
  if (e.key === 'ArrowLeft' && isHost && roomMode === 'read') changePage(-1);
  if (e.key === ' ' && roomMode === 'watch' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    ytTogglePlay();
  }
});
