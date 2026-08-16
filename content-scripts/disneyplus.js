/**
 * Disney+ content script.
 *
 * The whole player UI lives in nested shadow roots (see docs/selectors-disneyplus.md), so
 * every lookup here walks shadow roots recursively instead of using document.querySelector.
 *
 * Progress does NOT come from the video element: duration is Infinity and the MediaSource is
 * swapped mid-playback, so currentTime is meaningless. It is read from the player's progress
 * slider instead, with the video element used only to tell whether playback is live.
 */

const PLATFORM = "disneyplus";
const SAVE_INTERVAL_MS = 5000;
const DEBUG = true;

let captureTimer = null;
let currentId = null;

function log(...args) {
  if (DEBUG) console.log("WT:", ...args);
}

/** Every element in the page, descending into open shadow roots. */
function deepAll(root = document, out = []) {
  for (const el of root.querySelectorAll("*")) {
    out.push(el);
    if (el.shadowRoot) deepAll(el.shadowRoot, out);
  }
  return out;
}

function contentId() {
  return location.pathname.match(/\/play\/([0-9a-f-]{36})/)?.[1] ?? null;
}

/** Index 0 is a decoy element with no source; the playing one has decoded frames. */
function findVideo() {
  return [...document.querySelectorAll("video")]
    .find((v) => v.readyState >= 1 && v.videoWidth > 0) ?? null;
}

/** Last slider reading, kept so progress can be extrapolated while the controls are hidden. */
let anchor = null;

function readSlider(all) {
  const slider = all.find(
    (el) => el.getAttribute?.("role") === "slider" && el.hasAttribute?.("aria-valuemax")
  );
  if (!slider) return null;

  const now = Number(slider.getAttribute("aria-valuenow"));
  const max = Number(slider.getAttribute("aria-valuemax"));
  if (!Number.isFinite(now) || !Number.isFinite(max) || max <= 0) return null;

  return { now, max, text: slider.getAttribute("aria-valuetext") };
}

const clamp = (value) => Math.min(1, Math.max(0, value));

/**
 * The progress bar only exists in the DOM while the controls overlay is visible, which is a few
 * seconds after the last mouse move. Between readings, playback still advances the video
 * element's clock, so the elapsed delta is added to the last known slider position.
 */
function findProgress(all, video) {
  const slider = readSlider(all);

  if (slider) {
    anchor = { ...slider, videoTime: video.currentTime };
    return clamp(slider.now / slider.max);
  }

  // Slider units are assumed to be seconds; a tiny max would mean percent instead, in which
  // case adding a seconds delta would be nonsense.
  if (anchor && anchor.max > 300 && Number.isFinite(video.currentTime)) {
    const elapsed = video.currentTime - anchor.videoTime;
    if (elapsed >= 0) return clamp((anchor.now + elapsed) / anchor.max);
  }

  return null;
}

/** Series name comes from the tab title; the player never shows it outside the controls. */
function seriesName() {
  return document.title.replace(/\s*\|\s*Disney\+\s*$/, "").trim() || null;
}

/** Metadata never changes for a given content id, so the first successful reading wins. */
let mediaCache = { id: null, info: null };

/** Captures spent waiting for an episode line before settling on "this is a movie". */
let movieAttempts = 0;

/**
 * The current episode is named in the `title-bug` overlay. Several other overlays render the
 * same "S2:O3" shape for *other* episodes (`pivot-tray-tile` for the up-next tray,
 * `up-next-lite-v1` at the end), so matching by element rather than excluding known offenders
 * is the only reliable rule.
 */
const TITLE_HOST = "title-bug";

function hostOf(el) {
  return el.getRootNode?.()?.host?.tagName?.toLowerCase() ?? "(document)";
}

/**
 * Reads what is playing from the title bug, which shows "S2:O3 Rozdział 11: Spadkobierczyni"
 * for episodes and a plain name for movies. The season/episode letter is locale dependent
 * (O = odcinek in Polish, E in English), hence the loose character class.
 *
 * Returns null until the title bug is on screen — the caller then skips saving, so an entry is
 * never written without knowing whether it belongs to a series.
 */
function findMedia(all, id) {
  if (mediaCache.id === id) return mediaCache.info;

  // The title bug holds several lines — the show name and, for episodes, a separate line with
  // the episode code. Which line renders first is not guaranteed, so all of them are searched.
  const texts = all
    .filter((el) => !el.children.length && hostOf(el) === TITLE_HOST)
    .map((el) => el.textContent?.trim())
    .filter(Boolean);

  if (!texts.length) return null;

  const match = texts.map((text) => text.match(/S(\d+)\s*[:.]\s*[EO](\d+)\s*(.*)/i)).find(Boolean);

  // A movie's title bug never grows an episode line, but an episode's may lag a tick behind, so
  // the "no episode code" verdict is only trusted after a few attempts.
  if (!match && ++movieAttempts < 4) return null;

  const info = match
    ? {
        series: seriesName(),
        season: Number(match[1]),
        episode: Number(match[2]),
        title: match[3].replace(/^[\s:–-]+/, "").trim() || null,
      }
    : { series: null, season: null, episode: null, title: texts[0] };

  log("media identified", info);
  mediaCache = { id, info };
  return info;
}

async function capture(reason) {
  // Reloading or updating the extension orphans this script; chrome.* calls then throw.
  if (!chrome.runtime?.id) {
    clearInterval(captureTimer);
    log("extension context invalidated — stopping, reload the page");
    return;
  }

  const id = contentId();
  if (!id) return;

  // Disney+ is an SPA: switching episodes changes the URL without reloading this script, so the
  // previous episode's progress anchor has to be dropped or it would be applied to the new one.
  if (id !== currentId) {
    currentId = id;
    anchor = null;
    movieAttempts = 0;
    log("now playing", id);
  }

  const video = findVideo();
  if (!video) return;

  // Nothing moves while paused, so re-saving the same numbers would only spam storage.
  if (video.paused && reason === "tick") return;

  const all = deepAll();
  const media = findMedia(all, id);

  // Saving before the title bug appears would create an entry with no series to group it under,
  // which shows up in the popup as a second, nameless card for the same show.
  if (!media) return;

  const saved = await saveEntry({
    id: `${PLATFORM}:${id}`,
    platform: PLATFORM,
    ...media,
    progress: findProgress(all, video) ?? undefined,
  });

  log(reason, saved);
}

/**
 * The "up next" overlay renders an empty comment node during playback and fills in once the
 * episode ends. Its own text names the *next* episode, so only its appearance is used.
 */
function watchForEnd() {
  const host = document.querySelector("up-next-lite-v1");
  if (!host?.shadowRoot) return false;

  new MutationObserver(async () => {
    if (!host.shadowRoot.querySelector(".up-next-lite-v1-overlay")) return;
    const id = contentId();
    if (!id) return;

    log("up-next detected → marking watched");
    await capture("final capture");
    await markWatched(`${PLATFORM}:${id}`);
  }).observe(host.shadowRoot, { childList: true, subtree: true });

  log("watching up-next-lite-v1 for end of episode");
  return true;
}

/** The player mounts long after document_idle, so wait for it rather than assuming it exists. */
function waitForPlayer() {
  if (findVideo() && watchForEnd()) {
    capture("initial capture");
    captureTimer = setInterval(() => capture("tick"), SAVE_INTERVAL_MS);
    return;
  }
  setTimeout(waitForPlayer, 1000);
}

log("Disney+ content script loaded");
waitForPlayer();
