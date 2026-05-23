# Stable panel state — 2026-05-23 evening

Git tag: `panel-stable-2026-05-23-evening` (commit `78b0d1f`).

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
- Без `chrome://flags/#autoplay-policy = No user gesture` — autoplay
  Bromite режет в iframe-context.
