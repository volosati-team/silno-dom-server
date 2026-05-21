// ── Server-side error/log uploader for old browsers (Chrome 72 etc.) ─────────
(function() {
  var queue = [];
  var flushing = false;
  function send(payload) {
    queue.push(payload);
    if (flushing) return;
    flushing = true;
    setTimeout(function() {
      var batch = queue.splice(0);
      flushing = false;
      try {
        fetch('/api/dbg-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ua: navigator.userAgent,
            url: location.href,
            ts: new Date().toISOString(),
            entries: batch
          })
        }).catch(function(){});
      } catch(e) {}
    }, 1000);
  }
  window.addEventListener('error', function(e) {
    send({ type: 'error', msg: (e.message || '') + '', src: e.filename || '', line: e.lineno, col: e.colno, stack: e.error && e.error.stack ? e.error.stack + '' : '' });
  });
  window.addEventListener('unhandledrejection', function(e) {
    send({ type: 'rejection', reason: (e.reason && e.reason.stack ? e.reason.stack : e.reason) + '' });
  });
  // Hook console.error and console.warn
  var origErr = console.error, origWarn = console.warn;
  console.error = function() {
    try { send({ type: 'console.error', args: Array.prototype.slice.call(arguments).map(String) }); } catch(e){}
    return origErr.apply(console, arguments);
  };
  console.warn = function() {
    try { send({ type: 'console.warn', args: Array.prototype.slice.call(arguments).map(String) }); } catch(e){}
    return origWarn.apply(console, arguments);
  };
})();

// ── Clock ─────────────────────────────────────────────────────────────────────
const D = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
const M = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
function tick() {
  const n = new Date();
  document.getElementById('header-clock').textContent =
    `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}  ${D[n.getDay()]} ${n.getDate()} ${M[n.getMonth()]}`;
}
tick(); setInterval(tick, 15000);

const zoneClip  = document.getElementById('zone-clip');
const zoneTrack = document.getElementById('zone-track');
const mediaClip = document.getElementById('media-clip');
const ZONES = ['yard', 'gallery', 'hall', 'workshop', 'basement'];
let activeZone  = null;

function setZoneSlide(zone) {
  const idx = ZONES.indexOf(zone);
  zoneTrack.style.transition = 'transform 0.32s cubic-bezier(0.32,0.72,0,1)';
  zoneTrack.style.transform  = `translateX(-${idx * 20}%)`;
}

function closeMediaPanel() {
  medOpen = false;
  mediaClip.classList.remove('open');
  document.getElementById('sc-expand-btn').classList.remove('open');
}
function openMediaPanel() {
  medOpen = true;
  closeZone();
  mediaClip.classList.add('open');
  document.getElementById('sc-expand-btn').classList.add('open');
  if (window.innerWidth <= 700) showSavedPanel();
}
function toggleMediaPanel() {
  if (medOpen) closeMediaPanel(); else openMediaPanel();
}
function showSavedPanel() {
  document.getElementById('saved-panel').classList.add('mob-open');
  var tab = document.getElementById('saved-tab');
  if (tab) { tab.style.left = '75%'; tab.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>'; }
}
function hideSavedPanel() {
  document.getElementById('saved-panel').classList.remove('mob-open');
  var tab = document.getElementById('saved-tab');
  if (tab) { tab.style.left = '0'; tab.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'; }
}
function toggleSavedPanel() {
  var panel = document.getElementById('saved-panel');
  if (panel.classList.contains('mob-open')) hideSavedPanel(); else showSavedPanel();
}

function closeZone() {
  activeZone = null;
  document.querySelectorAll('.ztab').forEach(t => t.classList.remove('active'));
  zoneClip.classList.remove('open');
}

// ── Zone tabs ─────────────────────────────────────────────────────────────────
document.getElementById('zone-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.ztab');
  if (!tab) return;
  const zone = tab.dataset.zone;

  if (activeZone === zone) {
    closeZone();
    return;
  }

  closeMediaPanel();
  document.querySelectorAll('.ztab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  activeZone = zone;
  setZoneSlide(zone);
  zoneClip.classList.add('open');
});

// ── Media tabs ────────────────────────────────────────────────────────────────
const YT_SRC = 'https://www.youtube.com/embed?listType=search&list=PLrEnWoR732-BHrPp_Pm8_VleD68f9s14-&enablejsapi=1';
const loaded  = [false, false, false, false, false];
const mtrack  = document.getElementById('media-track');
let curMed = 0, medOpen = false;

function loadMedia(i) {
  if (loaded[i]) return;
  loaded[i] = true;
  if (i === 0) {
    document.getElementById('yt-frame').src = YT_SRC;
  } else if (i === 1) {
    // no autoload — user enters URL or connects account
  }
}
function setMediaTab(idx) {
  if (idx !== 1 && scWidget) scWidget.pause();
  curMed = idx;
  mtrack.style.transition = 'transform 0.32s cubic-bezier(0.32,0.72,0,1)';
  mtrack.style.transform  = `translateX(${-idx * 100}%)`;
  loadMedia(idx);
  if (idx === 0) barSetYT();
  else if (idx === 1) barSetSC();
  else if (idx === 2) barSetSP();
}

// ── Device state management ───────────────────────────────────────────────────
const chState   = {};
const chPending = {};

function applySwitch(ch, val) {
  const btn = document.querySelector(`.ctrl-btn[data-ch="${ch}"]`);
  if (!btn || val === null) return;
  const chk = btn.querySelector('.tchk');
  if (chk) chk.checked = val;
}

function updateDot(ch, val) {
  const btn = document.querySelector(`.ctrl-btn[data-ch="${ch}"]`);
  if (!btn) return;
  const dot = btn.querySelector('.dev-dot');
  const lbl = btn.querySelector('.dev-lbl');
  if (dot) dot.className = 'dev-dot' + (val === true ? ' on' : val === false ? ' off' : '');
  if (lbl) lbl.textContent = val === true ? 'вкл' : val === false ? 'выкл' : '—';
}

async function moioSet(ch, val) {
  chPending[ch] = val;
  try {
    await fetch(`${location.protocol}//${location.hostname}:8080/set`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [ch]: val }) });
  } catch(e) {
    applySwitch(ch, chState[ch] ?? null);
    delete chPending[ch];
    return;
  }
  [500, 1000, 1500, 3000].forEach(ms => setTimeout(pollState, ms));
  setTimeout(() => {
    if (chPending[ch] !== undefined) {
      applySwitch(ch, chState[ch] ?? null);
      delete chPending[ch];
    }
  }, 3500);
}

