# YouTube embed-restricted треки — отложка

Видео которые официально запрещены к embed правообладателем. Игралка через
обычный и nocookie домен оба отвечают «Видео недоступно». Без proxy с
frame-injection или native audio через streaming proxy — никак.

Дата фиксации: 2026-05-23

## Список

```text
https://www.youtube.com/watch?v=4aeETEoNfOg  # The Smashing Pumpkins — 1979
https://www.youtube.com/watch?v=kJQP7kiw5Fk  # Luis Fonsi — Despacito ft. Daddy Yankee
https://www.youtube.com/watch?v=9bZkp7q19f0  # PSY — Gangnam Style
https://www.youtube.com/playlist?list=PLNO0kBf5TPC80ZyE9IFW_GzTYrVU8tnAr  # MusicTest01 (тоже недоступен по причине embed-restricted треков внутри)
```

## Что пробовали

1. `youtube.com/embed/<id>` — «видео недоступно»
2. `youtube-nocookie.com/embed/<id>` — то же самое

## Что может разблокировать

1. **Native audio через streaming proxy** — звук без картинки. Старый
   `tryNativePlay` path, который выпилили из основного flow. Можно вернуть
   как fallback: если iframe сообщит ошибку через postMessage `onError` с
   кодом 101/150 (embed disabled) — переключаться на native player.
2. **Proxy + frame-injection** — встраивать `youtube.com/watch?v=...` через
   обратный proxy, который вырезает `X-Frame-Options`. Юридический серый
   зон, ресурсоёмко.
3. **Invidious / Piped instance** — open-source frontend YT. Можно
   встраивать `invidious.example.com/embed/<id>` если найти живой инстанс.
   Reliability instances плавающий.

## Рекомендация

Реализовать вариант №1 — fallback на native audio при `onError` с кодом 101
или 150. Картинки не будет, но звук пойдёт. Это меньшее зло чем «видео
недоступно».

LoFi 6h compilation из `NOTES_long_tracks.md` — отдельная задача (там не
embed-restriction, а range/длительность). Решения частично пересекаются
(оба идут через native audio), но триггер другой.
