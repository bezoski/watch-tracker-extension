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
const DEBUG = true;

/** While it is still unknown what is playing there is nothing in the popup at all. */
const PROBE_INTERVAL_MS = 1000;

const TITLE_OVERLAY = '[data-uia="video-title"]';
const PLAYER = '[data-uia="player"]';

/** Either button means the episode reached its credits. */
const END_SIGNALS =
  '[data-uia="next-episode-seamless-button"], [data-uia="watch-credits-seamless-button"]';

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

  const [, season, episode] = texts[codeIndex].match(EPISODE_CODE);

  return {
    series: texts[0],
    // Netflix leaves the season out for single-season shows; the popup groups episodes by season,
    // so the implicit first one is spelled out rather than stored as null.
    season: Number(season ?? 1),
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
 * The end-of-episode buttons replace the controls rather than living in them, so they are caught
 * on the body. The observer is kept running: Netflix rolls straight into the next episode, which
 * has to be marked in turn.
 */
function watchForEnd() {
  new MutationObserver(() => {
    if (document.querySelector(END_SIGNALS)) markWatchedOnce("end-of-episode controls detected");
  }).observe(document.body, { childList: true, subtree: true });

  log("watching for end-of-episode controls");
}

/** The player mounts long after document_idle, so wait for it rather than assuming it exists. */
function waitForPlayer() {
  const video = findVideo();
  if (!video) {
    setTimeout(waitForPlayer, 1000);
    return;
  }

  // Movies may get no seamless button at all — what their end screen looks like is still an open
  // question (docs/selectors-netflix.md), so the element reaching its end serves as a fallback.
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
