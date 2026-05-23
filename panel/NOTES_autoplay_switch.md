# Autoplay при переключении saved-item — заметки

## Текущее состояние (2026-05-23 21:00 MSK)

После включения Bromite `chrome://flags/#autoplay-policy = No user gesture is required`:

- **Первый load** saved-item (после открытия страницы) — SC widget автоплеит сразу через `scFrame.src = ...` с `auto_play=true` в URL. Работает надёжно.
- **Переключение между saved-items** — идёт через `scWidget.load(url, {auto_play:true}, callback)`, который шлёт postMessage в iframe. Bromite это считает runtime API, не URL-навигацией, и autoplay в postMessage-load НЕ разрешает даже с флагом включённым.
- Callback `.load()` либо не firing, либо `.play()` внутри callback всё равно блочится. В dbg-log видно только `scLoadInWidget(sync-fast-path)` и тишину 5+ секунд, нет ни PLAY ни warn.

## Решение А (выбрано, реализовано) — fallback play() по event

После `scWidget.load(url, opts, ...)` подписываемся **one-shot** на первый сигнал что трек реально готов:

- Использовать callback `.load()` если он firing — внутри явный console.log + scWidget.play()
- Параллельно — bind `LOAD_PROGRESS` event handler one-shot → call scWidget.play() и unbind
- Safety net: через ~2.5 сек если ни один сигнал не пришёл — forced scWidget.play() с warn в лог

Преимущество: не привязано к фиксированному timeout, реагирует на реальную готовность widget.

## Решение B (отложено, надо протестить)

Полный reload iframe через `scFrame.src = новый URL с auto_play=true`. То же что первый load — Bromite разрешает autoplay на URL-навигации iframe.

Минусы:
- Полная перезагрузка iframe = ~1-2 сек ожидания вместо плавного track-switch
- Нужно re-bind widget API после iframe `load` event (одна попытка уже была в коммите `25e122c`, она ломала binding из-за неправильного timing)

Как корректно протестить:
1. В `loadSavedItemIframe` для SC — заменить `scLoadInWidget(item.url)` на:
   ```js
   const scFrame = document.getElementById('sc-frame');
   const enc = encodeURIComponent(item.url);
   scFrame.addEventListener('load', function onload() {
     scFrame.removeEventListener('load', onload);
     scInitWidgetApi(() => scBindWidget(scFrame));
   }, { once: true });
   scFrame.src = `https://w.soundcloud.com/player/?url=${enc}&color=%23fff500&auto_play=true&visual=true&show_comments=false&show_reposts=false&show_teaser=false`;
   ```
2. Перед перевязкой убедиться что `scWidget` global ref зануляется при unload — иначе сохранится ссылка на мёртвый instance.
3. Замерить реальный delay reload в Bromite. Если >3 сек — точно отказываться, A лучше.

## Какой выбрать после теста A

Если A решает 95%+ переключений без forced fallback — оставляем A, B архивируем.
Если A постоянно ловит forced fallback (тогда задержка 2.5 сек) — B стоит протестить.
