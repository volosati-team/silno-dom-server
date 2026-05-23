// ============== TOUCH POLICY: single-finger only ==============
// Owner asked to disable multi-touch on the kiosk panel. One-finger taps and
// drags only. No pinch-zoom, no double-tap zoom, no two-finger gestures.
// viewport meta already pins scale; the listeners below kill what some
// browsers still permit despite the meta.
(function(){
  // touchstart / touchmove with >=2 fingers → swallow.
  function multiTouchGuard(e){
    if (e.touches && e.touches.length > 1) {
      e.preventDefault();
    }
  }
  document.addEventListener('touchstart', multiTouchGuard, { passive: false });
  document.addEventListener('touchmove',  multiTouchGuard, { passive: false });
  // iOS Safari pinch gesture events — fire even if touch* are prevented.
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function(ev){
    document.addEventListener(ev, function(e){ e.preventDefault(); });
  });
  // Kill double-tap zoom: dblclick → preventDefault.
  document.addEventListener('dblclick', function(e){ e.preventDefault(); }, { passive: false });
})();

// ============== INLINE CONSOLE (runs first) ==============
(function(){
  var body = null;
  function ready(cb){ if (document.readyState !== 'loading') cb(); else document.addEventListener('DOMContentLoaded', cb); }
  ready(function(){
    body = document.getElementById('console-body');
    if (!body) return;
    drain();
  });
  var queue = [];
  function ts(){
    var d = new Date(); var p = function(n){return n<10?'0'+n:''+n;};
    return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
  }
  function fmt(arg){
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';
    if (typeof arg === 'object') { try { return JSON.stringify(arg); } catch(e){ return String(arg); } }
    return String(arg);
  }
  function append(level, parts){
    var text = ts()+' '+parts.map(fmt).join(' ');
    if (!body){ queue.push([level, text]); return; }
    var div = document.createElement('div');
    div.className = 'log-line log-'+level;
    div.textContent = text;
    body.appendChild(div);
    while (body.children.length > 300) body.removeChild(body.firstChild);
    body.scrollTop = body.scrollHeight;
  }
  function drain(){ queue.forEach(function(q){ append(q[0], [q[1]]); }); queue.length = 0; }
  var orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log   = function(){ append('info',  Array.prototype.slice.call(arguments)); orig.log.apply(console, arguments); };
  console.info  = function(){ append('info',  Array.prototype.slice.call(arguments)); orig.info.apply(console, arguments); };
  console.warn  = function(){ append('warn',  Array.prototype.slice.call(arguments)); orig.warn.apply(console, arguments); };
  console.error = function(){ append('error', Array.prototype.slice.call(arguments)); orig.error.apply(console, arguments); };
  window.addEventListener('error', function(e){ append('error', ['JS error:', e.message, 'at', e.filename+':'+e.lineno]); });
  window.addEventListener('unhandledrejection', function(e){ append('error', ['Unhandled rejection:', String(e.reason)]); });
  // URLs that flood the inline console with polling noise — skip them in
  // the visible log, but still let the request go through normally.
  // We log everything in the original DevTools console (via passthrough).
  var QUIET_FETCH_PATTERNS = [
    /\/api\/light\/state(\?|$)/,
    /\/api\/dbg-log(\?|$)/,
  ];
  function isQuietFetch(url) {
    for (var i = 0; i < QUIET_FETCH_PATTERNS.length; i++) {
      if (QUIET_FETCH_PATTERNS[i].test(url)) return true;
    }
    return false;
  }
  var origFetch = window.fetch;
  window.fetch = function(){
    var url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url) || '';
    var method = (arguments[1] && arguments[1].method) || 'GET';
    var quiet = isQuietFetch(url);
    if (!quiet) append('net', ['→', method, url]);
    return origFetch.apply(window, arguments).then(function(r){
      if (!quiet) append('net', ['←', r.status, method, url]);
      return r;
    }).catch(function(e){
      // Errors are always shown, even for quiet endpoints.
      append('error', ['✖', method, url, String(e)]);
      throw e;
    });
  };
  // Global click tap — logs any button-ish element so non-fetch UI events are visible in the pane.
  document.addEventListener('click', function(e){
    var t = e.target.closest('button, [onclick], .ctrl-btn, .sc-btn, .saved-item, .ztab, .ttab');
    if (!t) return;
    var id = t.id || '';
    var cls = (t.className || '').toString().split(/\s+/).slice(0,2).join('.');
    var txt = (t.innerText || t.textContent || '').trim().slice(0, 24).replace(/\s+/g, ' ');
    append('info', ['tap', (id ? '#'+id : cls), txt ? '"'+txt+'"' : '']);
  }, true);

  window._lisaClearConsole = function(){ if (body) body.innerHTML = ''; };
  // Console is hidden by default — the user toggles it via the menu
  // (#menu-console-toggle). State persists in localStorage.
  function applyConsoleVisible(on){
    var p = document.getElementById('console-pane');
    if (!p) return;
    if (on) p.classList.add('shown'); else p.classList.remove('shown');
  }
  window._lisaSetConsoleEnabled = function(on){
    try { localStorage.setItem('console_enabled', on ? '1' : '0'); } catch(_) {}
    applyConsoleVisible(on);
  };
  window._lisaConsoleEnabled = function(){
    try { return localStorage.getItem('console_enabled') === '1'; } catch(_) { return false; }
  };
  ready(function(){ applyConsoleVisible(window._lisaConsoleEnabled()); });
  // Legacy entry points kept as no-ops so existing onclicks don't blow up.
  window._lisaToggleConsole = function(){ window._lisaSetConsoleEnabled(!window._lisaConsoleEnabled()); };
  window._lisaShowConsole   = function(){ window._lisaSetConsoleEnabled(true); };
})();

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
  // Hook console.error, console.warn, console.log
  var origErr = console.error, origWarn = console.warn, origLog = console.log;
  console.error = function() {
    try { send({ type: 'console.error', args: Array.prototype.slice.call(arguments).map(String) }); } catch(e){}
    return origErr.apply(console, arguments);
  };
  console.warn = function() {
    try { send({ type: 'console.warn', args: Array.prototype.slice.call(arguments).map(String) }); } catch(e){}
    return origWarn.apply(console, arguments);
  };
  console.log = function() {
    try { send({ type: 'console.log', args: Array.prototype.slice.call(arguments).map(String) }); } catch(e){}
    return origLog.apply(console, arguments);
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

var lastActiveZone = null;
function closeMediaPanel() {
  medOpen = false;
  mediaClip.classList.remove('open');
  zoneClip.classList.remove('constrained');
  document.getElementById('sc-expand-btn').classList.remove('open');
  // Never leave the screen blank — fall back to the last active zone (or yard).
  if (!activeZone) {
    var z = lastActiveZone || 'yard';
    var tab = document.querySelector('.ztab[data-zone="' + z + '"]');
    if (tab) {
      document.querySelectorAll('.ztab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeZone = z;
      setZoneSlide(z);
      zoneClip.classList.add('open');
    }
  }
}
function openMediaPanel() {
  medOpen = true;
  if (activeZone) {
    // Keep zone visible as one-row ctrl-btn strip
    zoneClip.classList.add('constrained');
  } else {
    closeZone();
  }
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
  if (activeZone) lastActiveZone = activeZone;
  activeZone = null;
  document.querySelectorAll('.ztab').forEach(t => t.classList.remove('active'));
  zoneClip.classList.remove('open', 'constrained');
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
    await fetch('/api/light/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [ch]: val }) });
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
    const r = await fetch('/api/light/state');
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

// Default: media panel open with constrained zone strip (no transition on init)
zoneClip.classList.add('constrained');
medOpen = true;
mediaClip.classList.add('open');
document.getElementById('sc-expand-btn').classList.add('open');
var _mi = document.getElementById('media-inner');
_mi.style.transition = 'none';
requestAnimationFrame(function() { requestAnimationFrame(function() {
  _mi.style.transition = '';
  zoneTrack.style.transition = 'transform 0.32s cubic-bezier(0.32,0.72,0,1)';
}); });

pollState();
setInterval(pollState, 5000);

// Insert hidden <audio> shim ahead of any user interaction so the very first
// click can resolve+play in one gesture chain (mobile autoplay policy).
document.addEventListener('DOMContentLoaded', function() {
  if (typeof ensureNativeAudio === 'function') ensureNativeAudio();
});

// ── SoundCloud ────────────────────────────────────────────────────────────────
const SC_REDIRECT = location.origin + '/';
let scWidget = null;
let scIsPlaying = false;  // tracked via SC widget PLAY/PAUSE/FINISH events
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
function safeWidgetCall(fnName, arg) {
  if (!scWidget || typeof scWidget[fnName] !== 'function') return;
  try { scWidget[fnName](arg); } catch(e) { console.warn('SC ' + fnName + ' threw:', e && e.message); }
}
function scToggleShuffle() {
  scShuffleOn = !scShuffleOn;
  document.getElementById('sc-shuffle').classList.toggle('on', scShuffleOn);
  safeWidgetCall('setShuffle', scShuffleOn);
}
function scSetVolume(val) { if (scWidget) scWidget.setVolume(parseInt(val)); }
function scVolSetActual(val) {
  if (activePlayer === 3 && nativeAudio) { nativeAudio.volume = Math.max(0, Math.min(1, val / 100)); return; }
  if (activePlayer === 1) scSetVolume(val);
  else if (activePlayer === 0) ytCmd('setVolume', [val]);
}
var scMuted = false;
var scPreMuteVol = 80;
var scVolHideTimer = null;
function scVolResetTimer() {
  clearTimeout(scVolHideTimer);
  scVolHideTimer = setTimeout(function() {
    document.getElementById('sc-vol-popup').classList.remove('visible');
  }, 2500);
}
function scVolToggle() {
  var popup = document.getElementById('sc-vol-popup');
  if (popup.classList.contains('visible')) {
    scMuted = !scMuted;
    document.getElementById('sc-vol-btn').classList.toggle('muted', scMuted);
    if (scMuted) {
      scPreMuteVol = parseInt(document.getElementById('sc-vol').value);
      scVolSetActual(0);
    } else {
      scVolSetActual(scPreMuteVol);
    }
  } else {
    popup.classList.add('visible');
  }
  scVolResetTimer();
}
document.getElementById('sc-vol').addEventListener('input', function(e) {
  scMuted = false;
  document.getElementById('sc-vol-btn').classList.remove('muted');
  scVolSetActual(parseInt(e.target.value));
  scVolResetTimer();
});

function scToggleRepeat() {
  scRepeatOn = !scRepeatOn;
  document.getElementById('sc-repeat').classList.toggle('on', scRepeatOn);
  safeWidgetCall('setRepeat', scRepeatOn);
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
    if (scShuffleOn) safeWidgetCall('setShuffle', true);
    if (scRepeatOn)  safeWidgetCall('setRepeat', true);
  });
  scWidget.bind(SC.Widget.Events.PLAY, () => {
    scIsPlaying = true;
    console.warn('SC event PLAY');
    scShowBar();
    setBarPlayPauseIcon(true);
    scWidget.getCurrentSound(scUpdateTrackInfo);
    scWidget.getDuration(d => { tDur.textContent = scFmtTime(d); });
  });
  scWidget.bind(SC.Widget.Events.PAUSE, () => {
    scIsPlaying = false;
    console.warn('SC event PAUSE');
    setBarPlayPauseIcon(false);
  });
  scWidget.bind(SC.Widget.Events.FINISH, () => {
    scIsPlaying = false;
    console.warn('SC event FINISH');
    setBarPlayPauseIcon(false); fill.style.width = '0%'; tCur.textContent = '0:00';
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
  console.log('scLoadInWidget(start):', url, 'autoplay=' + autoplay, 'scWidget=' + (scWidget ? 'ok' : 'null'));
  // Sync UI reset: the previous track's PLAY state is meaningless for the
  // new URL. Without this, scIsPlaying stays true while the widget is
  // still loading the new URL, and a quick tap on bar pause fires
  // scWidget.pause() at a half-loaded widget (no-op) — looking like
  // "panel froze, didn't switch state".
  scIsPlaying = false;
  setBarPlayPauseIcon(false);
  // Sync fast path for autoplay: skip resolveUrl to keep the user-gesture
  // token alive (Chrome/mobile autoplay policy). Only short on.soundcloud.com
  // links need redirect-following — pass the rest through immediately.
  var SC_SHORT = /on\.soundcloud\.com/;
  if (autoplay && scWidget && !SC_SHORT.test(url)) {
    console.log('scLoadInWidget(sync-fast-path):', url);
    document.getElementById('sc-placeholder').classList.add('hidden');
    scShowBar();
    pauseYT();
    try { localStorage.setItem('sc_last_url', url); } catch(e) {}
    // Autoplay after .load() needs event-based forcing because Bromite
    // ignores auto_play option and the .load() callback path doesn't
    // get past its autoplay policy. Set a one-shot LOAD_PROGRESS hook
    // — first buffer event from the new URL = the widget actually
    // started loading the track, so .play() now has the gesture-bridge
    // it needs. Safety net at 2500ms in case neither callback nor
    // LOAD_PROGRESS fires.
    var playForced = false;
    function forcePlay(reason) {
      if (playForced) return;
      playForced = true;
      console.warn('scLoadInWidget: forcing play via ' + reason);
      try { scWidget.play(); } catch (e) { console.warn('SC play() failed:', e); }
    }
    var lpHandler = function () {
      try { scWidget.unbind(SC.Widget.Events.LOAD_PROGRESS); } catch(_) {}
      forcePlay('LOAD_PROGRESS');
    };
    try { scWidget.bind(SC.Widget.Events.LOAD_PROGRESS, lpHandler); } catch(_) {}
    setTimeout(function(){ forcePlay('timeout-2500ms'); }, 2500);
    scWidget.load(url, { auto_play: true, show_comments: false, show_reposts: false, show_teaser: false }, function() {
      console.log('scLoadInWidget: .load() callback fired');
      forcePlay('load-callback');
    });
    return;
  }
  url = await resolveUrl(url);
  console.log('scLoadInWidget(resolved):', url);
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
    // SC Widget.load() ignores auto_play on mobile (browser autoplay policy).
    // Workaround: pass an after-load callback that explicitly calls play().
    scWidget.load(url, { auto_play: autoplay, show_comments: false, show_reposts: false, show_teaser: false }, function() {
      if (autoplay) {
        try { scWidget.play(); } catch (e) { console.warn('SC play() failed:', e); }
      }
    });
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

// YT IFrame API handshake. Without this the iframe never sends state
// events (onStateChange, infoDelivery) and our bar play/pause buttons
// can't reflect actual playback state. Fires on every yt-frame src
// change so it covers playlist switches too.
(function () {
  function ready(cb){ if (document.readyState !== 'loading') cb(); else document.addEventListener('DOMContentLoaded', cb); }
  ready(function () {
    var f = document.getElementById('yt-frame');
    if (!f) return;
    f.addEventListener('load', function () {
      try {
        // YT iframe API expects a numeric id for the listening handshake.
        // Send both variants — some embed builds accept string, some only
        // numeric. Cost is one extra postMessage.
        f.contentWindow.postMessage(
          JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*');
        f.contentWindow.postMessage(
          JSON.stringify({ event: 'listening', id: '1', channel: 'widget' }), '*');
        console.log('YT listening handshake sent (numeric + string)');
      } catch (e) { console.warn('YT listening send threw:', e && e.message); }
    });
  });
})();

function nativeSavedIndex() {
  if (typeof savedList === 'undefined' || !savedList.length || !currentSavedUrl) return -1;
  return savedList.findIndex(function(it) { return it.url === currentSavedUrl; });
}

function scPlayPause() {
  console.log('scPlayPause: activePlayer=' + activePlayer + ' scWidget=' + (scWidget ? 'ok' : 'null') + ' ytPlaying=' + ytPlaying + ' scIsPlaying=' + scIsPlaying + ' nativePaused=' + (nativeAudio ? nativeAudio.paused : 'n/a'));
  // Re-prime gesture token at every bar tap so the iframe .play() that
  // follows inherits a fresh user-gesture record. Idempotent and muted.
  nativePrimeForGesture();
  // Cold-start case: after a page refresh nothing has been loaded yet but
  // currentSavedUrl is restored from saved-list. First tap on the bar's
  // play-pause should kick the player by loading the current saved item.
  if (!nativeCurrent && !scWidget && !ytPlaying) {
    var savedIdx = nativeSavedIndex();
    if (savedIdx >= 0) {
      console.log('scPlayPause: cold-start, kick loadSavedItem idx=' + savedIdx);
      loadSavedItem(savedList[savedIdx]);
      return;
    } else if (typeof savedList !== 'undefined' && savedList.length) {
      // No currentSavedUrl — play first saved item.
      console.log('scPlayPause: cold-start, kick first saved item');
      loadSavedItem(savedList[0]);
      return;
    }
  }
  if (activePlayer === 3 && nativeAudio) {
    if (nativeAudio.paused) { try { nativeAudio.play(); } catch(e) {} }
    else { try { nativeAudio.pause(); } catch(e) {} }
    return;
  }
  if (activePlayer === 0) { ytPlaying ? ytCmd('pauseVideo') : ytCmd('playVideo'); }
  else if (scWidget) {
    if (scIsPlaying) {
      console.warn('scPlayPause: calling scWidget.pause()');
      try { scWidget.pause(); } catch(e) { console.warn('SC pause threw:', e); }
    } else {
      console.warn('scPlayPause: calling scWidget.play()');
      try { scWidget.play(); } catch(e) { console.warn('SC play threw:', e); }
    }
  }
  else console.warn('scPlayPause: no handler — activePlayer=' + activePlayer + ' scWidget missing');
}
function scPrev() {
  console.log('scPrev: activePlayer=' + activePlayer + ' scWidget=' + (scWidget ? 'ok' : 'null'));
  if (activePlayer === 3) {
    // If current item resolved into a playlist (e.g. SC profile), walk
    // back inside that playlist first. Hit the start → jump to previous
    // saved-list entry.
    if (nativeCurrent && nativeCurrent.playlist_items && nativeCurrent.playlist_idx > 0) {
      nativePlayPlaylistIndex(nativeCurrent.playlist_idx - 1);
      return;
    }
    var idx = nativeSavedIndex();
    if (idx > 0) loadSavedItem(savedList[idx - 1]);
    return;
  }
  if (activePlayer === 0) {
    // Walk saved-list first — single-video embeds don't react to
    // previousVideo and we want prev/next to flow between saved items.
    var idx = nativeSavedIndex();
    if (idx > 0) { loadSavedItem(savedList[idx - 1]); return; }
    ytCmd('previousVideo');
  }
  else if (scWidget) scWidget.prev();
  else console.warn('scPrev: no handler');
}
function scNext() {
  console.log('scNext: activePlayer=' + activePlayer + ' scWidget=' + (scWidget ? 'ok' : 'null'));
  if (activePlayer === 3) {
    // Walk forward inside the resolved playlist first; fall through to
    // next saved-list entry once playlist is exhausted.
    if (nativeCurrent && nativeCurrent.playlist_items && nativeCurrent.playlist_idx + 1 < nativeCurrent.playlist_items.length) {
      nativePlayPlaylistIndex(nativeCurrent.playlist_idx + 1);
      return;
    }
    var idx = nativeSavedIndex();
    if (idx >= 0 && idx + 1 < savedList.length) loadSavedItem(savedList[idx + 1]);
    return;
  }
  if (activePlayer === 0) {
    var idx = nativeSavedIndex();
    if (idx >= 0 && idx + 1 < savedList.length) { loadSavedItem(savedList[idx + 1]); return; }
    ytCmd('nextVideo');
  }
  else if (scWidget) scWidget.next();
  else console.warn('scNext: no handler');
}

// Resolve a specific track inside the current playlist and play it.
// Reuses the unlock state of nativeAudio; no fresh gesture needed because
// audio element is already engaged from the parent loadSavedItem click.
async function nativePlayPlaylistIndex(idx) {
  if (!nativeCurrent || !nativeCurrent.playlist_items) return;
  if (idx < 0 || idx >= nativeCurrent.playlist_items.length) return;
  var entry = nativeCurrent.playlist_items[idx];
  if (!entry || !entry.url) return;
  console.log('native: playlist jump idx=' + idx + ' url=' + entry.url);
  try {
    var r = await fetch('/api/stream/resolve?url=' + encodeURIComponent(entry.url));
    if (!r.ok) {
      console.warn('native: playlist resolve http ' + r.status);
      return;
    }
    var d = await r.json();
    if (!d || !d.stream_url) {
      console.warn('native: playlist resolve no stream_url');
      return;
    }
    var audio = ensureNativeAudio();
    audio.loop = false;
    audio.src = d.stream_url;
    nativeCurrent.playlist_idx = idx;
    nativeCurrent.resolved_at = Date.now();
    nativeCurrent.expires_at = d.expires_at ? d.expires_at * 1000 : (Date.now() + 240 * 1000);
    var titleEl = document.getElementById('sc-track-title');
    if (titleEl) titleEl.textContent = cleanTitle(d.title || entry.title || '');
    if (d.thumbnail || entry.thumbnail) {
      var art = document.getElementById('sc-art');
      if (art) {
        art.classList.remove('yt-icon');
        art.style.background = '';
        art.src = d.thumbnail || entry.thumbnail;
      }
    }
    try {
      var p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function(e) { console.warn('native: playlist play() rejected:', e && e.message); });
      }
    } catch(e) { console.warn('native: playlist play() threw:', e); }
  } catch(e) {
    console.warn('native: playlist resolve threw:', e && e.message);
  }
}

document.getElementById('sc-prog').addEventListener('click', e => {
  const pct = e.offsetX / e.currentTarget.offsetWidth;
  if (activePlayer === 3 && nativeAudio && nativeAudio.duration && isFinite(nativeAudio.duration)) {
    try { nativeAudio.currentTime = nativeAudio.duration * pct; } catch(err) {}
    return;
  }
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

let ytVideoData = null;
function ytApplyVideoData(vd) {
  if (!vd) return;
  ytVideoData = vd;
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
  // Diagnostic: surface YT-side messages even when activePlayer != 0 so we
  // can see whether iframe responds to the listening handshake at all.
  if (typeof e.data === 'string' && e.origin && /youtube(-nocookie)?\.com$/.test(new URL(e.origin).hostname)) {
    console.log('YT msg:', e.data.slice(0, 240));
  }
  if (activePlayer !== 0) return;
  try {
    const d = JSON.parse(typeof e.data === 'string' ? e.data : '{}');
    if (d.event === 'onStateChange') {
      ytPlaying = d.info === 1;
      setBarPlayPauseIcon(ytPlaying);
    }
    if (d.event === 'infoDelivery' && d.info) {
      // YT nocookie embed pipes playerState through infoDelivery.info
      // instead of a separate onStateChange event. State codes:
      // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
      if (typeof d.info.playerState !== 'undefined') {
        var playing = d.info.playerState === 1;
        if (playing !== ytPlaying) {
          ytPlaying = playing;
          setBarPlayPauseIcon(ytPlaying);
        }
      }
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
  if (/music\.yandex\.(ru|com|by|kz|uz)/.test(url)) return 'yandex_music';
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

async function addToSaved(url, overrideTitle) {
  url = await resolveUrl(url);
  const service = detectService(url);
  if (!service) return;
  if (service === 'soundcloud' && SC_UNSUPPORTED.test(url)) return;
  const meta = await fetchMeta(url);
  const existing = savedList.findIndex(i => i.url === url);
  if (existing >= 0) { savedList.splice(existing, 1); }
  const title = (overrideTitle && overrideTitle.trim()) ? overrideTitle.trim() : meta.title;
  savedList.unshift({ id: Date.now(), url, service, title: title, thumbnail: meta.thumbnail });
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

// ─── NATIVE AUDIO SHIM (yt-dlp resolver -> <audio>) ────────────────────────
// Resolver runs on a sibling port (:8083). Kiosk hits a same-origin path on
// :8080 which panel.app proxies into 127.0.0.1:8083. The proxy must run with
// trust_env=False because the host has HTTP_PROXY=http://127.0.0.1:2080
// (Throne) which would otherwise hijack the loopback call and return 502.
let nativeAudio = null;
let nativeCurrent = null;     // { url, item, resolved_at, expires_at }
let nativeReresolveTimer = null;

var ICON_PLAY  = '<svg viewBox="0 0 24 24" width="60%" height="60%" fill="#000" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
var ICON_PAUSE = '<svg viewBox="0 0 24 24" width="60%" height="60%" fill="#000" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
function setBarPlayPauseIcon(playing) {
  var el = document.getElementById('sc-playpause');
  if (el) el.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
}

function ensureNativeAudio() {
  if (nativeAudio) return nativeAudio;
  nativeAudio = document.createElement('audio');
  nativeAudio.id = 'native-audio';
  nativeAudio.preload = 'auto';
  // No crossOrigin — SoundCloud cf-media.sndcdn.com signed URLs don't return
  // CORS headers, and `anonymous` then makes Bromite reject the source with
  // MediaError.code=4 (MEDIA_ELEMENT_ERROR_SRC_NOT_SUPPORTED). Plain audio
  // playback works without CORS; we don't need WebAudio analysis here.
  nativeAudio.style.display = 'none';
  document.body.appendChild(nativeAudio);
  nativeAudio.addEventListener('play', function() {
    console.log('native: play');
    if (activePlayer === 3) setBarPlayPauseIcon(true);
  });
  nativeAudio.addEventListener('pause', function() {
    console.log('native: pause');
    if (activePlayer === 3) setBarPlayPauseIcon(false);
  });
  nativeAudio.addEventListener('timeupdate', function() {
    if (activePlayer !== 3) return;
    var dur = nativeAudio.duration;
    var cur = nativeAudio.currentTime;
    if (dur && isFinite(dur)) {
      var pct = (cur / dur) * 100;
      var fill = document.getElementById('sc-prog-fill');
      if (fill) fill.style.width = pct + '%';
      var curEl = document.getElementById('sc-time-cur');
      var durEl = document.getElementById('sc-time-dur');
      if (curEl) curEl.textContent = scFmtTime(cur * 1000);
      if (durEl) durEl.textContent = scFmtTime(dur * 1000);
    }
  });
  nativeAudio.addEventListener('error', function() {
    var err = nativeAudio.error;
    console.warn('native: error code=' + (err && err.code), 'src=' + nativeAudio.currentSrc);
    if (!nativeCurrent || !nativeCurrent.item) return;
    // Limit re-resolve cascades: only one retry per item per error window
    // to avoid endless loops when the source URL itself is broken / unsupported.
    var now = Date.now();
    if (nativeCurrent._errRetryAt && (now - nativeCurrent._errRetryAt) < 30000) {
      console.warn('native: error retry suppressed (cooldown)');
      return;
    }
    nativeCurrent._errRetryAt = now;
    // Re-resolve src but respect pause state — never autoplay on error.
    nativeReresolveAndPlay(nativeCurrent.item, true, true);
  });
  nativeAudio.addEventListener('ended', function() {
    console.log('native: ended');
    if (activePlayer === 3) setBarPlayPauseIcon(false);
    // 1) Walk forward inside the resolved playlist if there are still
    //    unplayed items.
    if (nativeCurrent && nativeCurrent.playlist_items && nativeCurrent.playlist_idx + 1 < nativeCurrent.playlist_items.length) {
      console.log('native: advancing inside playlist to idx=' + (nativeCurrent.playlist_idx + 1));
      nativePlayPlaylistIndex(nativeCurrent.playlist_idx + 1);
      return;
    }
    // 2) Otherwise jump to the next saved-list entry.
    if (typeof savedList !== 'undefined' && savedList.length && currentSavedUrl) {
      var idx = savedList.findIndex(function(it) { return it.url === currentSavedUrl; });
      if (idx >= 0 && idx + 1 < savedList.length) {
        console.log('native: advancing to next saved item idx=' + (idx + 1));
        loadSavedItem(savedList[idx + 1]);
      }
    }
  });
  return nativeAudio;
}

function nativeStop() {
  if (!nativeAudio) return;
  try { nativeAudio.pause(); } catch(e) {}
  nativeAudio.removeAttribute('src');
  try { nativeAudio.load(); } catch(e) {}
  nativeCurrent = null;
  if (nativeReresolveTimer) { clearTimeout(nativeReresolveTimer); nativeReresolveTimer = null; }
  setBarPlayPauseIcon(false);
}

async function nativeReresolveAndPlay(item, isRetry, respectPauseState) {
  try {
    var r = await fetch('/api/stream/resolve?url=' + encodeURIComponent(item.url));
    if (!r.ok) {
      console.warn('native: resolve http ' + r.status);
      return false;
    }
    var d = await r.json();
    if (!d || !d.stream_url) {
      console.warn('native: resolve no stream_url', d && d.error);
      return false;
    }
    console.log('native: resolve ok', d.title || item.url, d.is_playlist ? ('(playlist ' + (d.items ? d.items.length : 0) + ' items)') : '');
    var audio = ensureNativeAudio();
    // Capture pause state BEFORE src swap so pre-emptive re-resolve does not
    // unpause a track the user explicitly paused.
    var wasPaused = audio.paused;
    var prevTime = audio.currentTime;
    // Turn off the unlock loop before swapping to the real stream URL,
    // otherwise the track would loop forever at end.
    audio.loop = false;
    audio.src = d.stream_url;
    activePlayer = 3;
    nativeCurrent = {
      url: item.url,
      item: item,
      resolved_at: Date.now(),
      expires_at: d.expires_at ? d.expires_at * 1000 : (Date.now() + 240 * 1000),
      // Playlist navigation: when streaming returns is_playlist + items,
      // keep the items array and current index so scPrev/scNext can walk
      // tracks INSIDE the playlist, not just jump between saved-list entries.
      playlist_items: (d.is_playlist && Array.isArray(d.items)) ? d.items : null,
      playlist_idx: 0,
    };
    if (d.title) document.getElementById('sc-track-title').textContent = cleanTitle(d.title);
    if (d.thumbnail) {
      var art = document.getElementById('sc-art');
      if (art) {
        // Prefer JPG over WEBP — Bromite v108 sometimes fails on i.ytimg.com webp.
        // If the saved-list item already gave us a JPG thumbnail, keep that.
        var dt = d.thumbnail;
        var itemThumb = item && item.thumbnail;
        var keepItemThumb = itemThumb && /\.jpg(\?|$)/i.test(itemThumb) && /\.webp(\?|$)/i.test(dt);
        if (!keepItemThumb) {
          art.classList.remove('yt-icon');
          art.style.background = '';
          art.src = dt;
          art.onerror = function() {
            // Last-ditch: if webp/jpg fails, fall back to vi/{id}/mqdefault.jpg
            this.onerror = null;
            if (item && item.url) {
              var vm = item.url.match(/[?&]v=([^&#]+)/) || item.url.match(/youtu\.be\/([^?&#]+)/);
              if (vm) { this.src = 'https://i.ytimg.com/vi/' + vm[1] + '/hqdefault.jpg'; return; }
            }
            this.src = '';
            this.classList.add('yt-icon');
          };
        }
      }
    }
    if (respectPauseState && wasPaused) {
      console.log('native: re-resolve skipped autoplay — user paused');
      // Restore position if we have a non-zero prevTime, since src swap reset it.
      if (prevTime > 0) {
        var restorePos = function() { try { audio.currentTime = prevTime; } catch(_) {} audio.removeEventListener('loadedmetadata', restorePos); };
        audio.addEventListener('loadedmetadata', restorePos);
      }
    } else {
      try {
        // Must be called synchronously in the click-gesture chain on first hit.
        var p = audio.play();
        if (p && typeof p.catch === 'function') {
          p.catch(function(e) { console.warn('native: play() rejected:', e && e.message); });
        }
      } catch(e) {
        console.warn('native: play() threw:', e);
      }
    }
    // Schedule a pre-emptive re-resolve ~30s before expiry. Pass
    // respectPauseState=true so the timer does NOT unpause user-paused tracks.
    if (nativeReresolveTimer) clearTimeout(nativeReresolveTimer);
    var leadMs = Math.max(30 * 1000, (nativeCurrent.expires_at - Date.now()) - 30 * 1000);
    nativeReresolveTimer = setTimeout(function() {
      if (nativeCurrent && nativeCurrent.item === item) {
        console.log('native: pre-emptive re-resolve');
        nativeReresolveAndPlay(item, false, true);
      }
    }, leadMs);
    return true;
  } catch(e) {
    console.warn('native: resolve threw:', e && e.message);
    return false;
  }
}

async function tryNativePlay(item) {
  // All known services use their own iframe widget for the visual UI.
  // YouTube embed shows the video poster + player chrome; SC/SP/Yandex
  // render full widgets with art and track lists. Native audio left only
  // black sound with no picture — confusing on a wall panel.
  return false;
}

// Silent WAV used to "unlock" the <audio> element during the click gesture.
// Chrome / Bromite require audio.play() to be invoked inside a user-gesture
// handler. The async resolve breaks the gesture chain, so the real play()
// later gets rejected with "user didn't interact". We start a synchronous
// muted play of this empty WAV first, which arms the audio element for
// subsequent src swaps without needing another gesture.
// 200ms silent WAV (8kHz mono 8-bit). Plays in a loop while resolve happens
// so the audio element stays ACTIVELY PLAYING through the async window.
// First-time play() must be inside the click gesture; once playback has
// started, subsequent src swaps + play() calls don't need a fresh gesture.
var NATIVE_UNLOCK_WAV = 'data:audio/wav;base64,UklGRmQGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YUAGAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
var nativeUnlocked = false;

function nativePrimeForGesture() {
  if (nativeUnlocked) return;
  var audio = ensureNativeAudio();
  // Muted + zero-volume so the silent WAV never competes for Android audio
  // focus with the iframe widgets. The point is *only* to consume the
  // user-gesture token inside a real audio.play() call — once Chromium has
  // registered that, subsequent iframe .play() calls inherit the unlocked
  // state on the page session.
  try {
    audio.muted = true;
    audio.volume = 0;
    audio.src = NATIVE_UNLOCK_WAV;
    audio.loop = true;
    var p = audio.play();
    if (p && typeof p.then === 'function') {
      p.then(function() {
        nativeUnlocked = true;
        console.log('native: unlocked (muted-only)');
      }).catch(function(e) {
        console.warn('native: unlock play rejected:', e && e.message);
      });
    } else {
      nativeUnlocked = true;
    }
  } catch(e) {
    console.warn('native: unlock threw:', e && e.message);
  }
}

function applySavedItemBarPreview(item) {
  // SYNC update of track-title + art from the saved-list item so the UI
  // doesn't keep the previous item's image while async resolve runs.
  // Async paths overwrite later with real metadata when it arrives.
  var art = document.getElementById('sc-art');
  var titleEl = document.getElementById('sc-track-title');
  var artistEl = document.getElementById('sc-track-artist');
  if (titleEl) titleEl.textContent = cleanTitle(item.title || '');
  if (artistEl) artistEl.textContent = '';
  if (!art) return;
  // reset
  art.classList.remove('yt-icon');
  art.style.background = '';
  art.removeAttribute('src');
  if (item.thumbnail) {
    art.src = item.thumbnail;
    art.onerror = function() {
      this.onerror = null;
      // Fall back to the canonical YT thumbnail URL (works through tinyproxy/Throne).
      var vm = (item.url || '').match(/[?&]v=([^&#]+)/) || (item.url || '').match(/youtu\.be\/([^?&#]+)/);
      if (vm && item.service === 'youtube') {
        this.src = 'https://i.ytimg.com/vi/' + vm[1] + '/hqdefault.jpg';
      } else {
        this.removeAttribute('src');
        this.classList.add('yt-icon');
      }
    };
  } else if (item.service === 'youtube') {
    var m1 = (item.url || '').match(/youtu\.be\/([^?&#]+)/);
    var m2 = (item.url || '').match(/[?&]v=([^&#]+)/);
    var vid = m1 ? m1[1] : (m2 ? m2[1] : null);
    if (vid) {
      art.src = 'https://img.youtube.com/vi/' + vid + '/mqdefault.jpg';
    } else {
      art.classList.add('yt-icon');
    }
  } else if (item.service === 'yandex_music') {
    // Yandex album/track id → mqdefault thumbnail via their CDN. Best-effort.
    art.classList.add('yt-icon');
    art.style.background = '#fc3f1d';
  } else if (item.service === 'spotify') {
    art.style.background = '#1db954';
  } else {
    art.classList.add('yt-icon');
  }
}

function loadSavedItem(item) {
  console.log('loadSavedItem:', item.service, item.url);
  openMediaPanel();
  hideSavedPanel();
  currentSavedUrl = item.url;
  renderSavedList();
  // Mirror highlight onto any matching search-result card so user sees
  // which result is currently playing.
  try { applySearchActive(item.url); } catch(_) {}

  // SYNC: instant UI update so the bar shows the new item's art/title even
  // before resolve finishes. Otherwise the bar keeps the previous item.
  applySavedItemBarPreview(item);

  // Prime native audio (muted + volume 0) inside the user-gesture window
  // so subsequent iframe .play() calls inherit the unlocked-page state.
  // Without this, Bromite's autoplay policy kicks the SC widget after a
  // few seconds (no gesture seen inside the iframe). Muted prime no
  // longer steals audio focus because volume=0 and muted=true.
  nativePrimeForGesture();
  loadSavedItemIframe(item);
}

function loadSavedItemIframe(item) {
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
    // For single-video URLs append &list=RD<vid> to spawn a YouTube Mix
    // playlist (auto-DJ): autoplay-next picks similar music tracks. Mix
    // lives as long as the seed video isn't deleted/private.
    // Explicit playlist URLs (m3) keep their own list, no Mix wrapping.
    if (m3) document.getElementById('yt-frame').src = 'https://www.youtube-nocookie.com/embed/videoseries?list=' + m3[1] + '&autoplay=1&enablejsapi=1';
    else if (m1) document.getElementById('yt-frame').src = 'https://www.youtube-nocookie.com/embed/' + m1[1] + '?list=RD' + m1[1] + '&autoplay=1&enablejsapi=1';
    else if (m2) document.getElementById('yt-frame').src = 'https://www.youtube-nocookie.com/embed/' + m2[1] + '?list=RD' + m2[1] + '&autoplay=1&enablejsapi=1';
  } else if (item.service === 'soundcloud') {
    setMediaTab(1);
    scLoadInWidget(item.url);
  } else if (item.service === 'spotify') {
    setMediaTab(2);
    const embedUrl = item.url.replace('open.spotify.com/', 'open.spotify.com/embed/');
    document.getElementById('sp-frame').src = embedUrl + (embedUrl.includes('?') ? '&' : '?') + 'utm_source=generator&theme=0';
  } else if (item.service === 'yandex_music' || item.service === 'yandex-music') {
    setMediaTab(0);
    if (item.title) document.getElementById('sc-track-title').textContent = cleanTitle(item.title);
    const trk = item.url.match(/track\/(\d+)/);
    const alb = item.url.match(/album\/(\d+)/);
    const frame = document.getElementById('yt-frame');
    if (trk && alb) {
      frame.src = 'https://music.yandex.ru/iframe/#track/' + trk[1] + '/' + alb[1];
    } else if (alb) {
      frame.src = 'https://music.yandex.ru/iframe/#album/' + alb[1];
    } else {
      frame.src = '';
      console.warn('Yandex Music URL has no track/album ID:', item.url);
    }
  } else {
    console.warn('Unknown service:', item.service, 'for url:', item.url);
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
          await addToSaved(pd.url, pd.title);
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

// ─── SEARCH (YT Data API music search) ──────────────────────────────────────
function toggleSearchInput() {
  console.log('toggleSearchInput called');
  var row = document.getElementById('saved-search-row');
  var open = row.classList.toggle('show');
  if (open) {
    var inp = document.getElementById('saved-search-input');
    inp.value = '';
    inp.focus();
  } else {
    document.getElementById('search-results').innerHTML = '';
  }
}

async function searchSubmit() {
  var inp = document.getElementById('saved-search-input');
  var q = (inp.value || '').trim();
  console.log('searchSubmit q=' + JSON.stringify(q));
  if (!q) return;
  var results = document.getElementById('search-results');
  results.innerHTML = '<div class="search-status">ищу...</div>';
  try {
    var r = await fetch('/api/search?q=' + encodeURIComponent(q));
    var d = await r.json();
    if (!d || !d.results || !d.results.length) {
      results.innerHTML = '<div class="search-status">ничего не нашлось'
        + (d && d.error ? ' (' + d.error + ')' : '') + '</div>';
      return;
    }
    results.innerHTML = '';
    var cards = [];
    d.results.forEach(function (it) {
      var card = document.createElement('div');
      card.className = 'search-item search-item-probing';
      card.dataset.vid = it.id;
      var title = (it.title || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      card.innerHTML =
        '<img class="search-thumb" src="' + (it.thumbnail || '') + '" alt="">' +
        '<div class="search-meta">' +
          '<div class="search-title">' + escapeHtml(title) + '</div>' +
          '<div class="search-channel">' + escapeHtml(it.channel || '') + '</div>' +
        '</div>' +
        '<button class="search-btn search-save" title="В сохранёнки">＋</button>';
      card.addEventListener('click', function () {
        loadSavedItem({ url: it.url, service: 'youtube', title: title, thumbnail: it.thumbnail });
        applySearchActive(it.url);
      });
      var saveBtn = card.querySelector('.search-save');
      saveBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        addToSaved(it.url, title);
      });
      results.appendChild(card);
      cards.push({ vid: it.id, el: card });
    });
    // Stage B: device-side iframe probe. Cheap server filter missed some
    // (e.g. PSY plays on most devices but blocks on others). Probe each
    // result with a hidden iframe — if the YT player emits onError (codes
    // 101/150 = embed disabled, 100 = removed/private, 5 = HTML5 error)
    // we drop the card from the list. Cache results per video id in
    // localStorage for 24h.
    cards.forEach(function (c) { probeEmbeddable(c.vid, c.el); });
  } catch (e) {
    results.innerHTML = '<div class="search-status">ошибка: ' + (e && e.message) + '</div>';
  }
}

var YT_PROBE_CACHE_KEY = 'yt_probe_cache_v1';
var YT_PROBE_TTL_MS = 24 * 3600 * 1000;
function getProbeCache() {
  try { return JSON.parse(localStorage.getItem(YT_PROBE_CACHE_KEY) || '{}'); }
  catch(_) { return {}; }
}
function setProbeCache(c) {
  try { localStorage.setItem(YT_PROBE_CACHE_KEY, JSON.stringify(c)); } catch(_) {}
}

function probeEmbeddable(vid, cardEl) {
  if (!vid || !cardEl) return;
  var cache = getProbeCache();
  var entry = cache[vid];
  var now = Date.now();
  if (entry && (now - entry.t) < YT_PROBE_TTL_MS) {
    if (entry.playable === false) cardEl.remove();
    else cardEl.classList.remove('search-item-probing');
    return;
  }
  // Create off-screen iframe with autoplay=0 so it doesn't fight for focus.
  var probe = document.createElement('iframe');
  probe.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:200px;height:120px;border:0;visibility:hidden';
  probe.setAttribute('allow', 'autoplay; encrypted-media');
  // listen for onError before src is set to avoid race
  var resolved = false;
  function finish(playable, reason) {
    if (resolved) return;
    resolved = true;
    window.removeEventListener('message', handler);
    try { probe.remove(); } catch(_) {}
    var cache2 = getProbeCache();
    cache2[vid] = { playable: playable, t: now, r: reason || '' };
    setProbeCache(cache2);
    if (!playable) {
      console.warn('search probe drop', vid, reason);
      cardEl.remove();
    } else {
      cardEl.classList.remove('search-item-probing');
    }
  }
  function handler(e) {
    if (!e || typeof e.data !== 'string') return;
    // Only react to messages from THIS probe iframe — without this every
    // onError from the main #yt-frame would also fire all in-flight probes.
    if (e.source !== probe.contentWindow) return;
    if (!e.origin || !/youtube(-nocookie)?\.com$/.test(new URL(e.origin).hostname)) return;
    try {
      var d = JSON.parse(e.data);
      if (d.event === 'onError') {
        finish(false, 'onError-' + d.info);
      } else if (d.event === 'onStateChange' || (d.event === 'infoDelivery' && d.info && typeof d.info.playerState !== 'undefined')) {
        finish(true, 'ok');
      } else if (d.event === 'initialDelivery' && d.info && d.info.videoData && d.info.videoData.errorCode) {
        finish(false, 'errorCode-' + d.info.videoData.errorCode);
      }
    } catch(_) {}
  }
  window.addEventListener('message', handler);
  document.body.appendChild(probe);
  probe.src = 'https://www.youtube-nocookie.com/embed/' + vid + '?autoplay=0&enablejsapi=1';
  // After src is set, request listening so YT iframe starts emitting events.
  probe.addEventListener('load', function () {
    try {
      probe.contentWindow.postMessage(JSON.stringify({event:'listening', id:1, channel:'widget'}), '*');
    } catch(_) {}
  });
  // 4s timeout — if YT didn't say onError nor onStateChange, assume playable.
  setTimeout(function () { finish(true, 'timeout'); }, 4000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function applySearchActive(activeUrl) {
  var cards = document.querySelectorAll('#search-results .search-item');
  cards.forEach(function (el) {
    var btn = el.querySelector('.search-save');
    // url is stored on the click handler closure; reconstruct from data-vid
    var vid = el.dataset.vid;
    var url = 'https://www.youtube.com/watch?v=' + vid;
    el.classList.toggle('active', url === activeUrl);
  });
}

document.addEventListener('DOMContentLoaded', function () {
  var inp = document.getElementById('saved-search-input');
  if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') searchSubmit(); });
});

// ─── SAVE-CURRENT-TRACK button (next to #sc-track-title) ────────────────────
function getCurrentPlayingItem() {
  // 1) YT iframe — track via ytVideoData captured from infoDelivery
  if (activePlayer === 0 && typeof ytVideoData !== 'undefined' && ytVideoData && ytVideoData.video_id) {
    return {
      url: 'https://www.youtube.com/watch?v=' + ytVideoData.video_id,
      title: ytVideoData.title || '',
      thumbnail: 'https://i.ytimg.com/vi/' + ytVideoData.video_id + '/hqdefault.jpg',
      service: 'youtube',
    };
  }
  // 2) SC widget — getCurrentSound is async, this path returns a promise then
  return null;
}

function saveCurrentTrack() {
  // YT branch — sync via ytVideoData
  var item = getCurrentPlayingItem();
  if (item && item.url) {
    addToSaved(item.url, item.title);
    return;
  }
  // SC branch — pull via widget API
  if (activePlayer === 1 && scWidget && typeof scWidget.getCurrentSound === 'function') {
    try {
      scWidget.getCurrentSound(function (sound) {
        if (!sound || !sound.permalink_url) return;
        addToSaved(sound.permalink_url, sound.title || '');
      });
      return;
    } catch (e) { console.warn('saveCurrentTrack SC threw:', e && e.message); }
  }
  console.warn('saveCurrentTrack: nothing to save (activePlayer=' + activePlayer + ')');
}
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

// ─── AUTO-RELOAD ON SERVER CHANGES ──────────────────────────────────────────
// Poll /api/version every 60s. If app.js mtime changed on the server, the
// wall panel is running stale JS — reload to pick up the new bundle.
// Bromite and other aggressive HTML5 caches refuse to re-fetch index.html
// for an open SPA tab on their own, so this is the only reliable way to
// roll out a deploy without manual force-reload.
(function () {
  // Track app_js, app_css, index_html — any of them can change in a deploy
  // (CSS-only or HTML-only deploys are common), so polling needs to react
  // to all three otherwise stale tabs keep running outdated assets.
  var boot = { js: null, css: null, html: null };
  fetch('/api/version').then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d) return;
      boot.js = d.app_js; boot.css = d.app_css; boot.html = d.index_html;
    })
    .catch(function () {});
  setInterval(function () {
    fetch('/api/version').then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d) return;
        var changed =
          (boot.js && d.app_js && d.app_js !== boot.js) ||
          (boot.css && d.app_css && d.app_css !== boot.css) ||
          (boot.html && d.index_html && d.index_html !== boot.html);
        if (changed) {
          console.log('panel updated server-side, reloading',
            'js', boot.js, '→', d.app_js,
            'css', boot.css, '→', d.app_css,
            'html', boot.html, '→', d.index_html);
          location.reload();
        }
      })
      .catch(function () {});
  }, 60000);
})();

// ─── CONSOLE TOGGLE IN MENU (logged-in only) ────────────────────────────────
(function () {
  function ready(cb){ if (document.readyState !== 'loading') cb(); else document.addEventListener('DOMContentLoaded', cb); }
  ready(function () {
    var input = document.getElementById('console-toggle-input');
    if (!input) return;
    input.checked = window._lisaConsoleEnabled && window._lisaConsoleEnabled();
    input.addEventListener('change', function () {
      window._lisaSetConsoleEnabled(this.checked);
    });
  });
})();
