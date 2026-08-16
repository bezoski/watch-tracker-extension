/**
 * Popup UI: a searchable list of everything the content scripts have stored.
 *
 * Storage keeps one entry per episode, but the browse list collapses a series into a single
 * card showing the episode watched most recently — otherwise a season fills the whole popup.
 * Opening a card reveals every episode of that series that was tracked.
 *
 * Entries come straight from storage.js, which is loaded before this file and shares its scope.
 * Nodes are built with the DOM API rather than innerHTML, because titles are scraped from
 * third-party pages and must never be parsed as markup.
 */

const PLATFORM_LABELS = {
  disneyplus: "Disney+",
  netflix: "Netflix",
};

const browseHeader = document.getElementById("browse-header");
const searchInput = document.getElementById("search");
const list = document.getElementById("list");
const emptyMessage = document.getElementById("empty");

const detail = document.getElementById("detail");
const detailTitle = document.getElementById("detail-title");
const detailMeta = document.getElementById("detail-meta");
const detailList = document.getElementById("detail-list");
const backButton = document.getElementById("back");

/** Key of the series currently opened, or null while browsing. */
let openSeriesKey = null;

const platformLabel = (entry) => PLATFORM_LABELS[entry.platform] ?? entry.platform;
const percent = (entry) => Math.round((entry.progress ?? 0) * 100);
const episodeCode = (entry) =>
  entry.season && entry.episode ? `S${entry.season}:E${entry.episode}` : null;

/**
 * Groups episodes of the same series on the same platform. Movies have no series name, so each
 * one stays its own group keyed by its id.
 */
function groupEntries(entries) {
  const groups = new Map();

  for (const entry of entries) {
    const key = entry.series ? `${entry.platform}:${entry.series}` : entry.id;
    const group = groups.get(key);

    if (group) {
      group.episodes.push(entry);
      // Entries arrive newest first, so the first one seen is the latest.
    } else {
      groups.set(key, { key, latest: entry, episodes: [entry] });
    }
  }

  return [...groups.values()];
}

function createProgressBar(entry) {
  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("div");
  fill.className = "bar__fill";
  fill.style.width = `${percent(entry)}%`;
  bar.append(fill);
  return bar;
}

function statusLine(entry) {
  return entry.status === "watched" ? "Watched" : `${percent(entry)}% watched`;
}

function createGroupNode(group) {
  const { latest, episodes } = group;
  const isSeries = Boolean(latest.series);

  const item = document.createElement("li");
  item.className = latest.status === "watched" ? "entry entry--watched" : "entry";

  const title = document.createElement("h2");
  title.className = "entry__title";
  title.textContent = (isSeries ? latest.series : latest.title) ?? "Untitled";

  const meta = document.createElement("p");
  meta.className = "entry__meta";
  meta.textContent = [
    isSeries ? [episodeCode(latest), latest.title].filter(Boolean).join(" · ") : null,
    platformLabel(latest),
  ]
    .filter(Boolean)
    .join(" · ");

  const status = document.createElement("p");
  status.className = "entry__status";
  status.textContent = isSeries
    ? `${statusLine(latest)} · ${episodes.length} episode${episodes.length > 1 ? "s" : ""} tracked`
    : statusLine(latest);

  item.append(title, meta, createProgressBar(latest), status);

  if (isSeries) {
    item.classList.add("entry--clickable");
    item.tabIndex = 0;
    const open = () => openSeries(group);
    item.addEventListener("click", open);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") open();
    });
  } else {
    item.append(createDeleteButton(latest.id));
  }

  return item;
}

function createDeleteButton(id) {
  const remove = document.createElement("button");
  remove.className = "delete";
  remove.type = "button";
  remove.textContent = "×";
  remove.title = "Remove from history";
  remove.addEventListener("click", async (event) => {
    // Without this the click would also open the series card underneath.
    event.stopPropagation();
    await deleteEntry(id);
    openSeriesKey ? await renderDetail() : await render();
  });
  return remove;
}

function createEpisodeNode(entry) {
  const item = document.createElement("li");
  item.className = entry.status === "watched" ? "episode episode--watched" : "episode";

  const title = document.createElement("p");
  title.className = "episode__title";
  title.textContent = [episodeCode(entry), entry.title].filter(Boolean).join(" · ");

  const status = document.createElement("p");
  status.className = "episode__status";
  status.textContent = statusLine(entry);

  item.append(title, createProgressBar(entry), status, createDeleteButton(entry.id));
  return item;
}

async function openSeries(group) {
  openSeriesKey = group.key;
  await renderDetail();
}

function closeDetail() {
  openSeriesKey = null;
  detail.hidden = true;
  browseHeader.hidden = false;
  list.hidden = false;
  render();
}

async function renderDetail() {
  const groups = groupEntries(await searchEntries(""));
  const group = groups.find((candidate) => candidate.key === openSeriesKey);

  // The last episode of a series can be deleted from this very view.
  if (!group) {
    closeDetail();
    return;
  }

  browseHeader.hidden = true;
  list.hidden = true;
  emptyMessage.hidden = true;
  detail.hidden = false;

  detailTitle.textContent = group.latest.series;
  detailMeta.textContent = `${platformLabel(group.latest)} · ${group.episodes.length} tracked`;

  // Most recently watched first — the point of opening a series is "where did I stop".
  const episodes = [...group.episodes].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  detailList.replaceChildren(...episodes.map(createEpisodeNode));
}

async function render() {
  const groups = groupEntries(await searchEntries(searchInput.value));

  list.replaceChildren(...groups.map(createGroupNode));
  emptyMessage.hidden = groups.length > 0;
  emptyMessage.textContent = searchInput.value.trim() ? "No matches." : "Nothing tracked yet.";
}

searchInput.addEventListener("input", render);
backButton.addEventListener("click", closeDetail);
render();