async function pollState() {
  try {
    const r = await fetch(`${location.protocol}//${location.hostname}:8080/state`);
    if (!r.ok) return;
    const d = await r.json();
    for (const [key, val] of Object.entries(d)) {
      if (val === null) continue;
      chState[key] = val;
      updateDot(key, val);
      if (chPending[key] !== undefined) {
        if ((val === true) === chPending[key]) { delete chPending[key]; applySwitch(key, val); }
      } else {
        applySwitch(key, val);
      }
    }
  } catch(e) {}
}

// ── Control button interaction ────────────────────────────────────────────────
const CKEY = `sdom_c_${screen.width}x${screen.height}`;
const cstate = JSON.parse(localStorage.getItem(CKEY) || '{}');

function handleCtrl(chk) {
  const btn = chk.closest('.ctrl-btn');
  const ch  = btn.dataset.ch;
  const val = chk.checked;
  if (ch) {
    moioSet(ch, val);
  } else {
    const zone = btn.closest('.zone-page').id;
    const lbl  = btn.querySelector('.cl').textContent;
    cstate[`${zone}_${lbl}`] = val;
    localStorage.setItem(CKEY, JSON.stringify(cstate));
  }
}

function handleCtrlClick(e, btn) {
  const chk = btn.querySelector('.tchk');
  chk.checked = !chk.checked;
  handleCtrl(chk);
}

// Restore non-API ctrl states
document.querySelectorAll('.ctrl-btn[data-ch=""]').forEach(btn => {
  const zone = btn.closest('.zone-page').id;
  const lbl  = btn.querySelector('.cl').textContent;
  const chk  = btn.querySelector('.tchk');
  if (chk && cstate[`${zone}_${lbl}`]) chk.checked = true;
});

// ── Auth ──────────────────────────────────────────────────────────────────────
const ACCS = {
  '':         { pass: '',      name: 'Тест юзер' },
  'volosati': { pass: '12345', name: 'volosati'   },
  'max':      { pass: '12345', name: 'max'         },
  'polini':   { pass: '12345', name: 'polini'      },
};

function getUser() { try { return JSON.parse(sessionStorage.getItem('sdom_u')); } catch { return null; } }
function updateMenu() {
  const u = getUser();
  document.getElementById('menu-uname').textContent = u ? u.name : '';
  document.getElementById('menu-logged').classList.toggle('visible', !!u);
}
function doLogin() {
  const l = document.getElementById('login-in').value;
  const p = document.getElementById('pass-in').value;
  const a = ACCS[l];
  const err = document.getElementById('menu-err');
  if (!a || a.pass !== p) { err.textContent = 'Неверный логин или пароль'; return; }
  err.textContent = '';
  sessionStorage.setItem('sdom_u', JSON.stringify({ name: a.name }));
  document.getElementById('login-in').value = '';
  document.getElementById('pass-in').value  = '';
  updateMenu();
}
function doLogout() { sessionStorage.removeItem('sdom_u'); updateMenu(); }

document.getElementById('pass-in').addEventListener('keydown',  e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('login-in').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('pass-in').focus(); });

