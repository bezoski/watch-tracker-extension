/**
 * Netflix content script.
 *
 * The mirror image of Disney+ (see docs/selectors-netflix.md): the DOM is flat, there is one
 * <video>, and its `duration` is finite — so progress and runtime come straight from the element
 * and none of the Disney+ machinery (shadow root walks, slider scraping, progress extrapolation)
 * is needed here.
 *
 * The one thing Netflix makes harder: nothing on the page states what is playing except the
 * controls overlay, which unmounts a few seconds after the last mouse move.
 */

const PLATFORM = "netflix";
const SAVE_INTERVAL_MS = 5000;
/** Off for release. Flip it on when debugging, then filter the console by "WT:". */
const DEBUG = false;

/** While it is still unknown what is playing there is nothing in the popup at all. */
const PROBE_INTERVAL_MS = 1000;

const TITLE_OVERLAY = '[data-uia="video-title"]';
const PLAYER = '[data-uia="player"]';

/** The episode selector — the only place in the player that names the season. */
const EPISODES_BUTTON = '[data-uia="control-episodes"]';
const SELECTOR_PANEL = '[data-uia="selector-episode"]';
const SEASON_HEADER = '[data-uia="selector-episode-header"]';
const NOW_PLAYING = '[data-uia="episode-pane-item-now-playing"]';

/**
 * Episodes end on either seamless button once the credits start. Movies get neither: the player
 * shrinks into a postplay screen instead, which is why movies were never marked watched until the
 * end screen was recorded (docs/selectors-netflix.md).
 */
const END_SIGNALS = [
  '[data-uia="next-episode-seamless-button"]',
  '[data-uia="watch-credits-seamless-button"]',
  '[data-uia="postplay-player-space"]',
  '[data-uia="postplay-back-to-browse"]',
].join(", ");

let captureTimer = null;
let currentId = null;
let stopped = false;

/** Id already flagged as watched, so a button sitting on screen is not re-saved every mutation. */
let markedId = null;

/** Metadata never changes for a given content id, so the first successful reading wins. */
let mediaCache = { id: null, info: null };

/** Probes that found no title to read, counted so the console can say why nothing is saved. */
let blindProbes = 0;

/** Bumped per synthetic move, because a pointer that never changes position is not a move. */
let revealCount = 0;

/** Ids whose season has been looked up, so the selector panel flashes at most once per episode. */
const seasonPeeked = new Set();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(...args) {
  if (DEBUG) console.log("WT:", ...args);
}

function contentId() {
  return location.pathname.match(/\/watch\/(\d+)/)?.[1] ?? null;
}

/** Browse pages autoplay preview trailers, so a video element alone proves nothing. */
function findVideo() {
  return (
    [...document.querySelectorAll("video")].find((v) => v.readyState >= 1 && v.videoWidth > 0) ??
    null
  );
}

/**
 * The season is omitted entirely for single-season shows ("O1"), and the letter is locale
 * dependent — O for odcinek in Polish, E in English.
 */
const EPISODE_CODE = /^(?:S(\d+)\s*[:.]\s*)?[EO](\d+)$/i;

/** A season standing on its own: the selector's header ("Sezon 6"), or a neighbouring element. */
const SEASON_ONLY = [
  /^S(?:ezon|eason)?\s*(\d+)\s*[:.]?$/i,
  /^(\d+)\s*\.?\s*(?:sezon|season)\s*[:.]?$/i,
];

/**
 * Reads what is playing from the controls overlay, which renders the show name, the episode code
 * and the episode title as separate elements — as one string it reads "ShowO1Episode", so the
 * children have to be read individually.
 *
 * Unlike Disney+, the verdict is immediate: the presence of an episode code decides between an
 * episode and a movie, so nothing has to be inferred from waiting.
 */
