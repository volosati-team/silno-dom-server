# Stable panel state — 2026-05-23 evening

Git tag: `panel-stable-2026-05-23-evening` (commit `78b0d1f`).

Ветка `feat/saved-panel-search` (после `78b0d1f`) добавляет: YT Mix
autoplay, music search через YT Data API, save-current-track, увеличенный
saved-panel UI, фильтр embed-restricted, AGENT_LIGHT_API.md для внешних
агентов. См. секцию «Branch additions» внизу.

## Что работает

**SC (SoundCloud):**
- Тап saved-item с SC URL → автоплей через `scFrame.src = ... auto_play=true ...` (URL-навигация iframe).
- Переключение между SC saved-items → autoplay через `scWidget.load()` + event-driven forcePlay (`LOAD_PROGRESS` или `.load()`-callback, fallback timeout 2500ms).
- Bar play/pause/next/prev отзываются на загруженном треке.
- `setShuffle`/`setRepeat` обёрнуты в `safeWidgetCall` — silently no-op если SC widget API их убрал.
- `scIsPlaying` синхронно сбрасывается при load нового URL — UI не показывает ложное «играет» во время догрузки.

**YT (YouTube nocookie embed):**
- Тап saved-item YT URL → autoplay через `scFrame.src = youtube-nocookie.com/embed/<id>?autoplay=1&enablejsapi=1` (URL-навигация iframe).
- Iframe handshake `{event:'listening', id:1, channel:'widget'}` + строковая копия — после `load` event на iframe.
- Bar play/pause бинд: читаем `playerState` из `infoDelivery.info.playerState`
  (codes: 1=playing, 2=paused, 0=ended, 3=buffering, 5=cued). YT nocookie
  **не шлёт** отдельный `onStateChange` event — всё через `infoDelivery`.
- Progress bar (duration + currentTime).
- Bar prev/next ходят по savedList когда YT-iframe single-video.

**Bromite / Android setup (обязательно):**
- `chrome://flags/#autoplay-policy = No user gesture is required` — без этого
  ни SC ни YT iframe не auto-play на cold start.

**Auto-reload polling:**
- JS каждые 60с дёргает `/api/version` и сравнивает mtime для `app_js`,
  `app_css`, `index_html`. Любая правка триггерит `location.reload()` без
  ручного refresh.

**Cache-busting:**
- Сервер при serve `/` подставляет `app.css?v=<mtime>` и `app.js?v=<mtime>`
  → Bromite видит новый URL при reload и тянет свежий asset.
- HTTP заголовки: `Cache-Control: no-store, no-cache, must-revalidate,
  max-age=0` + `Pragma: no-cache` + `Expires: 0` — bypass Bromite bfcache.

