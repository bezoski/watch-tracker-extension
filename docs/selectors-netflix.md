# Netflix DOM recon

Findings from a playing episode (`/watch/81942416`), captured at three moments: controls hidden,
controls visible, and end of episode. Netflix is the opposite of Disney+ in almost every respect —
the video element is trustworthy and the DOM is flat, but the metadata is fleeting.

## Content id

URL: `/watch/81942416` — numeric, no locale prefix:

```js
location.pathname.match(/\/watch\/(\d+)/)?.[1]
```

The whole site is one SPA, so this script also loads on browse pages, where there is no id at all
(and browse autoplays preview trailers, so a `<video>` being present proves nothing).

## The video element is usable

One `<video>`, `readyState 4`, `1920` wide, `blob:` src — and **`duration` is finite** (`758.75`
for a 12-minute episode, stable across all three captures). So unlike Disney+:

- progress is `currentTime / duration`, no progress bar to scrape, no extrapolation anchor
- the runtime for "time left" comes free from the same element, with no controls overlay needed
- no shadow DOM anywhere: `shadowHosts` was empty in every capture

## Title only exists while the controls are visible

`document.title` is just `"Netflix"` — no show name, nothing. The only statement of what is
playing is `[data-uia="video-title"]`, which is part of the controls overlay and **unmounts a few
seconds after the last mouse move**. Captured with controls hidden: absent. With controls visible:

```
video-title → "Bogdan Boner: EgzorcystaO1Zakopane"
```

That is three children read as one string: show name, episode code, episode title. They have to be
read as separate elements, not as `textContent`.

## Movie vs episode

The episode code among those children is the signal, so the verdict is immediate — no waiting game
like on Disney+, where absence had to be inferred over several probes. A movie's title overlay has
the name only.

Format is locale dependent and the season is **omitted entirely for single-season shows**: this
capture shows `O1` (O = odcinek in Polish), a multi-season title shows `S2:O3`, and English locale
uses `E`. Hence `/^(?:S(\d+)\s*[:.]\s*)?[EO](\d+)$/i` — and a missing season is stored as 1.

## Watched detection

At the end of the episode the controls are replaced by two buttons, either of which means the
episode reached its credits:

```
next-episode-seamless-button
watch-credits-seamless-button
```

A `MutationObserver` on `document.body` waiting for either is the signal. `video-title` and
`controls-standard` are gone by then, which is why metadata must be captured earlier.

Unverified: what a **movie** shows at its end — no movie capture was taken. A `video.ended`
listener is wired up as a fallback, but the real end screen still needs a recon pass.

## Full `data-uia` inventory

Playback, controls hidden: `player`, `video-canvas`, `watch-video`,
`watch-video-player-view-minimized`, `notification-manager-toast-group`, `botLink`, `loc`.

Controls visible adds: `controls-standard`, `controls-time-remaining`, `video-title`, `timeline`,
`timeline-bar`, `timeline-knob`, `control-play-pause-pause`, `control-next`, `control-episodes`,
`control-back10`, `control-forward10`, `control-speed`, `control-volume-off`,
`control-audio-subtitle`, `control-fullscreen-enter`, `control-nav-back`, `control-flag`.

End of episode: `next-episode-seamless-button`, `watch-credits-seamless-button`, `nfplayer-exit`,
`control-nav-back`.

## Notes

`[class*="title"]` also matches `ot-title-cntr`, the OneTrust cookie banner container, in every
capture. Match on `data-uia` only.