function findMedia() {
  const overlay = document.querySelector(TITLE_OVERLAY);

  // Logged sparsely rather than every probe: a title that never resolves would flood the console,
  // but staying silent here makes "not mounted" indistinguishable from the script not running.
  if (!overlay) {
    if (blindProbes++ % 10 === 0) log("no title overlay in the DOM, probe", blindProbes);
    return null;
  }

  // An episode's overlay nests its lines in elements, so the leaves are what hold the text. A
  // movie's is a single div wrapping a bare text node — no leaf element to walk, hence the
  // fallback to the overlay's own text.
  const leaves = [...overlay.querySelectorAll("*")]
    .filter((el) => !el.children.length)
    .map((el) => el.textContent?.trim())
    .filter(Boolean);

  const texts = leaves.length ? leaves : [overlay.textContent?.trim()].filter(Boolean);

  if (!texts.length) {
    if (blindProbes++ % 10 === 0) log("title overlay has no text:", overlay.outerHTML.slice(0, 300));
    return null;
  }

  log("title overlay reads", texts);

  const codeIndex = texts.findIndex((text) => EPISODE_CODE.test(text));
  if (codeIndex === -1) return { series: null, season: null, episode: null, title: texts[0] };

  const [, inlineSeason, episode] = texts[codeIndex].match(EPISODE_CODE);

  // Kept for the shapes where a season does appear — a neighbouring element, or "S6:O3" inline.
  const neighbouringSeason = texts
    .flatMap((text) => SEASON_ONLY.map((pattern) => text.match(pattern)?.[1]))
    .find(Boolean);

  const season = inlineSeason ?? neighbouringSeason;

  return {
    series: texts[0],
    // The player states the episode number but not the season — that is only shown on the title's
    // own page, which is gone by the time playback starts. Defaulting to 1 would not be a
    // fallback but an invention: it filed a season 6 episode under season 1. Unknown stays null.
    season: season ? Number(season) : null,
    episode: Number(episode),
    title: texts[codeIndex + 1] ?? null,
  };
}

const clamp = (value) => Math.min(1, Math.max(0, value));

/** Finite duration, unlike Disney+, so the element's own clock is the whole story. */
function findProgress(video) {
  if (!Number.isFinite(video.duration) || video.duration <= 0) return null;
  return clamp(video.currentTime / video.duration);
}

/**
 * Nothing states the title outside the controls overlay, so a viewer who never touches the mouse
 * would never get an entry at all. One synthetic move makes Netflix mount it, and it is sent only
 * while the title is still unknown, so the controls do not keep flashing for the rest of playback.
 *
 * The event is specific, not interchangeable: `pointermove` on the player is the only combination
 * Netflix acts on — `mousemove`, `mouseover` and `keydown` were all ignored, as was every other
 * target tried (window, document, the html element, watch-video, video-canvas, the video itself).
 * A plain MouseEvent is what was verified to work, so PointerEvent is deliberately not used.
 */
function revealControls() {
  const player = document.querySelector(PLAYER);
  if (!player) return;

  player.dispatchEvent(
    new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 100 + ((revealCount++ * 37) % 300),
      clientY: 300,
      movementX: 7,
      movementY: 5,
    })
  );
}

/**
 * Reads the season from the episode selector, which is the only part of the player that names it.
 *
 * This is deliberate UI poking: the panel is opened, read and closed again, so the viewer sees it
 * flash. That cost is why it happens once per episode and only when the season is still unknown —
 * and why it runs after the entry has already been saved, so a failed peek never delays the popup.
 */
async function peekSeason() {
  revealControls();
  await wait(400);

  const button = document.querySelector(EPISODES_BUTTON);
  if (!button) {
    log("episode selector button not on screen, season stays unknown");
    return null;
  }

  button.click();
  await wait(800);

  const header = document.querySelector(SEASON_HEADER)?.textContent?.trim();

  // The panel remembers whichever season was browsed last, so the header alone proves nothing.
  // The "now playing" marker is what ties the season on screen to the episode being played.
  const showsCurrentEpisode = Boolean(document.querySelector(NOW_PLAYING));
  const season = SEASON_ONLY.map((pattern) => header?.match(pattern)?.[1]).find(Boolean);

  await closeSelector(button);

  if (!season || !showsCurrentEpisode) {
    log("season not readable from the selector", { header, showsCurrentEpisode });
    return null;
  }

  log("season read from the episode selector:", season);
  return Number(season);
}

/** The panel can linger in the DOM once dismissed, so presence on its own does not mean open. */
function selectorOpen() {
  const panel = document.querySelector(SELECTOR_PANEL);
  return Boolean(panel?.getClientRects().length);
}

/** Closing is animated, so the state is polled rather than sampled once. */
async function waitUntilClosed(timeout) {
  for (let waited = 0; waited < timeout; waited += 100) {
    if (!selectorOpen()) return true;
    await wait(100);
  }
  return !selectorOpen();
}

