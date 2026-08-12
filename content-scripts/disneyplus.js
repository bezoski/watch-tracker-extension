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
function findSeries() {
  return document.title.replace(/\s*\|\s*Disney\+\s*$/, "").trim() || null;
}

/** Season/episode never changes for a given content id, so the first reading wins. */
let episodeCache = { id: null, info: null };

/**
 * Overlays that advertise the *next* episode carry the same "S2:O3" text as the current one.
 * They live in their own shadow roots, so the host element identifies them.
 */
function isNextEpisodeUi(el) {
  const host = el.getRootNode?.()?.host?.tagName?.toLowerCase() ?? "";
  return host.includes("up-next") || String(el.className).includes("up-next");
}

/**
 * Season/episode is rendered as "S2:O3 Rozdział 11: Spadkobierczyni" — the letter is locale
 * dependent (O = odcinek in Polish, E in English), hence the loose character class.
 */
function findEpisodeInfo(all, id) {
  if (episodeCache.id === id) return episodeCache.info;

  for (const el of all) {
    if (el.children.length) continue;
    if (isNextEpisodeUi(el)) continue;
    const text = el.textContent?.trim();
    if (!text) continue;

    const match = text.match(/S(\d+)\s*[:.]\s*[EO](\d+)\s*(.*)/i);
    if (match) {
      episodeCache = {
        id,
        info: {
          season: Number(match[1]),
          episode: Number(match[2]),
          title: match[3].replace(/^[\s:–-]+/, "").trim() || null,
        },
      };
      return episodeCache.info;
    }
  }
  return null;
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

  const video = findVideo();
  if (!video) return;

  // Nothing moves while paused, so re-saving the same numbers would only spam storage.
  if (video.paused && reason === "tick") return;

  const all = deepAll();
  const progress = findProgress(all, video);
  const episode = findEpisodeInfo(all, id);
  const series = findSeries();

  const saved = await saveEntry({
    id: `${PLATFORM}:${id}`,
    platform: PLATFORM,
    title: episode?.title ?? series,
    series: episode ? series : null,
    season: episode?.season ?? null,
    episode: episode?.episode ?? null,
    progress: progress ?? undefined,
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