// ── Menu open/close ───────────────────────────────────────────────────────────
const menu = document.getElementById('menu'), overlay = document.getElementById('overlay');
const openMenu  = () => { menu.classList.add('open');    overlay.classList.add('show'); };
const closeMenu = () => { menu.classList.remove('open'); overlay.classList.remove('show'); };
document.getElementById('menu-btn').addEventListener('click', () => menu.classList.contains('open') ? closeMenu() : openMenu());
overlay.addEventListener('click', closeMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

// ── Init ──────────────────────────────────────────────────────────────────────
updateMenu();

// Default: open Двор (no transition on init)
const yardTab = document.querySelector('.ztab[data-zone="yard"]');
yardTab.classList.add('active');
activeZone = 'yard';
zoneTrack.style.transition = 'none';
zoneTrack.style.transform  = 'translateX(0%)';
zoneClip.classList.add('open');

pollState();
setInterval(pollState, 5000);

// ── SoundCloud ────────────────────────────────────────────────────────────────
const SC_REDIRECT = location.origin + '/';
let scWidget = null;
let scLikesOpen = false;

const scFrame      = document.getElementById('sc-frame');
const scLikesList  = document.getElementById('sc-likes-list');
const scLikesBtn   = document.getElementById('sc-likes-toggle');
const scConnectBtn = document.getElementById('sc-connect-btn');
const scAvatarEl   = document.getElementById('sc-avatar');
const scUsernameEl = document.getElementById('sc-username');

function scToken()    { return localStorage.getItem('sc_token'); }
function scClientId() { return localStorage.getItem('sc_client_id'); }

function scSetUI(connected, username, avatarUrl) {
  if (connected) {
    scConnectBtn.textContent = '✕';
    scConnectBtn.classList.add('connected');
    scUsernameEl.textContent = username || 'SC';
    if (avatarUrl) { scAvatarEl.src = avatarUrl; scAvatarEl.classList.add('show'); }
    scLikesBtn.classList.add('show');
  } else {
    scConnectBtn.textContent = 'Connect';
    scConnectBtn.classList.remove('connected');
    scUsernameEl.textContent = 'SoundCloud';
    scAvatarEl.classList.remove('show');
    scLikesBtn.classList.remove('show');
    scLikesBtn.classList.remove('on');
    scLikesList.classList.remove('show');
    scLikesList.innerHTML = '';
    scLikesOpen = false;
  }
}

async function scLoadLikes(token) {
  if (!token) return;
  try {
    const r = await fetch('https://api.soundcloud.com/me/likes/tracks?limit=30', {
      headers: { 'Authorization': `OAuth ${token}` }
    });
    if (!r.ok) return;
    const data = await r.json();
    const items = data.collection || data;
    scLikesList.innerHTML = '';
    items.forEach(item => {
      const track = item.track || item;
      if (!track || !track.permalink_url) return;
      const el = document.createElement('div');
      el.className = 'sc-like-item';
      const art = (track.artwork_url || '').replace('-large', '-t50x50');
      el.innerHTML = `<img class="sc-like-art" src="${art}" onerror="this.style.visibility='hidden'" alt="">
        <div class="sc-like-info">
          <div class="sc-like-title">${track.title || ''}</div>
          <div class="sc-like-artist">${(track.user || {}).username || ''}</div>
        </div>`;
      el.addEventListener('click', () => {
        scLoadInWidget(track.permalink_url);
        scToggleLikes();
      });
      scLikesList.appendChild(el);
    });
  } catch(e) {}
}

function scToggleLikes() {
  scLikesOpen = !scLikesOpen;
  scLikesList.classList.toggle('show', scLikesOpen);
  scLikesBtn.classList.toggle('on', scLikesOpen);
}

function scUpdateTrackInfo(sound) {
  if (!sound) return;
  document.getElementById('sc-track-title').textContent  = sound.title || '—';
  document.getElementById('sc-track-artist').textContent = (sound.user || {}).username || '';
  const art = sound.artwork_url || '';
  if (art) document.getElementById('sc-art').src = art.replace('-large', '-t50x50');
}

function scFmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

let scShuffleOn = false, scRepeatOn = false;
function scToggleShuffle() {
  scShuffleOn = !scShuffleOn;
  document.getElementById('sc-shuffle').classList.toggle('on', scShuffleOn);
  if (scWidget) scWidget.setShuffle(scShuffleOn);
}
function scSetVolume(val) { if (scWidget) scWidget.setVolume(parseInt(val)); }
document.getElementById('sc-vol').addEventListener('input', e => {
  if (activePlayer === 1) scSetVolume(e.target.value);
  else if (activePlayer === 0) ytCmd('setVolume', [parseInt(e.target.value)]);
});

function scToggleRepeat() {
  scRepeatOn = !scRepeatOn;
  document.getElementById('sc-repeat').classList.toggle('on', scRepeatOn);
  if (scWidget) scWidget.setRepeat(scRepeatOn);
}

function scBindWidget(frame) {
  if (!window.SC) return;
  scWidget = SC.Widget(frame);
  const pp   = document.getElementById('sc-playpause');
  const fill = document.getElementById('sc-prog-fill');
  const tCur = document.getElementById('sc-time-cur');
  const tDur = document.getElementById('sc-time-dur');
  scWidget.bind(SC.Widget.Events.READY, () => {
    scWidget.getCurrentSound(scUpdateTrackInfo);
    scWidget.getDuration(d => { tDur.textContent = scFmtTime(d); });
    if (scShuffleOn) scWidget.setShuffle(true);
    if (scRepeatOn)  scWidget.setRepeat(true);
  });
  scWidget.bind(SC.Widget.Events.PLAY, () => {
    scShowBar();
    pp.textContent = '⏸';
    scWidget.getCurrentSound(scUpdateTrackInfo);
    scWidget.getDuration(d => { tDur.textContent = scFmtTime(d); });
  });
  scWidget.bind(SC.Widget.Events.PAUSE, () => { pp.textContent = '▶'; });
  scWidget.bind(SC.Widget.Events.FINISH, () => {
    pp.textContent = '▶'; fill.style.width = '0%'; tCur.textContent = '0:00';
  });
  scWidget.bind(SC.Widget.Events.PLAY_PROGRESS, e => {
    fill.style.width = (e.relativePosition * 100) + '%';
    tCur.textContent = scFmtTime(e.currentPosition);
  });
}

const SC_UNSUPPORTED = /soundcloud\.com\/(discover|stream|you|likes|reposts|following|followers|groups|comments)\//;

function scShowBar() { /* bar always visible */ }
function scHideBar() { /* bar always visible */ }
function pauseYT() {
  try {
    document.getElementById('yt-frame').contentWindow.postMessage(
      '{"event":"command","func":"pauseVideo","args":""}', '*');
  } catch {}
}

async function scLoadInWidget(url, autoplay = true) {
  url = await resolveUrl(url);
  if (SC_UNSUPPORTED.test(url)) {
    const ph = document.getElementById('sc-placeholder');
    ph.classList.remove('hidden');
    document.getElementById('sc-ph-icon').textContent = '⚠';
    ph.querySelector('div:last-child').textContent = 'URL не поддерживается Widget. Используй профиль, трек или плейлист.';
    scFrame.src = 'about:blank';
    return;
  }
  const ph = document.getElementById('sc-placeholder');
  ph.classList.add('hidden');
  document.getElementById('sc-ph-icon').textContent = '☁';
  ph.querySelector('div:last-child').textContent = 'Вставь ссылку SC или подключи аккаунт';
  scShowBar();
  if (autoplay) pauseYT();
  if (autoplay) localStorage.setItem('sc_last_url', url);
  if (scWidget) {
    scWidget.load(url, { auto_play: autoplay, show_comments: false, show_reposts: false, show_teaser: false });
    return;
  }
  const enc = encodeURIComponent(url);
  scFrame.src = `https://w.soundcloud.com/player/?url=${enc}&color=%23fff500&auto_play=${autoplay}&visual=true&show_comments=false&show_reposts=false&show_teaser=false`;
  scInitWidgetApi(() => scBindWidget(scFrame));
}

// ── Universal player controls ──────────────────────────────────────────────
let activePlayer = 1; // 0=YT, 1=SC, 2=SP
let ytPlaying = false, ytDuration = 0;

function ytCmd(func, args) {
  try {
    document.getElementById('yt-frame').contentWindow.postMessage(
      JSON.stringify({ event: 'command', func, args: args ?? '' }), '*');
  } catch {}
}

function scPlayPause() {
  if (activePlayer === 0) { ytPlaying ? ytCmd('pauseVideo') : ytCmd('playVideo'); }
  else if (scWidget) scWidget.toggle();
}
function scPrev() {
  if (activePlayer === 0) ytCmd('previousVideo');
  else if (scWidget) scWidget.prev();
}
function scNext() {
  if (activePlayer === 0) ytCmd('nextVideo');
  else if (scWidget) scWidget.next();
}

document.getElementById('sc-prog').addEventListener('click', e => {
  const pct = e.offsetX / e.currentTarget.offsetWidth;
  if (activePlayer === 0 && ytDuration > 0) {
    ytCmd('seekTo', [ytDuration * pct, true]);
  } else if (activePlayer === 1 && scWidget) {
    scWidget.getDuration(d => scWidget.seekTo(d * pct));
  }
});

function barSetYT() {
  activePlayer = 0;
  document.getElementById('sc-controls').classList.add('yt-mode');
  const art = document.getElementById('sc-art');
  art.src = '';
  art.classList.add('yt-icon');
  art.alt = 'YT';
  document.getElementById('sc-track-title').textContent = 'YouTube';
  document.getElementById('sc-track-artist').textContent = '';
  document.getElementById('sc-prog-fill').style.width = '0%';
  document.getElementById('sc-time-cur').textContent = '0:00';
  document.getElementById('sc-time-dur').textContent = '0:00';
  ytDuration = 0;
}
function barSetSC() {
  activePlayer = 1;
  document.getElementById('sc-controls').classList.remove('yt-mode');
  const art = document.getElementById('sc-art');
  art.classList.remove('yt-icon');
  art.style.background = '';
  art.alt = '';
  if (scWidget) scWidget.getCurrentSound(scUpdateTrackInfo);
}
function barSetSP() {
  activePlayer = 2;
  document.getElementById('sc-controls').classList.add('yt-mode');
  const art = document.getElementById('sc-art');
  art.src = ''; art.style.background = '#1db954'; art.alt = 'SP';
  art.classList.remove('yt-icon');
  document.getElementById('sc-track-title').textContent = 'Spotify';
  document.getElementById('sc-track-artist').textContent = '';
}

function cleanTitle(t) {
  return (t || '').replace(/\s*[\(\[](?:official\s*(?:music\s*)?video|music\s*video|official\s*audio|official\s*lyric(?:s)?(?:\s*video)?|lyrics?(?:\s*video)?|audio|hd|4k|remaster(?:ed)?)[^\)\]]*[\)\]]/gi, '').trim();
}

