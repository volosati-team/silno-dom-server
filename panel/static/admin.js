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
})();
