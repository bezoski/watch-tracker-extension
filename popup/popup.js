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

const TYPE_FILTERS = [
  { label: "All", value: "all" },
  { label: "Movies", value: "movie" },
  { label: "Series", value: "series" },
];

const browseHeader = document.getElementById("browse-header");
const searchInput = document.getElementById("search");
const typeFilters = document.getElementById("type-filters");
const platformFilters = document.getElementById("platform-filters");
const list = document.getElementById("list");
const emptyMessage = document.getElementById("empty");

const detail = document.getElementById("detail");
const detailTitle = document.getElementById("detail-title");
const detailMeta = document.getElementById("detail-meta");
const detailList = document.getElementById("detail-list");
const seasonFilters = document.getElementById("seasons");
const backButton = document.getElementById("back");

/** Key of the series currently opened, or null while browsing. */
let openSeriesKey = null;

/** Season shown in the detail view; null means all of them. */
let selectedSeason = null;

/** Browse-list filters: one of TYPE_FILTERS, and a platform key or null for every platform. */
let typeFilter = "all";
let platformFilter = null;

const platformLabel = (entry) => PLATFORM_LABELS[entry.platform] ?? entry.platform;
/** A missing series name is what makes something a movie — there is no type field to read. */
const typeLabel = (entry) => (entry.series ? "Series" : "Movie");
/**
 * Rounded down: rounding up turned 99.96 % into "100% watched" on an entry that was not watched,
 * which contradicts the status next to it. Only "watched" is allowed to mean the end.
 */
const percent = (entry) =>
  entry.status === "watched" ? 100 : Math.floor((entry.progress ?? 0) * 100);
/** Netflix states the episode but not the season, so the code has to read without one. */
const episodeCode = (entry) => {
  if (!entry.episode) return null;
  return entry.season ? `S${entry.season}:E${entry.episode}` : `E${entry.episode}`;
};

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

function createTag(label, className) {
  const tag = document.createElement("span");
  tag.className = `tag ${className}`;
  tag.textContent = label;
  return tag;
}

/** The platform tag wears the platform's own colours, so it reads at a glance without the text. */
function createTags(entry) {
  const row = document.createElement("div");
  row.className = "tags";
  row.append(
    createTag(typeLabel(entry), "tag--type"),
    createTag(platformLabel(entry), `tag--platform tag--${entry.platform}`)
  );
  return row;
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

/**
 * "55 min left" / "1 h 02 min left". Needs a runtime, which only shows up once the platform's
 * progress bar has been read at least once, so entries can exist without one.
 */
function timeLeft(entry) {
  if (!entry.duration) return null;

  const minutes = Math.round((entry.duration * (1 - (entry.progress ?? 0))) / 60);
  if (minutes < 1) return "less than a minute left";

  const hours = Math.floor(minutes / 60);
  return hours
    ? `${hours} h ${String(minutes % 60).padStart(2, "0")} min left`
    : `${minutes} min left`;
}

function statusLine(entry) {
  if (entry.status === "watched") return "Watched";
  return [`${percent(entry)}% watched`, timeLeft(entry)].filter(Boolean).join(" · ");
}

function createGroupNode(group) {
  const { latest, episodes } = group;
  const isSeries = Boolean(latest.series);

  const item = document.createElement("li");
  item.className = latest.status === "watched" ? "entry entry--watched" : "entry";

  const title = document.createElement("h2");
  title.className = "entry__title";
  title.textContent = (isSeries ? latest.series : latest.title) ?? "Untitled";

  const status = document.createElement("p");
  status.className = "entry__status";
  status.textContent = isSeries
    ? `${statusLine(latest)} · ${episodes.length} episode${episodes.length > 1 ? "s" : ""} watched`
    : statusLine(latest);

  item.append(title, createTags(latest));

  // Movies have nothing left to say here: their name is the heading and the rest is in the tags.
  if (isSeries) {
    const meta = document.createElement("p");
    meta.className = "entry__meta";
    meta.textContent = [episodeCode(latest), latest.title].filter(Boolean).join(" · ");
    item.append(meta);
  }

  item.append(createProgressBar(latest), status);

  if (isSeries) {
    item.classList.add("entry--clickable");
    item.tabIndex = 0;
    const open = () => openSeries(group);
    item.addEventListener("click", open);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") open();
    });
  } else {
    item.append(createActions(latest));
  }

  return item;
}

/** Redraws whichever view is open, after an entry was changed from inside it. */
const rerender = () => (openSeriesKey ? renderDetail() : render());

function createActionButton(label, title, modifier, action) {
  const button = document.createElement("button");
  button.className = `action action--${modifier}`;
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", async (event) => {
    // Without this the click would also open the series card underneath.
    event.stopPropagation();
    await action();
    await rerender();
  });
  return button;
}