function ytApplyVideoData(vd) {
  if (!vd) return;
  const title = cleanTitle(vd.title || vd.author_name);
  if (title) document.getElementById('sc-track-title').textContent = title;
  const artist = vd.author || vd.author_name || '';
  if (artist) document.getElementById('sc-track-artist').textContent = artist;
  const vid = vd.video_id;
  if (vid) {
    const art = document.getElementById('sc-art');
    art.classList.remove('yt-icon');
    art.style.background = '';
    art.src = `https://img.youtube.com/vi/${vid}/mqdefault.jpg`;
    art.onerror = function() { this.onerror = null; this.src = ''; this.classList.add('yt-icon'); };
  }
}

// Listen for YT iframe events
window.addEventListener('message', e => {
  if (activePlayer !== 0) return;
  try {
    const d = JSON.parse(typeof e.data === 'string' ? e.data : '{}');
    if (d.event === 'onStateChange') {
      ytPlaying = d.info === 1;
      document.getElementById('sc-playpause').textContent = ytPlaying ? '⏸' : '▶';
    }
    if (d.event === 'infoDelivery' && d.info) {
      // YT sends title in videoData sub-object
      if (d.info.videoData) ytApplyVideoData(d.info.videoData);
      // Fallback: some builds send at top level
      else if (d.info.title) ytApplyVideoData(d.info);
      if (d.info.duration > 0) ytDuration = d.info.duration;
      if (d.info.currentTime !== undefined && ytDuration > 0) {
        const pct = (d.info.currentTime / ytDuration) * 100;
        document.getElementById('sc-prog-fill').style.width = pct + '%';
        document.getElementById('sc-time-cur').textContent = scFmtTime(d.info.currentTime * 1000);
        document.getElementById('sc-time-dur').textContent = scFmtTime(ytDuration * 1000);
      }
    }
  } catch {}
});

function extractUrl(text) {
  const m = text.match(/https?:\/\/\S+/);
  if (m) return m[0];
  const t = text.trim();
  return t.startsWith('http') ? t : 'https://' + t;
}

