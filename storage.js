/**
 * Shared storage layer for Watch Tracker.
 *
 * Everything lives under a single chrome.storage.local key ("entries"),
 * an object keyed by entry id so upserts are a plain property write.
 *
 * Entry shape:
 *   id         "netflix:81234567" — platform + id from the URL (stable, unlike the title)
 *   platform   "netflix" | "disneyplus"
 *   title      episode title, or movie title
 *   series     series name, null for movies
 *   season     number, null for movies
 *   episode    number, null for movies
 *   poster     image URL, null when not found
 *   progress   0–1
 *   duration   runtime in seconds, missing until the platform reveals it
 *   status     "in-progress" | "watched"
 *   updatedAt  epoch ms
 */

const STORAGE_KEY = "entries";

async function getEntries() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] ?? {};
}

async function setEntries(entries) {
  await chrome.storage.local.set({ [STORAGE_KEY]: entries });
}

/** Drops undefined values so a missing selector never wipes an already stored field. */
function definedFields(entry) {
  return Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined)
  );
}

/**
 * Inserts or updates an entry.
 * Never downgrades "watched" back to "in-progress" and never lowers progress,
 * so rewinding or re-opening a finished episode can't erase what we know.
 */
async function saveEntry(entry) {
  if (!entry?.id) throw new Error("saveEntry: entry.id is required");

  const entries = await getEntries();
  const existing = entries[entry.id];
  const incoming = definedFields(entry);

  const merged = { ...existing, ...incoming, updatedAt: Date.now() };

  if (existing) {
    if (existing.status === "watched") {
      merged.status = "watched";
    }
    merged.progress = Math.max(existing.progress ?? 0, incoming.progress ?? 0);
  }

  merged.status = merged.status ?? "in-progress";
  merged.progress = merged.progress ?? 0;

  entries[entry.id] = merged;
  await setEntries(entries);
  return merged;
}

async function markWatched(id) {
  const entries = await getEntries();
  const existing = entries[id];
  if (!existing) return null;

  entries[id] = {
    ...existing,
    status: "watched",
    progress: 1,
    updatedAt: Date.now(),
  };
  await setEntries(entries);
  return entries[id];
}

/** Returns a list sorted by most recently updated. An empty query returns everything. */
async function searchEntries(query = "") {
  const entries = Object.values(await getEntries());
  const needle = query.trim().toLowerCase();

  const matches = needle
    ? entries.filter(
        (entry) =>
          entry.title?.toLowerCase().includes(needle) ||
          entry.series?.toLowerCase().includes(needle)
      )
    : entries;

  return matches.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

async function deleteEntry(id) {
  const entries = await getEntries();
  if (!(id in entries)) return false;

  delete entries[id];
  await setEntries(entries);
  return true;
}