**UI:**
- Кнопки бара (.sc-btn / #sc-playpause) увеличены ×2 для wall panel.
- Иконки play/pause через SVG (чёрные на жёлтом, без шрифт-fallback зависимостей).
- Empty-screen fallback: при `closeMediaPanel()` открывается last active zone
  (или yard по дефолту).
- Console: hidden по умолчанию, toggle через `#menu-console-toggle` в menu
  для зарегистрированных. Layout: top=var(--hh), bottom=96px, z-index=170
  (под menu=310, над sc-controls=160).
- Меню-ссылки (Аккаунты/Автоматика/Лог/Система) открываются в новой вкладке.
- Add-from-phone: `+` в saved-panel вызывает QR-модал.
  guest.html имеет optional title input.

**Backend:**
- `/api/version` отдаёт mtime для всех трёх assets.
- `/api/guest-submit` принимает optional `title` поле, прокидывает дальше
  через KV в `/api/guest-poll`.

**Diagnostic:**
- `console.log` теперь тоже летит в server-side dbg-log uploader (раньше
  только warn/error).
- YT diagnostic: все входящие messages с YouTube origin логируются (для
  будущей диагностики).

## Открытые задачи

1. **SC polling-retry** вместо фиксированного 2500ms timeout. Сейчас задержка
   при cold start иногда >2.5с — пользователь застревает. План в
   `NOTES_autoplay_switch.md`: switch на retry через `getCurrentSound` poll
   ~400ms × 4-5 попыток + всплывашка при отказе.

2. **Громкость popup-slider** UI в стиле Telegram-голосовых: тап на иконку
   динамика → vertical slider, повторный тап = mute, auto-hide через 2-3с.
   z-index over menu.

3. **YT music filter** — обсудим следующим этапом. Цель: чтобы YT-iframe
   autoplay-next не подсовывал немузыкальные ролики.

## Известные ограничения

- Не работает с label-locked YT видео (Smashing, Despacito, PSY) — embed
  blocked правообладателем. Сохранены в `NOTES_embed_restricted.md`.
  Бэкенд `/api/search` теперь фильтрует такие через `videos.list?part=status`
  — non-embeddable дальше во фронт не уходят.
- Без `chrome://flags/#autoplay-policy = No user gesture` — autoplay
  Bromite режет в iframe-context.

## Branch additions (`feat/saved-panel-search`, after `78b0d1f`)

Не в main пока. Что добавляет ветка:

**YT Mix autoplay (commit `86ff312`):** single-видео URL'ы при тапе
оборачиваются в `?list=RD<vid>` — YouTube Mix-плейлист. Autoplay-next
играет похожую музыку, пока seed-видео живо.

**Music search через YT Data API (commits `6c75f76` → `933707e` →
`6dd7857` → `0aa7873`):**
- Backend `/api/search?q=...&src=youtube` дёргает `search.list`
  (`videoCategoryId=10` = Music) + second-pass `videos.list?part=status`
  для отсечки non-embeddable и non-public. Возвращает
  `{results:[{id,url,service,title,channel,thumbnail}], dropped}`.
- Frontend: SVG-лупа в `#saved-panel-hdr` справа от `+` → inline
  search-row. Печатаешь запрос → Enter (или `→`) → результаты в
  `#search-results` карточками. Тап по карточке = играть в текущей
  панели. Кнопка `＋` справа на карточке = добавить в saved-list.
- API key: `YOUTUBE_API_KEY` в `.env` (см. `NOTES_migration.md`).

**Save-current-track (commit `6dd7857` ×2 size):** кнопка `＋` рядом с
`#sc-track-title` в баре. Тап = сохранить текущий играющий трек в
saved-list. Для YT берёт `ytVideoData.video_id` (теперь хранится как
глобал из `infoDelivery`). Для SC — `scWidget.getCurrentSound()`.

**Saved-panel UI bump:**
- `#saved-panel` 200px → 600px (×3 — wall panel удобство)
- `.saved-thumb` 36×27 → 72×54, `.saved-title` 11 → 22, padding ×2
- `.svc-ico` 18 → 36, header font 10 → 20
- `#saved-add-btn` / `#saved-search-btn` font 16 → 32, SVG 28×28
- Native `::-webkit-search-cancel-button` скрыт через CSS — только
  SVG-иконки в стиле Material/iOS

**AGENT_LIGHT_API.md:** standalone-doc для пересылки внешним
агентам/людям. Описывает endpoints `/api/light/state` (GET),
`/api/light/set` (POST JSON), каналы (`ch1=Споты`, `ch3=Гирлянда`,
`ch2=не подключён`), примеры curl/Python/JS, ограничения (LAN-only,
без auth, MQTT latency 1-3с). Помечен как **временный endpoint** —
IP изменится после переезда.

**NOTES_migration.md:** чеклист на переезд сервера — credentials,
сервисы, базы, что тестить после миграции.

## Session end snapshot — 2026-05-24 01:38 MSK

Ветка `feat/saved-panel-search` HEAD — `2db505e`. Не в main (PR не делала
без explicit approval). На voloNuk также `2db505e`, panel uvicorn PID
обновляется при рестарте `set -a; . .env; set +a; uvicorn` — после
рестарта контейнера нужно re-запустить с .env (issue lisa-core #406).

**Что протестировано в этой сессии (видел Андрей):**
- ✓ SC widget autoplay (через muted gesture prime + event-driven force-play)
- ✓ YT iframe handshake (playerState читается из infoDelivery)
- ✓ YT Mix-playlist `list=RD<vid>` для auto-DJ
- ✓ Cache-busting + auto-reload polling (mtime на 3 файла)
- ✓ Console layout (top var(--hh), bottom 96px, z=170)
- ✓ Plus-button QR-flow для add-from-phone
- ✓ Menu links target=_blank
- ✓ Saved-panel sizing ×3, шрифты/thumb ×2
- ✓ Lupa-button + inline search input (Enter работает)
- ✓ /api/search YT Data API music category
- ✓ Tap-on-card play, ＋ save (stopPropagation)
- ✓ Save-current-track ＋ в баре (×2 size)
- ✓ Server heuristic Stage A — drop VEVO / embeddable=false / age /
  region=RU. Smoke: «despacito» → drops 2/12.
- ✓ TDD harness `panel/tests/test_yt_filter.py` зелёный для 5/6
  known fixtures (PSY проходит — handled by Stage B)

**Деплоено в commit `2db505e`, не протестировано Андреем после fix'а:**
- Stage B (client iframe probe) — `e.source === probe.contentWindow`
  check, чтобы probe handler не реагировал на onError от main #yt-frame.
  В предыдущем варианте onError приходили (видел в dbg-log), но карточки
  не удалялись из-за race с main iframe handler.
- Active highlight (`.search-item.active`) на результат когда играет —
  жёлтый title. applySearchActive() вызывается из click и из loadSavedItem.

**Открытые задачи (backlog):**

1. **Автодеплой по несоответствию версий** — реализовать `kv_command_daemon.py` (задокументирован в `ARCHITECTURE_NOTES.md`, не создан): поллер CF KV неймспейса `fed3fe1caf3e464fbb582b03f2e5a4ab`, при команде `update` запускает `update.sh` (git pull --ff-only + рестарт всех сервисов). Это позволяет агенту или GitHub webhook написать в KV → voloNuk сам подтягивает. Альтернативно: сервер сам сравнивает локальный HEAD с GitHub API `refs/heads/main`, при расхождении — git pull + рестарт без внешнего тригера.

2. **Яркость экрана** _(первый приоритет из screensaver-мода)_:
   - Плавное затемнение до 50% по расписанию (ночной режим)
   - Залогиненным в меню: 2 горизонтальных слайдера — «Общая яркость» и «Ночное затемнение»
   - Реализация: API-endpoint `/api/screen/brightness` + KV-хранение настроек + Android-слой (APK/Termux `termux-brightness` или ADB) для применения на планшете

3. **Screensaver-мод** _(следующий шаг после яркости)_: логика перехода панели в режим сна + пробуждение по тачу.

4. Дотестировать Stage B probe после reload — Unheilig/PSY должны
   исчезать из результатов в течение 4 секунд (timeout fallback) или
   быстрее (onError 150). Если probe всё ещё не справляется → Stage C.
2. **Stage C — playwright headless probe** на voloNuk или на компе
   Андрея (он дал доступ через bridge). Сервер-side ground truth +
   SQLite cache по video_id 7д. Откладываю до подтверждения что
   Stage B не покрывает.
3. **SC polling-retry** вместо фиксированного 2500ms timeout. План в
   `NOTES_autoplay_switch.md`.
4. **SC search** в `/api/search?src=soundcloud` (фаза 2 — нужен
   `SC_CLIENT_ID` + SC search endpoint).
5. **Громкость popup-slider** UI в стиле Telegram-голосовых.
6. **`LIGHT_API_TOKEN` auth** на `/api/light/*` (отдельный токен от
   `AG_BRIDGE_SECRET`, чтобы давать сторонним агентам только свет).
7. **Native audio fallback для embed-restricted YT** (см.
   `NOTES_embed_restricted.md` — пока на backend отфильтровываем).
8. **YT music filter «без мусора»** — Mix-плейлист хорошо работает,
   но иногда сыпет non-music. Метрика mood/genre — отдельная история.

**Связанные lisa-core issue:**

- **#405** — useragents AGENT_INSTRUCTIONS нужно явно описать правило
  подписи «Это Андрей, пишу через своего агента (Лису)».
- **#406** — queue_runner.py должен крутиться автоматом (после рестарта
  контейнера + watchdog). Текущий fix — ручной `nohup` фоном, не
  переживёт перезагрузку.

**Как восстанавливаться после рестарта контейнера:**

1. `cd /home/superlisa/workspace/projects/silno-dom-server && git status`
   — должна быть ветка `feat/saved-panel-search` HEAD `2db505e`.
2. Panel uvicorn на voloNuk сам поднимется через
   `VoloNuk_StartSilnoServer` Scheduled Task (он делает `bash start.sh`,
   там `source .env` есть). YOUTUBE_API_KEY в `.env`, AG_BRIDGE_SECRET
   в Windows env vars.
3. Queue_runner.py для userbot — нужно поднять вручную (см. #406).

---

## Session snapshot — 2026-05-24 evening / 2026-05-25

### Новые коммиты на `feat/saved-panel-search` (после `2db505e`)

- `228c015` — display brightness sliders + night mode (CSS filter + KV + /api/sun/times)
- `5ee90ec` — start.sh: auto-update loop (git fetch каждые 5 мин, update.sh при drift)
- `55f6608` — убраны слайдеры яркости из меню (откатано в f92444b)
- `f92444b` — убраны #header-clock и #sched-btn; слайдеры возвращены; луна на месте

- `4de57a1` — light schedule timer + UI (расписание включения/выключения ch1+ch3)
- `f61c7f4` — sleep timer button + solar schedule (astral, Derbent 42.05N/48.29E)

### Что добавляет `f61c7f4` (НЕ задеплоено на voloNuk)

**Sleep timer:**
- Кнопка-луна в zone-tabs (рядом с zone-кнопками)
- Тап → пресеты 15 / 30 / 45 / 60 / 90 / 120 мин
- Обратный отсчёт отображается в кнопке
- По истечении: гасит ch1 + ch3

**Solar schedule:**
- ON-записи в DEFAULT_SCHEDULE теперь `"mode":"sunset"` через astral `LocationInfo`
  (Дербент: 42.05°N, 48.29°E)
- OFF — 04:00 MSK (фиксированное)
- `_sun_time(kind)`: fallback на 19:00 если astral недоступен
- `openSchedule()`: для mode-записей показывает бейдж «по закату» вместо time picker
- `astral>=3.2` добавлен в `requirements.txt`

### Статус деплоя на voloNuk

voloNuk недоступен с 2026-05-24 ~20:00 MSK — Tailscale Funnel таймаутит
(HTTP 000) на обоих портах (:443 bridge, :8443 panel). Причина: voloNuk
выключен или Tailscale упал на машине.

На сервере задеплоен коммит `2db505e`, ветка `feat/saved-panel-search`.
Коммит `f61c7f4` (sleep timer + solar schedule) **не задеплоен** — ждёт
восстановления доступа.

**Блокеры перед деплоем:**
1. Поднять voloNuk (если выключен) + убедиться что Tailscale запущен
2. Запустить `VoloNuk_BridgeWatchdog` в Task Scheduler (или вручную)
3. После восстановления bridge: `git pull` + `pip install -r panel/requirements.txt` + рестарт uvicorn

### Инфраструктурные issue из этой сессии

- **lisa-core #420** — `whisper_fallback.py` неверная проверка ключа `__quota_error__`
  вызывала ранний выход; ЗАКРЫТ — фикс в коммите `ade5161`.
- **lisa-core #421** — `moio-control` CF Worker BACKEND устаревает при ротации
  cloudflared quick tunnel; ОТКРЫТ — рекомендован переход на named persistent tunnel
  или Tailscale Funnel напрямую.

### Следующие задачи (после подтверждения что панель живая)

1. **Задеплоить `f61c7f4`** на voloNuk (sleep timer + solar schedule)
2. **Омнибокс** — объединить `+` и поиск в одно поле:
   - Одна кнопка в `saved-panel-hdr`
   - `input.startsWith('http')` → добавить URL; иначе → поиск
   - QR-поток (телефон → панель) сохраняется
3. **Слить `feat/saved-panel-search` → main** (нет explicit approve от Андрея)

---

## Session snapshot — 2026-05-25 afternoon MSK

### Новые коммиты (после `f92444b`)

- `cdc34f1` — BT toggle button stub: `#bt-btn` в zone-tabs (вместо часов), `/api/bt/toggle` прокси на localhost:8765
- `35cf276` — Android APK Gradle проект в `android/bt-agent/`; `btToggle()` теперь зовёт `http://localhost:8765/bt-toggle` напрямую (browser+APK на одном планшете)
- `162bf57` — AGP 4.1.3 → 7.4.2, Gradle 7.6.1, namespace; ссылка "BT Agent ↓" в `#menu-logged`
- `58512cc` — `panel/static/bt-agent-debug.apk` (13KB debug build) — скачивается с планшета через `/bt-agent-debug.apk`
- `603ab49` — **CRITICAL FIX**: заменён `html { filter/transition }` на `#dim-overlay` (position:fixed; pointer-events:none; rgba background). `filter` на `<html>` ломал все `position:fixed` элементы и touch-события на Android Chromium.

### Статус деплоя на voloNuk

HEAD на ветке: `603ab49`. Auto-update loop подтянул изменения в 15:49 MSK (видно из логов планшета). После апдейта был инцидент: `603ab49` ещё не подтянулся — планшет ловил версию со сломанным UI. После деплоя `603ab49` UI восстановлен.

Деплоено (`git pull` + рестарт через auto-update): `603ab49`.

### BT Agent — состояние

- APK исходники: `android/bt-agent/` (Java, Foreground Service, ServerSocket HTTP, нет внешних зависимостей)
- APK собран Андреем в Android Studio (debug, `com.silnodom.btagent`, v1.0)
- APK лежит в `panel/static/bt-agent-debug.apk`
- **Не установлен на планшете** — ожидает деплоя и скачивания через меню
- После установки: запустить приложение → шторка покажет "BT Agent: Listening on :8765"
- Тест: нажать `#bt-btn` в панели → `http://localhost:8765/bt-toggle` → BT переключается

### Известные проблемы

- `/api/sun/times` → 502 пока voloNuk крутил старый app.py без этого endpoint. После рестарта с `603ab49` 502 должны прекратиться.
- MIUI Battery Optimizer может убивать BT Agent APK. Лечится: Настройки → Батарея → Нет ограничений + Автозапуск для com.silnodom.btagent.

### Как восстановиться после рестарта

1. voloNuk должен быть на `feat/saved-panel-search` HEAD `603ab49`
2. `VoloNuk_StartSilnoServer` Task Scheduler запускает `bash start.sh`
3. `start.sh` поднимает uvicorn + auto-update loop (PID в `logs/autoupdate.pid`)
4. `.env` на voloNuk должен иметь `YOUTUBE_API_KEY`, `AG_BRIDGE_SECRET`
5. После рестарта проверить: `/api/version` → 200, `/api/sun/times` → 200, `/api/state` → 200

### Следующие задачи

1. **Установить BT Agent APK** на планшет → скачать через `http://192.168.31.50/bt-agent-debug.apk` → тест кнопки
2. **MIUI AutoStart** для BT Agent (чтобы выживал после перезагрузки планшета)
3. **Омнибокс** (объединить + и поиск в одно поле)
4. **Слить `feat/saved-panel-search` → main**

---

## Инцидент 2026-05-25 — brightness сломал панель + auto-update не работал

### Root cause

`document.documentElement.style.filter = 'brightness(X%)'` + `html { transition: filter }` на `<html>` создают compositing context. Все `position: fixed` потомки теряют viewport-позиционирование. Touch-события ломаются на Android Chromium. Всё смещается влево, ничего не нажимается.

**Правило на будущее:** никогда `filter` на `<html>` или `<body>`. Диммер — только через отдельный `position:fixed; pointer-events:none` div с `background: rgba(0,0,0,X)` без filter.

### Auto-update не тянул фиксы

`git fetch origin` в WSL под `mqtt-silno` user молча ничего не делал — git credentials не настроены для этого пользователя в неинтерактивной сессии.

**Фикс перед следующей сессией:**
```sh
# Под mqtt-silno в WSL:
git config --global credential.helper store
git pull  # ввести username + GitHub PAT → сохранится в ~/.git-credentials
```

### Состояние после отката

- voloNuk: `git reset --hard fdb0f62` — чистые static файлы, без яркости
- Репо HEAD: `6901a18` (все фичи запушены, на voloNuk не задеплоены)

### Что деплоится при следующем git pull

```
5ee90ec — auto-update loop в start.sh
f92444b — убраны часы, слайдеры в меню
cdc34f1 — BT кнопка в zone-tabs
35cf276 — Android APK project + direct localhost JS
162bf57 — AGP fix + APK link в меню
58512cc — bt-agent-debug.apk в static
603ab49 — (промежуточный, включён в 6901a18)
6901a18 — откат brightness module (чистые static)
```

После `git pull && bash start.sh` всё выше будет задеплоено без brightness. Панель должна работать.

---

## Session snapshot — 2026-05-25 evening MSK

### Новые коммиты (после `6901a18`)

- `16be813` — docs: инцидент-лог (brightness + git auth blocker)
- `3818579` — fix(update.sh): убивать все uvicorn на обновлении, не только web.app
- `588e159` — revert(panel/static): откат UI до `fdb0f62` (BT кнопка убрана до готовности APK)
- `aba3dfa` — feat: `/admin` страница (яркость + APK + ← назад) + `#dim-overlay` + порт 8082
- `14c7f3b` — fix(schedule): кастомный time picker (−HH+:−MM+) вместо нативного Android виджета; 24ч формат; убран клипинг

**main смержена** с `feat/saved-panel-search` до `588e159` — stable UI живёт в main.

### Статус деплоя на voloNuk

voloNuk при последнем контакте был на `fdb0f62` (manual hard reset). Auto-update остановлен Андреем вручную.
Коммиты `3818579`..`14c7f3b` **не задеплоены** — ждут следующего `git pull + bash start.sh`.

### Как восстановиться после рестарта

1. voloNuk, под `mqtt-silno` в WSL: `cd ~/silno-dom-server`
2. `git pull origin feat/saved-panel-search` (credentials уже сохранены)
3. `pip install -r panel/requirements.txt` (если новые зависимости)
4. `bash start.sh`
5. Должны подняться: uvicorn panel.app на 8080 И 8082, web.app на 8081, streaming на 8083, auto-update loop
6. Проверить: `curl http://localhost:8080/api/version`, `curl http://localhost:8082/admin`

### Блокеры и следующие задачи

1. **Задеплоить `14c7f3b`** на voloNuk: `git pull && bash start.sh` (pkill/restart через auto-update сработает автоматически)
2. **Установить BT Agent APK** на планшет: `http://192.168.31.50:8082/static/bt-agent-debug.apk` → install → test BT кнопка (после деплоя aba3dfa BT кнопки нет в UI — нужно добавить обратно)
3. **BT кнопка вернуть в UI** после установки APK: добавить `#bt-btn` в zone-tabs
4. **Омнибокс** — объединить `+` и поиск в одно поле

### Port map (актуальный)

| Port | Service | Notes |
|------|---------|-------|
| 8080 | panel (stable) | main ветка, кастомный start.sh |
| 8081 | web (emergency light) | не трогать |
| 8082 | panel (dev) | feat/saved-panel-search, /admin доступен |
| 8083 | streaming | yt-dlp wrapper |

### Admin страница (`/admin` на 8082)

- Слайдеры яркости → PUT `/api/display/settings` (KV-хранение)
- Статус BT Agent (ping localhost:8765)
- APK download
- `#dim-overlay` инициализируется в `app.js` через `/api/display/settings` + `/api/sun/times`
- Формула: alpha = (100 - brightness) / 100

---

## Session snapshot — 2026-05-26 MSK

### Мерж feat/saved-panel-search → main

PR #5 смержен. main теперь включает всё что было в feat/saved-panel-search:
seed playlist, text clock (reverted from SVG), dump_saved.py, update.sh worktree pull.

### Новая dev-ветка: dev/panel-next

После мержа создана `dev/panel-next` от main (`56bf907`). На voloNuk 8082 переключён на эту ветку.

### logic-dev: Radio слой на порту 8084

Ветка `logic-dev` от `56bf907`, коммит `feec49d` (запушен в origin).

**Что добавляет:**
- Вертикальные табы Saved | Radio в левой панели
- Radio-панель: поисковый инпут + YT/SC кнопки-иконки (SC пока заглушка)
- Результаты поиска с Stage B iframe probe (переиспользован существующий `probeEmbeddable()`)
- Тап по результату → играет, обновляется Now Playing бар внутри Radio-панели
- Pre-fetch очередь: когда трек начинает играть, ищет 5 похожих (по названию), пробит через iframe; валидные идут в очередь. При конце трека (`onStateChange=0`) играет следующий из очереди. Если все 5 отвалились — берёт следующие 5.
- `scNext()` и `ytAutoNext()` радио-aware: при активном radio прокручивают очередь а не saved-list
- `start.sh`: порт 8084 для logic-dev worktree (опционально)
- `update.sh`: пуллит both stable и logic worktrees

**На voloNuk нужно:**
```sh
cd ~/silno-dom-server
git fetch origin
git worktree add ../silno-dom-server-logic logic-dev
bash start.sh
```

### Port map (актуальный)

| Port | Service | Branch | Notes |
|------|---------|--------|-------|
| 8080 | panel (stable) | main | worktree `../silno-dom-server-stable` |
| 8081 | web (emergency light) | main | не трогать |
| 8082 | panel (dev) | dev/panel-next | /admin доступен |
| 8083 | streaming | main | yt-dlp wrapper |
| 8084 | panel (logic) | logic-dev | **не поднят**, ждёт worktree на voloNuk |

### Блокеры

1. **Создать worktree на voloNuk** для logic-dev (см. выше)
2. **Подтвердить работу Radio** на 8084 после поднятия
3. **Слить logic-dev → dev/panel-next** после тестирования Radio

### Связанные lisa-core issue

- **#436** — whisper hook: parallel topic_loader + whisper_fallback дополнительныеContext колизия. Fix на ветке `fix/issue-436-whisper-topic-loader-merge`, коммит `204398c`. Ждёт мержа в main.
- **#421** — moio-control CF Worker BACKEND устаревает при ротации cloudflared.

---

## Doorbell overlay integration — 2026-06-17 MSK

Issue #12 on branch `dev/issue-12-doorbell-overlay` adds the Panel side of the GATE doorbell contract from `projects/silno-dom-gate/panel-doorbell-contract.md`.

**Implemented:**
- Same-origin proxy from Panel to GATE: `/api/door/*` forwards to `GATE_BACKEND` (default `http://127.0.0.1:8090`) and `/doorbell/*` streams media with `StreamingResponse` for MJPEG/snapshot paths.
- Full-screen `#doorbell-overlay` above media/menu controls with MJPEG-first `<img>`, snapshot fallback, text fallback, recognition/source metadata, and `Open` / `End call` buttons.
- Frontend polling for `/api/door/active` and `/api/door/events`; startup initializes the event cursor without replaying old rings, then uses active-session state for an already-open call.
- On `doorbell.ring`, Panel pauses YouTube, SoundCloud widget, native audio, and BT state before showing the overlay.
- `Open` calls `/api/door/open`; `End call` calls `/api/door/end`; `door.open.result` shows opened/denied/failed states and `doorbell.closed` auto-closes.
- Existing light controls are not hidden permanently; overlay clears its image sources and session id on close.

**Verified locally:**
- `python3 -m py_compile panel/app.py projects/silno-dom-gate/fake_gate_service.py` passed.
- `node --check panel/static/app.js` passed.
- Smoke with fake GATE + Panel passed: demo ring through Panel proxy, active session, snapshot proxy, open command with `door.open.result` + `doorbell.closed`, and `/api/light/state` stayed routed to the light endpoint path.

**Not verified in browser in this container:** `agent-browser` could not launch its bundled Chrome because the binary returned permission denied. Browser-level tablet verification still needs a real dev panel session.