function scLoadUrl() {
  const input = document.getElementById('sc-url-input');
  const raw   = input.value.trim();
  if (!raw) return;
  const url = extractUrl(raw);
  scLoadInWidget(url);
  addToSaved(url);
  input.value = '';
  input.blur();
}

document.getElementById('sc-url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') scLoadUrl();
});

// ── SC Multi-account & QR ─────────────────────────────────────────────────────
let scQrPollInterval = null;

function scGetAccounts() { try { return JSON.parse(localStorage.getItem('sc_accounts') || '[]'); } catch { return []; } }
function scSaveAccounts(a) { localStorage.setItem('sc_accounts', JSON.stringify(a)); }
function scGetActiveIdx() { return parseInt(localStorage.getItem('sc_active_idx') || '0', 10); }
function scSetActiveIdx(i) { localStorage.setItem('sc_active_idx', String(i)); }
function scActiveAccount() { const a = scGetAccounts(), i = scGetActiveIdx(); return a[i] || null; }

function scApplyActiveAccount() {
  const acc = scActiveAccount();
  if (acc) {
    scSetUI(true, acc.username, acc.avatar_url);
    scLoadLikes(acc.access_token);
  } else {
    scSetUI(false);
  }
}

function scUpdateAccountsMenu() {
  const accs = scGetAccounts(), activeIdx = scGetActiveIdx();
  const container = document.getElementById('menu-sc-accounts');
  if (!container) return;
  container.innerHTML = '';
  accs.forEach((acc, i) => {
    const el = document.createElement('div');
    el.className = 'msc-acc' + (i === activeIdx ? ' active' : '');
    el.innerHTML = `<img class="msc-ava" src="${acc.avatar_url || ''}" onerror="this.style.visibility='hidden'" alt="">
      <span class="msc-name">${acc.username || 'SC Account'}</span>
      ${i === activeIdx ? '<span class="msc-check">✓</span>' : ''}`;
    el.addEventListener('click', () => {
      scSetActiveIdx(i);
      scApplyActiveAccount();
      scUpdateAccountsMenu();
      closeMenu();
    });
    container.appendChild(el);
  });
}

function scRemoveActive() {
  const accs = scGetAccounts(), i = scGetActiveIdx();
  accs.splice(i, 1);
  scSaveAccounts(accs);
  scSetActiveIdx(Math.max(0, i - 1));
  scApplyActiveAccount();
  scUpdateAccountsMenu();
}

// PKCE helpers
function scMakeVerifier() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
async function scMakeChallenge(v) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function scShowQR() {
  const cid = localStorage.getItem('sc_client_id');
  const modal = document.getElementById('sc-qr-modal');
  modal.classList.add('show');
  if (cid) {
    document.getElementById('sc-qr-setup').classList.remove('show');
    document.getElementById('sc-qr-content').classList.add('show');
    scStartQRFlow(cid);
  } else {
    document.getElementById('sc-qr-content').classList.remove('show');
    document.getElementById('sc-qr-setup').classList.add('show');
    document.getElementById('sc-cid-input').focus();
  }
}

function scSubmitClientId() {
  const input = document.getElementById('sc-cid-input');
  const cid = input.value.trim();
  if (!cid) return;
  localStorage.setItem('sc_client_id', cid);
  document.getElementById('sc-qr-setup').classList.remove('show');
  document.getElementById('sc-qr-content').classList.add('show');
  scStartQRFlow(cid);
}

async function scStartQRFlow(cid) {
  const sid      = crypto.randomUUID();
  const verifier = scMakeVerifier();
  const challenge = await scMakeChallenge(verifier);

  try {
    await fetch('/api/sc-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sid, client_id: cid, verifier, challenge }),
    });
  } catch(e) { return; }

  const authUrl = location.origin + '/sc-auth?session=' + sid;
  const qrUrl   = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(authUrl);
  document.getElementById('sc-qr-img').src = qrUrl;
  document.getElementById('sc-qr-waiting').classList.add('show');

  scQrPollInterval = setInterval(async () => {
    try {
      const r = await fetch('/api/sc-poll?session=' + sid);
      const d = await r.json();
      if (d && d.access_token) {
        clearInterval(scQrPollInterval); scQrPollInterval = null;
        const accs = scGetAccounts();
        const ei   = accs.findIndex(a => a.username === d.username);
        if (ei >= 0) { accs[ei] = { ...d, client_id: cid }; scSetActiveIdx(ei); }
        else         { accs.push({ ...d, client_id: cid }); scSetActiveIdx(accs.length - 1); }
        scSaveAccounts(accs);
        scHideQR();
        scApplyActiveAccount();
        scUpdateAccountsMenu();
      }
    } catch(e) {}
  }, 2000);
}

function scHideQR() {
  clearInterval(scQrPollInterval); scQrPollInterval = null;
  const modal = document.getElementById('sc-qr-modal');
  modal.classList.remove('show');
  document.getElementById('sc-qr-setup').classList.remove('show');
  document.getElementById('sc-qr-content').classList.remove('show');
  document.getElementById('sc-qr-waiting').classList.remove('show');
  document.getElementById('sc-qr-img').src = '';
  document.getElementById('sc-cid-input').value = '';
}

// ─── URL RESOLVER (short links: on.soundcloud.com, youtu.be etc) ─────────────
async function resolveUrl(url) {
  if (!/on\.soundcloud\.com|snd\.sc/.test(url)) return url;
  try {
    const r = await fetch('/api/resolve-url?url=' + encodeURIComponent(url));
    const d = await r.json();
    return d.url || url;
  } catch { return url; }
}

