# Длинные треки на панели — TODO + ссылка LoFi

## Отложенная ссылка

LoFi Girl 2021 (6h compilation), удалена из saved-list 2026-05-23:

```text
https://www.youtube.com/watch?v=n61ULEU7CO0
```

Title: «Best of lofi hip hop 2021 ✨ [beats to relax/study to]»
Thumbnail: `https://i.ytimg.com/vi/n61ULEU7CO0/hqdefault.jpg`

## Симптом

При воспроизведении через native HTML5 player на Bromite (Android 8.1,
Chromium 108) — каждые ~30 секунд `MediaError code=4`
(`MEDIA_ERR_SRC_NOT_SUPPORTED`) с retry-loop.

URL — signed googlevideo `audio/mp4` (itag=140), длина 360 МБ, 22257 секунд.
Короткие треки (1979 Smashing Pumpkins, Despacito) — работают.

## Гипотезы (отсортированы по подозрению)

1. **Range requests на длинных googlevideo URL**. Bromite запрашивает
   диапазоны через `Range:` header — на длинных подписанных URL это часто
   ломается (signature attached к full content-length, частичные ответы
   получают 403 / CORS-блок). Короткие треки помещаются в первый chunk и не
   триггерят range.
2. **TVHTML5 client signature**. URL содержит `c=TVHTML5` — yt-dlp резолвит
   через TV-клиент, у этого формата signing работает иначе, чем у WEB. На
   длинных может быстрее истекать sig или иметь геопривязку.
3. **IP mismatch в signed URL**. В выловленных URL стоит `ip=90.156.223.184`
   (российский IP voloNuk). Если streaming-сервер резолвит без Throne, а
   потом отдаёт URL клиенту, который ходит через US-exit — YT может
   рубить signature. Нужно проверить отдельно (см. ниже).

## План тестирования

1. **Воспроизвести через streaming proxy** (`:8083`) вместо native googlevideo:
   - Изменить app.js чтобы для YT >30 мин использовать
     `http://silno.local:8083/stream?url=...` вместо direct signed URL
   - Streaming server делает свой range-handling и проксирует chunks
2. **Проверить exit-ip из WSL**:
   ```sh
   wsl -d Debian -u mqtt-silno -- curl -s ifconfig.me
   ```
   Если RU — Throne не подхватился, streaming server резолвит мимо VPN.
   Если US — гипотеза с IP-mismatch отпадает.
3. **Сверка cookies**: проверить что `YT_DLP_COOKIES_FROM_BROWSER` указывает
   на актуальную Firefox-сессию (cookies могли протухнуть после YT-апдейта)
4. **Тест без подмены**: курлом скачать первые 10 МБ напрямую с
   googlevideo URL через тот же Bromite (через DevTools). Если 416/403 на
   range — гипотеза №1 подтверждается.

## Что НЕ работает (избегать на длинных)

- Direct native HTML5 src с TVHTML5-signed URL — выше 30 минут падает
- yt-dlp extract без cookies — bot-detection
- SC iframe для YT — не подходит (только для SoundCloud)

## Что работает сейчас

- Streaming proxy на `:8083` с bounded Range handling.
- Same-origin `/api/stream/proxy/{token}` instead of direct signed googlevideo / SoundCloud CDN URLs.
- Disk-backed proxy-token state in `/tmp/silno-stream-proxy-cache.json`, so worker restart does not invalidate issued proxy tokens.
- Silent live hold passed for both sources: YouTube `631.77s`, SoundCloud `634.22s`, both with repeated `206` range responses.
- Browser-side panel smoke in `live-ui-smoke.json` passed through `nativeReresolveAndPlay()` for YouTube and SoundCloud: both resolved to same-origin `/api/stream/proxy/{token}`, both played in `<audio>` with `readyState: 3`, `paused: false`, and `206` proxy responses (`audio/mp4` for YouTube, `audio/mpeg` for SoundCloud).

## Что ещё можно улучшать отдельно

- HLS чанковый формат, если yt-dlp стабильно отдаёт m3u8 manifest для long YT.
- Локальный кеш первых 30 МБ для seek без лагов.
- APK debugger screen-capture permission, чтобы browser-side smoke можно было дополнить live tablet screenshot вместо headless Chromium.
