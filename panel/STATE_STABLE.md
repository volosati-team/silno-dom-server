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

1. Дотестировать Stage B probe после reload — Unheilig/PSY должны
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
