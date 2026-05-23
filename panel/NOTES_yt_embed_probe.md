# YT embed-playable probe — research log

2026-05-23, ветка `feat/saved-panel-search`. Текущий `/api/search` фильтрует
по `status.embeddable` из YT Data API — поле **врёт** для label-locked
видео (Despacito имеет `embeddable=true`, но реальный iframe выдаёт «Video
unavailable»).

## Что НЕ работает (проверено)

**1. HTML парсинг `youtube-nocookie.com/embed/<id>`:** HTML рендерится
одинаково для playable и unplayable видео. `playabilityStatus` определяется
**только** client-side через JS bundle (запрос к `/youtubei/v1/player`
из браузера).

**2. HTML парсинг `youtube.com/embed/<id>`:** то же что и nocookie —
никаких различимых маркеров между playable/blocked в HTML. Без
правильного `Referer` все запросы возвращают
`PLAYABILITY_ERROR_CODE_EMBEDDER_IDENTITY_MISSING_REFERRER` (false
negative для всех).

**3. oEmbed:** `https://www.youtube.com/oembed?url=...` возвращает HTTP 200
для всех видео включая Despacito, Smashing, PSY. Это endpoint для
**метаданных** (title/author), не для embed-permission.

**4. InnerTube `/youtubei/v1/player` API:** прямой вызов с
`EMBEDDED_PLAYER` clientName возвращает 429 + HTML «We're sorry...
automated queries» — Google detects bot traffic от datacenter IP
(superlisa container). Из voloNuk через Throne (US-exit) **может**
работать, но не проверял.

**5. `status.embeddable` + `privacyStatus`:** уже используется в коде,
но врёт. Большинство label-locked имеют `embeddable=true,
privacyStatus=public`.

## Что **может** работать

**A. Playwright headless на voloNuk (или на ag-linux/компе Андрея):**
запускаем реальный Chromium, грузим iframe `embed/<id>`, ловим
`postMessage` с `event=onError` и кодами 101 / 150 (embed disabled).
Детерминистично, но дорого по ресурсам (~200MB per browser instance) и
требует установки Playwright.

**B. Frontend iframe probe:** на стороне Bromite клиента — создавать
offscreen iframe для каждого результата, listen `message` events для
`onError`. Реальный браузерный context даёт правдивый ответ. Минусы:
12+ iframes на search → trafic + память + задержка 3-5с.

**C. Heuristic shortcuts:** часть locked видео можно отфильтровать
дёшево:
- `channelTitle` содержит «VEVO» → 60-70% label-locked коверы.
- `contentDetails.regionRestriction.blocked` непустой (нужен второй
  `videos.list?part=contentDetails`) — точно блочит для региона.
- `contentDetails.contentRating.ytRating == "ytAgeRestricted"` —
  age-gate, embed not allowed.

Heuristic покроет ~70% случаев бесплатно. Остаток — playwright или
iframe probe.

**D. «Первые N — смело»:** просто вернуть первые 3-5 результатов из
search.list, верить что они popular/safe. Работает для NCS/Lofi
запросов, ломается для лейбловых артистов (Unheilig → первый VEVO →
locked).

## Рекомендация

**Гибрид:**

1. Добавить heuristic фильтры в backend (cheap): drop VEVO channels,
   drop `regionRestriction.blocked`, drop ytAgeRestricted. Часть
   проблем уйдёт сразу.
2. Что осталось — выгружать через playwright на voloNuk (или на ag-linux
   через bridge). Кешировать results в SQLite по `video_id`, TTL 7 дней.

Или вариант **B (frontend iframe probe)** если хотим без playwright
зависимости.

## Откладываю до согласования

Сейчас фиксирую research, чтобы не потерять. Когда Андрей выберет
путь — реализую.
