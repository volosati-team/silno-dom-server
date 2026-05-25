(function () {
  var slBrightness = document.getElementById('sl-brightness');
  var slNight = document.getElementById('sl-night');
  var cbNight = document.getElementById('cb-night');
  var valBrightness = document.getElementById('val-brightness');
  var valNight = document.getElementById('val-night');
  var btStatus = document.getElementById('bt-status');

  var saveTimer = null;

  function load() {
    fetch('/api/display/settings')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        slBrightness.value = d.brightness != null ? d.brightness : 100;
        slNight.value = d.night_dim != null ? d.night_dim : 50;
        cbNight.checked = d.enabled !== false;
        updateLabels();
      })
      .catch(function () {});
  }

  function updateLabels() {
    valBrightness.textContent = slBrightness.value + '%';
    valNight.textContent = slNight.value + '%';
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }

  function save() {
    fetch('/api/display/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brightness: parseInt(slBrightness.value, 10),
        night_dim: parseInt(slNight.value, 10),
        enabled: cbNight.checked
      })
    }).catch(function () {});
  }

  slBrightness.addEventListener('input', function () { updateLabels(); scheduleSave(); });
  slNight.addEventListener('input', function () { updateLabels(); scheduleSave(); });
  cbNight.addEventListener('change', function () { scheduleSave(); });

  function checkBtAgent() {
    fetch('http://localhost:8765/bt-status', { signal: AbortSignal.timeout(2000) })
      .then(function (r) { return r.json(); })
      .then(function () {
        btStatus.textContent = 'запущен';
        btStatus.className = 'adm-status online';
      })
      .catch(function () {
        btStatus.textContent = 'не запущен';
        btStatus.className = 'adm-status offline';
      });
  }

  load();
  checkBtAgent();
  initPasswordSection();
})();

function initPasswordSection() {
  var btn = document.getElementById('change-pw-btn');
  if (!btn) return;
  var u = null;
  try { u = JSON.parse(sessionStorage.getItem('sdom_u')); } catch(e) {}
  if (!u || u.name === 'dev') {
    btn.disabled = true;
    document.getElementById('old-pass').disabled = true;
    document.getElementById('new-pass').disabled = true;
    var hint = document.getElementById('pw-result');
    if (hint) hint.textContent = 'dev-юзер: пароль не меняется';
  }
}

function changePassword() {
  var u = null;
  try { u = JSON.parse(sessionStorage.getItem('sdom_u')); } catch(e) {}
  if (!u || u.name === 'dev') return;
  var oldPass = document.getElementById('old-pass').value;
  var newPass = document.getElementById('new-pass').value;
  var result = document.getElementById('pw-result');
  result.textContent = '…';
  result.style.color = '';
  fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u.name, old_password: oldPass, new_password: newPass })
  }).then(function(r) { return r.json(); })
  .then(function(d) {
    if (d.ok) {
      result.textContent = 'Пароль изменён ✓';
      result.style.color = 'var(--yellow)';
      document.getElementById('old-pass').value = '';
      document.getElementById('new-pass').value = '';
    } else {
      result.textContent = d.error === 'wrong_password' ? 'Неверный текущий пароль' : 'Ошибка';
      result.style.color = '#cc6666';
    }
  }).catch(function() {
    result.textContent = 'Ошибка подключения';
    result.style.color = '#cc6666';
  });
}
