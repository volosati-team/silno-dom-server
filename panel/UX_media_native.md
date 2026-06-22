# Native media UX

## Goal

The media panel uses native playback for YouTube and SoundCloud whenever the resolver can provide a direct stream. The large media frame should show live motion for YouTube and a native SoundCloud visual layer for SoundCloud, not a static embed placeholder.

## YouTube

When a saved YouTube item is opened, the panel resolves a video stream through the same-origin streaming proxy and plays it in the large frame with a native video element. The iframe remains as a fallback, but the visible successful state is native video motion in the frame and a running audio/playback state in the bottom bar.

Expected user-visible behavior:

- The big frame contains moving video, not only thumbnail art.
- The bottom player bar controls play, pause, previous, next, volume, and progress.
- If the native video stream cannot be resolved, the panel falls back to the YouTube iframe path.

## SoundCloud

When a saved SoundCloud item is opened, the panel resolves a native audio stream through the same-origin streaming proxy and plays it in the shared native audio element. The SoundCloud iframe widget is fallback only.

Expected user-visible behavior:

- The big frame switches to a native SoundCloud visual: artwork, title, subtitle, and animated orange bars.
- The bottom timeline advances from native audio time updates.
- Play and pause state is reflected in the bottom bar and the native visual animation.
- If native stream playback fails, the panel hides the native visual and falls back to the SoundCloud widget.

## Saved items and restore

Saved YouTube and SoundCloud items use the same list and the same bottom controls. Playback state stores URL, playing state, and current time. On reload, the panel restores through native playback first and falls back to iframe/widget behavior only if native resolution fails.

## Operating ports

Stable panel runs on port 8080. Dev panel runs on port 8082. The streaming resolver runs on port 8083 and serves same-origin panel requests through the panel proxy. Port 8084 was used only as the temporary SoundCloud native development contour and is not part of the steady UX.

## Version notes

### Native YouTube + SoundCloud baseline

This version established the stable media baseline:

- YouTube saved items resolve through the streaming service with `mode=video` and show native video motion in the large frame.
- SoundCloud saved items resolve through the streaming service as native audio and show a native visual layer in the large frame.
- The bottom player bar is shared across native YouTube audio, native SoundCloud audio, and fallback iframe/widget flows.
- The resolver proxy stores stream mode with proxy tokens so a refreshed video token does not accidentally re-resolve as audio.
- Port 8084 was used only to test SoundCloud native behavior before promotion to stable/dev.

Verification evidence for this version:

- YouTube tablet log reached native video `moving currentTime`.
- SoundCloud tablet log reached `SC native stream: playing via resolver`, `native: play`, and `SC native stream: moving currentTime=1.6`.
- SoundCloud proxy range returned partial `audio/mpeg` bytes with an `ID3` prefix.

### Dev fix: YouTube native audio must own music playback

Observed on the tablet: native YouTube video could continue moving while the bottom timeline stayed at zero and no music was audible. The cause is a split-brain state: muted native video was playing for motion, but the separate resolver audio path treated the restored track as user-paused and still logged the stream as playing.

In dev, explicit YouTube saved-item loads now call the native audio resolver with autoplay allowed. Success is logged only when the native audio element is actually not paused. If the resolver returns a stream but audio remains paused, the bar stays paused instead of pretending music is playing. Restore without a fresh gesture can still prepare the stream without forcing autoplay.

The bottom play button also no longer primes the silent unlock WAV when the active player is already native audio. That earlier order could replace the real resolver stream with the silent unlock source, so the UI looked active while the music stayed silent. Native play/pause now handles the current native stream first and only primes unlock for non-native iframe paths.

### Next: YouTube suggested continuation

When a YouTube music video is playing and the user presses Next, or when the current track ends, the player should be able to continue within YouTube suggestions instead of only advancing through saved items. Saved items must not be modified by this flow.

Intended behavior:

- Take suggested/related YouTube candidates from the currently playing track context.
- Filter candidates toward music-only tracks in a similar genre or listening context.
- Probe a small candidate set, for example five items, through the same resolver/player path.
- Pick a candidate that can play reliably in the native panel path.
- Start it as the next transient queue item without adding it to saved items.
- Continue the same logic on subsequent Next/end events.

Open design questions for implementation:

- Where to source suggestions most reliably: yt-dlp related entries, YouTube oEmbed/metadata, or a lightweight search seeded by current title/channel.
- How aggressive the probe should be so it does not stall the UI.
- How to represent transient queue history separately from saved playlists.