/**
 * Leaving the panel open over someone's episode is the one outcome worth several attempts. None of
 * them touches the player surface: a click there toggles pause, and a tracker must not stop
 * playback to answer a question about a season.
 */
async function closeSelector(button) {
  const escape = (target) => () =>
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));

  for (const close of [() => button.click(), escape(document), escape(window)]) {
    close();
    if (await waitUntilClosed(700)) return;
  }

  log("episode selector would not close — dismiss it by hand, and tell me");
}

async function capture(reason) {
  // Reloading or updating the extension orphans this script; chrome.* calls then throw.
  if (!chrome.runtime?.id) {
    stopped = true;
    clearTimeout(captureTimer);
    log("extension context invalidated — stopping, reload the page");
    return;
  }

  const id = contentId();
  if (!id) return;

  // Netflix plays the next episode without reloading the page, so the id changes under us.
  if (id !== currentId) {
    currentId = id;
    log("now playing", id);
  }

  const video = findVideo();
  if (!video) return;

  // Nothing moves while paused, so re-saving the same numbers would only spam storage.
  if (video.paused && reason === "tick") return;

  const cached = mediaCache.id === id ? mediaCache.info : null;
  const media = cached ?? findMedia();

  // Saving before the overlay has been seen would create an entry with no series to group it
  // under, which shows up in the popup as a second, nameless card for the same show.
  if (!media) {
    revealControls();
    return;
  }

  if (!cached) {
    log("media identified", media);
    mediaCache = { id, info: media };
  }

  const saved = await saveEntry({
    id: `${PLATFORM}:${id}`,
    platform: PLATFORM,
    ...media,
    progress: findProgress(video) ?? undefined,
    duration: Number.isFinite(video.duration) ? Math.round(video.duration) : undefined,
  });

  log(reason, saved);

  // Only episodes, only once, and only while the season is missing: on this account the player
  // itself never states it, so the selector is the only source (docs/selectors-netflix.md).
  if (media.series && media.season === null && !seasonPeeked.has(id)) {
    seasonPeeked.add(id);

    const season = await peekSeason();
    if (!season) return;

    mediaCache = { id, info: { ...media, season } };
    log("season filled in", await saveEntry({ id: `${PLATFORM}:${id}`, season }));
  }
}

/** One flag per id, because both end signals and the `ended` event can fire for the same episode. */
async function markWatchedOnce(reason) {
  const id = contentId();
  if (!id || id === markedId) return;

  markedId = id;
  log(reason, "→ marking watched");

  await capture("final capture");
  await markWatched(`${PLATFORM}:${id}`);
}

/**
 * The end screens replace the controls rather than living in them, so they are caught on the
 * body. The observer is kept running: Netflix rolls straight into the next episode, which has to
 * be marked in turn.
 */
function watchForEnd() {
  new MutationObserver(() => {
    if (document.querySelector(END_SIGNALS)) markWatchedOnce("end screen detected");
  }).observe(document.body, { childList: true, subtree: true });

  log("watching for the end screen");
}

/** The player mounts long after document_idle, so wait for it rather than assuming it exists. */
function waitForPlayer() {
  const video = findVideo();
  if (!video) {
    setTimeout(waitForPlayer, 1000);
    return;
  }

  // Never seen firing — a movie keeps playing through its credits while the postplay screen is
  // up — but it costs nothing and covers a title with no end screen at all.
  video.addEventListener("ended", () => markWatchedOnce("video ended"));

  capture("initial capture");
  scheduleCapture();
  watchForEnd();
}

/** A self-rescheduling timer rather than an interval, because the delay changes once identified. */
function scheduleCapture() {
  if (stopped) return;

  // Matched against the id being played, so a seamless jump to the next episode drops back to the
  // fast cadence instead of coasting on the previous episode's identification.
  const identified = mediaCache.id === currentId && mediaCache.info;

  captureTimer = setTimeout(async () => {
    await capture("tick");
    scheduleCapture();
  }, identified ? SAVE_INTERVAL_MS : PROBE_INTERVAL_MS);
}

/** The whole site is one SPA, so this script also loads on browse pages, where there is no id. */
function start() {
  if (!contentId()) {
    setTimeout(start, 2000);
    return;
  }
  waitForPlayer();
}

log("Netflix content script loaded");
start();
