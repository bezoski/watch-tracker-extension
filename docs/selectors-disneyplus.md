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
plan assumed otherwise). Progress comes from the player UI progress bar instead
(`role="slider"`, `aria-valuenow` / `aria-valuemax`), whose values are confirmed to be seconds.

That slider only exists in the DOM while the controls overlay is visible, i.e. for a few seconds
after a mouse move. Between readings the last value is used as an anchor and the elapsed delta
from `video.currentTime` is added to it.

## Shadow DOM

Every overlay is a custom element in the light DOM with its own shadow root, so it is reachable
as `document.querySelector(tag).shadowRoot`, but its *contents* need a recursive walk:

| Purpose | Element |
| --- | --- |
| Title / season / episode | `title-bug` — `title-overlay` is always empty. Match on this host specifically: `pivot-tray-tile` and `up-next-lite-v1` render the same `S<n>:<E\|O><n>` shape for *other* episodes |
| Episode finished | `up-next-lite-v1` |

Other hosts present: `disney-web-player-ui`, `main-app-controls-overlay`, `skip-overlay`,
`preplay-overlay`, `buffering-overlay`, `inactivity-overlay`.

## Watched detection

`up-next-lite-v1` renders `<!---->` during playback and fills in at the end of the episode:

```html
<div class="up-next-lite-v1-overlay__header">NASTĘPNIE</div>
<div class="up-next-lite-v1-overlay__series-title">The Mandalorian</div>
<div class="up-next-lite-v1-overlay__episode-title">S2:O3 Rozdział 11: Spadkobierczyni</div>
```

A `MutationObserver` on its shadow root is the "watched" signal — verified end to end: an entry
saved as `in-progress` flips to `watched` the moment the overlay appears. Careful: the titles
inside describe the **next** episode, not the current one — use the element's appearance only,
never its text, and skip its subtree when scanning for the current episode number.

Known trade-off: seeking to the end of an episode triggers the same overlay, so it counts as
watched. Telling that apart from real playback is not possible from the DOM alone.

### Movies

A movie never fills `up-next-lite-v1` — the host is mounted, but there is nothing to offer next.
Recorded on "Gwiezdne wojny: Mroczne widmo" (runtime 8172 s):

- the credits start around 97 %, and nothing appears there — unlike Netflix, which shows its end
  screen at the start of the credits
- at the very end (99.95 %) `restart-playback` fills in: the "watch again" overlay
- the URL stays on `/play/<id>`, so there is no navigation to catch

`restart-playback` is the movie signal, with one guard: its name also fits a "start over" prompt on
resuming a film. It did not appear when a film was resumed at 97 %, but since a wrong "watched" can
never be undone, it is only believed at 90 % progress or more — or when progress is unknown, which
just means the slider was never on screen.

There is a second way a film ends, and it shows neither overlay: when autoplay is on, Disney+
goes straight to the next title (Mroczne widmo → Zemsta Sithów) and only the `/play/<id>` in the
URL changes — `restart-playback` is never even mounted. So leaving a title counts as finishing it
when its stored progress is 98 % or more. That threshold is stricter than the overlay guard,
because moving on is a weaker signal than an end screen: it has to separate autoplay at the end of
the file from someone abandoning a film in its closing minutes.

Also recorded, and not end signals: `ratings-overlay` (the age rating plate at the start of
playback) and `progress-bar-preview` (thumbnail preview while scrubbing).

## Title source

`document.title` is `"The Mandalorian | Disney+"` — series name only, no season/episode.
The season/episode string format used by the UI is `S2:O3` in Polish locale (`O` = odcinek),
so any parser must not hardcode `S2:E3`.

## Notes

Console output on Disney+ is drowned in blocked telemetry (`log.go.com`, datadog, conviva).
Filter the console by a `WT:` prefix when debugging. Also: `copy()` is a DevTools Command Line
API function and does not exist inside a `setTimeout` callback — stash the result on `window`
and call `copy()` from the console afterwards.
