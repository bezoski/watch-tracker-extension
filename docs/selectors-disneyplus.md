# Disney+ DOM recon

Findings from manual DevTools inspection of a playing episode. Written down because the
player UI lives in shadow DOM, so none of it is discoverable with a plain `querySelector`.

## Content id

URL: `/pl-pl/play/821e9f4d-27cb-4426-baa9-6275dea5faa6` — the locale prefix varies, so match
on the `play` segment only:

```js
location.pathname.match(/\/play\/([0-9a-f-]{36})/)?.[1]
```

## Picking the right `<video>`

The page holds two `<video>` elements. Index 0 is a decoy: `readyState 0`, `0x0`, no src.
The real one has `readyState 4` and a `blob:` src, so select on:

```js
[...document.querySelectorAll("video")].find(v => v.readyState >= 1 && v.videoWidth > 0)
```

## Progress cannot come from the video element

`video.duration` is `Infinity`, and `video.seekable.end()` returned 181s early in the episode
but 33s near its end — Disney+ swaps the MediaSource mid-playback, so the element's timeline
does not map to the episode. `currentTime / duration` is therefore unusable here (the project
plan assumed otherwise). Progress has to be read from the player UI progress bar instead
(`role="slider"`, `aria-valuenow` / `aria-valuemax`) — exact element still to be confirmed.

## Shadow DOM

Every overlay is a custom element in the light DOM with its own shadow root, so it is reachable
as `document.querySelector(tag).shadowRoot`, but its *contents* need a recursive walk:

| Purpose | Element |
| --- | --- |
| Title / season / episode | `title-overlay` (empty in captures so far — likely rendered inside the controls overlay instead) |
| Episode finished | `up-next-lite-v1` |
| Cover art | `poster-overlay` (empty so far) |

Other hosts present: `disney-web-player-ui`, `main-app-controls-overlay`, `skip-overlay`,
`preplay-overlay`, `buffering-overlay`, `inactivity-overlay`.

## Watched detection

`up-next-lite-v1` renders `<!---->` during playback and fills in at the end of the episode:

```html
<div class="up-next-lite-v1-overlay__header">NASTĘPNIE</div>
<div class="up-next-lite-v1-overlay__series-title">The Mandalorian</div>
<div class="up-next-lite-v1-overlay__episode-title">S2:O3 Rozdział 11: Spadkobierczyni</div>
```

A `MutationObserver` on its shadow root is the "watched" signal. Careful: the titles inside
describe the **next** episode, not the current one — use the element's appearance only, never
its text.

## Title source

`document.title` is `"The Mandalorian | Disney+"` — series name only, no season/episode.
The season/episode string format used by the UI is `S2:O3` in Polish locale (`O` = odcinek),
so any parser must not hardcode `S2:E3`.

## Notes

Console output on Disney+ is drowned in blocked telemetry (`log.go.com`, datadog, conviva).
Filter the console by a `WT:` prefix when debugging. Also: `copy()` is a DevTools Command Line
API function and does not exist inside a `setTimeout` callback — stash the result on `window`
and call `copy()` from the console afterwards.