/**
 * Every automatic "watched" signal has a gap somewhere — a tab closed during the credits, an end
 * screen no recon has seen — so the popup has the final say. Only offered while unwatched: there
 * is deliberately no way back, matching storage, which never downgrades a watched entry either.
 */
function createActions(entry) {
  const actions = document.createElement("div");
  actions.className = "actions";

  if (entry.status !== "watched") {
    actions.append(
      createActionButton("✓", "Mark as watched", "watched", () => markWatched(entry.id))
    );
  }

  actions.append(
    createActionButton("×", "Remove from history", "delete", () => deleteEntry(entry.id))
  );
  return actions;
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

  item.append(title, createProgressBar(entry), status, createActions(entry));
  return item;
}

/** `modifier` names a variant class, such as a platform key for the brand-coloured chips. */
function createChip(label, isActive, onSelect, modifier) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = ["chip", modifier && `chip--${modifier}`, isActive && "chip--active"]
    .filter(Boolean)
    .join(" ");
  button.textContent = label;
  button.addEventListener("click", onSelect);
  return button;
}

function renderTypeFilters() {
  typeFilters.replaceChildren(
    ...TYPE_FILTERS.map(({ label, value }) =>
      createChip(label, value === typeFilter, () => {
        typeFilter = value;
        render();
      })
    )
  );
}

/**
 * Platform chips are worth showing only once the history holds more than one platform — with a
 * single one every chip would filter to the same list. They come from what is stored, so Netflix
 * appears by itself the first time something is tracked there.
 */
function renderPlatformFilters(entries) {
  const platforms = [...new Set(entries.map((entry) => entry.platform))].sort();

  platformFilters.hidden = platforms.length < 2;

  if (platforms.length < 2 || !platforms.includes(platformFilter)) platformFilter = null;
  if (platforms.length < 2) return;

  platformFilters.replaceChildren(
    createChip("All", platformFilter === null, () => {
      platformFilter = null;
      render();
    }),
    ...platforms.map((platform) =>
      createChip(
        PLATFORM_LABELS[platform] ?? platform,
        platform === platformFilter,
        () => {
          platformFilter = platform;
          render();
        },
        platform
      )
    )
  );
}

/**
 * Season chips are derived from the episodes actually stored, so a season shows up by itself
 * once anything from it has been watched — there is nothing to configure.
 */
function renderSeasonFilters(episodes) {
  const seasons = [...new Set(episodes.map((entry) => entry.season).filter(Boolean))].sort(
    (a, b) => a - b
  );

  seasonFilters.hidden = seasons.length === 0;
  if (seasons.length === 0) return;

  seasonFilters.replaceChildren(
    createChip("All", selectedSeason === null, () => {
      selectedSeason = null;
      renderDetail();
    }),
    ...seasons.map((season) =>
      createChip(`Season ${season}`, season === selectedSeason, () => {
        selectedSeason = season;
        renderDetail();
      })
    )
  );
}

function matchesFilters(group) {
  const isSeries = Boolean(group.latest.series);

  if (typeFilter === "movie" && isSeries) return false;
  if (typeFilter === "series" && !isSeries) return false;

  return platformFilter === null || group.latest.platform === platformFilter;
}

async function openSeries(group) {
  openSeriesKey = group.key;
  selectedSeason = null;
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
  detailMeta.textContent = [
    typeLabel(group.latest),
    platformLabel(group.latest),
    `${group.episodes.length} watched`,
  ].join(" · ");

  // The selected season may disappear when its last episode is deleted — checked before the chips
  // are drawn, so none of them is left highlighted for a season that is no longer there.
  const seasonExists = group.episodes.some((entry) => entry.season === selectedSeason);
  if (selectedSeason !== null && !seasonExists) selectedSeason = null;

  renderSeasonFilters(group.episodes);

  // Most recently watched first — the point of opening a series is "where did I stop".
  const episodes = group.episodes
    .filter((entry) => selectedSeason === null || entry.season === selectedSeason)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  detailList.replaceChildren(...episodes.map(createEpisodeNode));
}

async function render() {
  // Chips describe the whole history, not the current search, so they do not vanish while typing.
  renderTypeFilters();
  renderPlatformFilters(Object.values(await getEntries()));

  const groups = groupEntries(await searchEntries(searchInput.value)).filter(matchesFilters);

  list.replaceChildren(...groups.map(createGroupNode));
  emptyMessage.hidden = groups.length > 0;

  const narrowed = searchInput.value.trim() || typeFilter !== "all" || platformFilter !== null;
  emptyMessage.textContent = narrowed ? "No matches." : "Nothing tracked yet.";
}

searchInput.addEventListener("input", render);
backButton.addEventListener("click", closeDetail);
render();