// ─── SAVED PLAYLISTS ────────────────────────────────────────────────────────
let savedList = [], currentSavedUrl = null;
async function savedLoad() {
  try {
    const r = await fetch('/api/saved-list');
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data)) {
        savedList = data;
        localStorage.setItem('saved_playlists', JSON.stringify(savedList));
        return;
      }
    }
  } catch {}
  try { savedList = JSON.parse(localStorage.getItem('saved_playlists') || '[]'); } catch { savedList = []; }
}
function savedSave() {
  localStorage.setItem('saved_playlists', JSON.stringify(savedList));
  fetch('/api/saved-list', { method: 'PUT', body: JSON.stringify(savedList), headers: { 'Content-Type': 'application/json' } }).catch(() => {});
}

function detectService(url) {
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
  if (/soundcloud\.com/.test(url)) return 'soundcloud';
  if (/spotify\.com/.test(url)) return 'spotify';
  return null;
}

async function fetchMeta(url) {
  try {
    const r = await fetch('/api/oembed?url=' + encodeURIComponent(url));
    if (!r.ok) throw new Error();
    const d = await r.json();
    const title = cleanTitle(d.title) || url;
    const thumbnail = d.thumbnail_url || null;
    return { title: title, thumbnail: thumbnail };
  } catch {
    const vidM = url.match(/(?:youtu\.be\/|[?&]v=)([^&#]+)/);
    if (vidM) return { title: url, thumbnail: 'https://img.youtube.com/vi/' + vidM[1] + '/mqdefault.jpg' };
    return { title: url, thumbnail: null };
  }
}

async function addToSaved(url) {
  url = await resolveUrl(url);
  const service = detectService(url);
  if (!service) return;
  if (service === 'soundcloud' && SC_UNSUPPORTED.test(url)) return;
  const meta = await fetchMeta(url);
  const existing = savedList.findIndex(i => i.url === url);
  if (existing >= 0) { savedList.splice(existing, 1); }
  savedList.unshift({ id: Date.now(), url, service, title: meta.title, thumbnail: meta.thumbnail });
  savedSave();
  renderSavedList();
  loadSavedItem(savedList[0]);
}

function svcLabel(s) {
  if (s === 'youtube') return { cls: 'yt', txt: 'YT' };
  if (s === 'soundcloud') return { cls: 'sc', txt: 'SC' };
  if (s === 'spotify') return { cls: 'sp', txt: 'SP' };
  return { cls: '', txt: '?' };
}

// Edit mode state
let savedEditMode = false;
let tdSrc = null, tdClone = null, tdLastOver = null;

function enterSavedEdit() {
  savedEditMode = true;
  document.getElementById('saved-edit-bar').classList.add('show');
  renderSavedList();
}
function exitSavedEdit() {
  savedEditMode = false;
  document.getElementById('saved-edit-bar').classList.remove('show');
  renderSavedList();
}
function savedDelete(idx) {
  savedList.splice(idx, 1);
  savedSave();
  renderSavedList();
}
function savedToggleReserve(idx) {
  savedList[idx].reserve = !savedList[idx].reserve;
  savedSave();
  renderSavedList();
}

function savedThumbErr(el, cls, txt) {
  el.style.display = 'none';
  el.insertAdjacentHTML('afterend', '<div class="svc-ico ' + cls + '">' + txt + '</div>');
}

function renderSavedList() {
  const listEl = document.getElementById('saved-list');
  if (savedList.length === 0) {
    listEl.innerHTML = '<div id="saved-empty">Пока пусто.<br>Добавь первый плейлист.</div>';
    return;
  }
  [listEl].forEach(container => {
    container.innerHTML = '';
    savedList.forEach((item, i) => {
      const { cls, txt } = svcLabel(item.service);
      const safe = item.title.replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const el = document.createElement('div');
      el.className = 'saved-item' + (savedEditMode ? ' edit-mode' : '') + (item.reserve ? ' reserve' : '') + (item.url === currentSavedUrl ? ' active' : '');
      el.dataset.idx = i;
      const thumbSrc = item.thumbnail || '';
      el.innerHTML = `
        <div class="saved-drag-h" title="Перетащить">⠿</div>
        ${thumbSrc ? `<img class="saved-thumb" src="${thumbSrc}" onerror="savedThumbErr(this,'${cls}','${txt}')" alt="">` : `<div class="svc-ico ${cls}">${txt}</div>`}
        <div class="saved-title">${safe}</div>
        <button class="saved-ren-btn" title="Переименовать"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="saved-res-btn${item.reserve ? ' on' : ''}" title="Резерв">☆</button>
        <button class="saved-del-btn" title="Удалить">✕</button>`;

      // Long press → edit mode
      let lpTimer = null;
      el.addEventListener('touchstart', () => {
        lpTimer = setTimeout(() => { if (!savedEditMode) enterSavedEdit(); }, 500);
      }, { passive: true });
      el.addEventListener('touchend', () => clearTimeout(lpTimer), { passive: true });
      el.addEventListener('touchmove', () => clearTimeout(lpTimer), { passive: true });

      // Del/res always wired (visible on hover for mouse, in edit-mode for touch)
      el.querySelector('.saved-res-btn').addEventListener('click', e => { e.stopPropagation(); savedToggleReserve(i); });
      el.querySelector('.saved-del-btn').addEventListener('click', e => { e.stopPropagation(); savedDelete(i); });
      el.querySelector('.saved-ren-btn').addEventListener('click', e => {
        e.stopPropagation();
        const titleEl = el.querySelector('.saved-title');
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = item.title;
        inp.style.cssText = 'flex:1;min-width:0;background:#111120;border:1px solid var(--yellow);border-radius:4px;color:#fff;font-size:11px;padding:3px 7px;outline:none;touch-action:auto;-webkit-user-select:auto;user-select:auto;';
        titleEl.parentNode.replaceChild(inp, titleEl);
        inp.focus(); inp.select();
        function commit() {
          const v = inp.value.trim();
          if (v) { savedList[i].title = v; savedSave(); }
          renderSavedList();
        }
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', function(ev) {
          if (ev.key === 'Enter') { inp.blur(); }
          if (ev.key === 'Escape') { savedList[i].title = item.title; inp.blur(); }
        });
      });

      const handle = el.querySelector('.saved-drag-h');
      // Mouse drag (desktop — works without entering edit mode)
      handle.addEventListener('mousedown', e => {
        e.preventDefault();
        tdSrc = { idx: i, el, container };
        el.classList.add('dragging');
        const rect = el.getBoundingClientRect();
        tdClone = el.cloneNode(true);
        tdClone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;z-index:999;pointer-events:none;background:#1a1a2e;border:1px solid var(--yellow);border-radius:4px;opacity:0.92;`;
        document.body.appendChild(tdClone);
      });
      if (savedEditMode) {
        // Touch drag on handle (touch enters edit mode via long-press first)
        handle.addEventListener('touchstart', e => {
          e.preventDefault();
          tdSrc = { idx: i, el, container };
          el.classList.add('dragging');
          const rect = el.getBoundingClientRect();
          tdClone = el.cloneNode(true);
          tdClone.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;z-index:999;pointer-events:none;background:#1a1a2e;border:1px solid var(--yellow);border-radius:4px;opacity:0.92;`;
          document.body.appendChild(tdClone);
        }, { passive: false });
      } else {
        el.addEventListener('click', () => loadSavedItem(item));
      }
      container.appendChild(el);
    });
  });
}

// Global drag events (touch + mouse)
function dragMove(clientX, clientY) {
  if (!tdSrc || !tdClone) return;
  tdClone.style.top = (clientY - 20) + 'px';
  tdClone.style.display = 'none';
  const under = document.elementFromPoint(clientX, clientY);
  tdClone.style.display = '';
  const overItem = under ? under.closest('.saved-item') : null;
  if (tdLastOver && tdLastOver !== overItem) tdLastOver.classList.remove('drag-over');
  if (overItem && overItem !== tdSrc.el) { overItem.classList.add('drag-over'); tdLastOver = overItem; }
  else tdLastOver = null;
}
function dragEnd() {
  if (!tdSrc) return;
  if (tdClone) { document.body.removeChild(tdClone); tdClone = null; }
  if (tdLastOver) {
    tdLastOver.classList.remove('drag-over');
    const toIdx = parseInt(tdLastOver.dataset.idx);
    if (!isNaN(toIdx) && toIdx !== tdSrc.idx) {
      const item = savedList.splice(tdSrc.idx, 1)[0];
      savedList.splice(toIdx, 0, item);
      savedSave();
      renderSavedList();
    }
  } else if (tdSrc.el) {
    tdSrc.el.classList.remove('dragging');
  }
  tdSrc = null; tdLastOver = null;
}

document.addEventListener('touchmove', e => {
  if (!tdSrc || !tdClone) return;
  const touch = e.touches[0];
  dragMove(touch.clientX, touch.clientY);
}, { passive: true });
document.addEventListener('touchend', dragEnd, { passive: true });

document.addEventListener('mousemove', e => { dragMove(e.clientX, e.clientY); });
document.addEventListener('mouseup', dragEnd);

function loadSavedItem(item) {
  openMediaPanel();
  hideSavedPanel();
  currentSavedUrl = item.url;
  renderSavedList();
  if (item.service === 'youtube') {
    setMediaTab(0);
    // Immediately populate bar from saved item data
    if (item.title) document.getElementById('sc-track-title').textContent = cleanTitle(item.title);
    const m1 = item.url.match(/youtu\.be\/([^?&#]+)/);
    const m2 = item.url.match(/[?&]v=([^&#]+)/);
    const m3 = item.url.match(/[?&]list=([^&#]+)/);
    const vid = m1 ? m1[1] : (m2 ? m2[1] : null);
    const art = document.getElementById('sc-art');
    if (vid) {
      art.classList.remove('yt-icon'); art.style.background = '';
      art.src = 'https://img.youtube.com/vi/' + vid + '/mqdefault.jpg';
      art.onerror = function() { this.onerror = null; this.src = ''; this.classList.add('yt-icon'); };
    } else {
      art.src = ''; art.classList.add('yt-icon'); art.style.background = '';
    }
    if (m3) document.getElementById('yt-frame').src = 'https://www.youtube.com/embed/videoseries?list=' + m3[1] + '&autoplay=1&enablejsapi=1';
    else if (m1) document.getElementById('yt-frame').src = 'https://www.youtube.com/embed/' + m1[1] + '?autoplay=1&enablejsapi=1';
    else if (m2) document.getElementById('yt-frame').src = 'https://www.youtube.com/embed/' + m2[1] + '?autoplay=1&enablejsapi=1';
  } else if (item.service === 'soundcloud') {
    setMediaTab(1);
    scLoadInWidget(item.url);
  } else if (item.service === 'spotify') {
    setMediaTab(2);
    const embedUrl = item.url.replace('open.spotify.com/', 'open.spotify.com/embed/');
    document.getElementById('sp-frame').src = embedUrl + (embedUrl.includes('?') ? '&' : '?') + 'utm_source=generator&theme=0';
  }
}

// ─── SAVED PANEL: add URL inline ────────────────────────────────────────────
function toggleSavedAdd() {
  const row = document.getElementById('saved-add-row');
  const show = row.classList.toggle('show');
  if (show) {
    const inp = document.getElementById('saved-add-input');
    inp.value = '';
    inp.focus();
  }
}

async function savedAddSubmit() {
  const inp = document.getElementById('saved-add-input');
  const raw = inp.value.trim();
  if (!raw) return;
  const url = extractUrl(raw);
  document.getElementById('saved-add-row').classList.remove('show');
  inp.value = '';
  await addToSaved(url);
}

document.getElementById('saved-add-ok').addEventListener('click', savedAddSubmit);
document.getElementById('saved-add-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') savedAddSubmit();
  if (e.key === 'Escape') document.getElementById('saved-add-row').classList.remove('show');
});

// ─── GUEST QR FLOW ──────────────────────────────────────────────────────────
let guestPollInterval = null;

async function showGuestQR() {
  try {
    const r = await fetch('/api/guest-session', { method: 'POST' });
    const d = await r.json();
    const sid = d.session_id;
    const guestUrl = location.origin + '/guest?s=' + sid;
    const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(guestUrl);
    document.getElementById('guest-qr-img').src = qrUrl;
    document.getElementById('guest-qr-modal').classList.add('show');
    guestPollInterval = setInterval(async () => {
      try {
        const pr = await fetch('/api/guest-poll?session=' + sid);
        const pd = await pr.json();
        if (pd && pd.url) {
          clearInterval(guestPollInterval); guestPollInterval = null;
          hideGuestQR();
          await addToSaved(pd.url);
        }
      } catch {}
    }, 2000);
  } catch(e) {}
}

function hideGuestQR() {
  clearInterval(guestPollInterval); guestPollInterval = null;
  document.getElementById('guest-qr-modal').classList.remove('show');
  document.getElementById('guest-qr-img').src = '';
  document.getElementById('guest-paste-input').value = '';
}

async function guestPasteSubmit() {
  const input = document.getElementById('guest-paste-input');
  const raw = input.value.trim();
  if (!raw) return;
  let url = extractUrl(raw);
  hideGuestQR();
  await addToSaved(url);
}

function showSavedSheet() { showSavedPanel(); }
function hideSavedSheet() { hideSavedPanel(); }

// ─── SC URL INPUT: also adds to saved ───────────────────────────────────────
function scInitWidgetApi(cb) {
  if (window.SC) { if (cb) cb(); return; }
  const prev = window._scReadyCb;
  if (document.getElementById('sc-api-js')) {
    window._scReadyCb = () => { if (prev) prev(); if (cb) cb(); };
    return;
  }
  window._scReadyCb = cb;
  const s = document.createElement('script');
  s.id  = 'sc-api-js';
  s.src = 'https://w.soundcloud.com/player/api.js';
  s.onload = () => { if (window._scReadyCb) { window._scReadyCb(); window._scReadyCb = null; } };
  document.head.appendChild(s);
}

// SC init
document.getElementById('sc-cid-ok').addEventListener('click', scSubmitClientId);
document.getElementById('sc-cid-input').addEventListener('keydown', e => { if (e.key === 'Enter') scSubmitClientId(); });
scConnectBtn.addEventListener('click', () => {
  if (scActiveAccount()) scRemoveActive(); else scShowQR();
});
scApplyActiveAccount();
scUpdateAccountsMenu();

// Saved playlists init
(async () => { await savedLoad(); renderSavedList(); savedRefreshThumbnails(); })();

// Background thumbnail refresh for items saved before thumbnail support
async function savedRefreshThumbnails() {
  var changed = false;
  for (var i = 0; i < savedList.length; i++) {
    var item = savedList[i];
    if (item.thumbnail && item.title !== item.url) continue;
    try {
      var r = await fetch('/api/oembed?url=' + encodeURIComponent(item.url));
      if (r.ok) {
        var d = await r.json();
        if (d.thumbnail_url && !item.thumbnail) { item.thumbnail = d.thumbnail_url; changed = true; }
        if (d.title && item.title === item.url) { item.title = cleanTitle(d.title) || item.title; changed = true; }
      }
    } catch {}
    if (!item.thumbnail) {
      var vm = item.url.match(/(?:youtu\.be\/|[?&]v=)([^&#]+)/);
      if (vm) { item.thumbnail = 'https://img.youtube.com/vi/' + vm[1] + '/mqdefault.jpg'; changed = true; }
    }
  }
  if (changed) { savedSave(); renderSavedList(); }
}

// Restore last SC track on startup — load widget silently, bar appears on first PLAY
(function restoreLastTrack() {
  const url = localStorage.getItem('sc_last_url');
  if (!url) return;
  currentSavedUrl = url;
  renderSavedList();
  const ph = document.getElementById('sc-placeholder');
  if (ph) ph.classList.add('hidden');
  const enc = encodeURIComponent(url);
  scFrame.src = 'https://w.soundcloud.com/player/?url=' + enc + '&color=%23fff500&auto_play=false&visual=true&show_comments=false&show_reposts=false&show_teaser=false';
  scInitWidgetApi(() => { scBindWidget(scFrame); });
  // Pre-populate bar from oEmbed while widget loads
  fetch('/api/oembed?url=' + encodeURIComponent(url))
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.title) document.getElementById('sc-track-title').textContent = cleanTitle(d.title);
      if (d.thumbnail_url) {
        const art = document.getElementById('sc-art');
        art.classList.remove('yt-icon');
        art.style.background = '';
        art.src = d.thumbnail_url;
      }
    })
    .catch(function() {});
})();

// Guest paste field
document.getElementById('guest-paste-ok').addEventListener('click', guestPasteSubmit);
document.getElementById('guest-paste-input').addEventListener('keydown', e => { if (e.key === 'Enter') guestPasteSubmit(); });
