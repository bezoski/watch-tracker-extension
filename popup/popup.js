/**
 * Popup UI: a searchable list of everything the content scripts have stored.
 *
 * Entries come straight from storage.js, which is loaded before this file and shares its scope.
 * Nodes are built with the DOM API rather than innerHTML, because titles are scraped from
 * third-party pages and must never be parsed as markup.
 */

const PLATFORM_LABELS = {
  disneyplus: "Disney+",
  netflix: "Netflix",
};

const searchInput = document.getElementById("search");
const list = document.getElementById("list");
const emptyMessage = document.getElementById("empty");

/** "Stranger Things · S1:E4 · Netflix", skipping whatever the platform didn't provide. */
function metaLine(entry) {
  const parts = [];
  if (entry.series) parts.push(entry.series);
  if (entry.season && entry.episode) parts.push(`S${entry.season}:E${entry.episode}`);
  parts.push(PLATFORM_LABELS[entry.platform] ?? entry.platform);
  return parts.join(" · ");
}

function statusLine(entry) {
  if (entry.status === "watched") return "Watched";
  return `${Math.round((entry.progress ?? 0) * 100)}% watched`;
}

function createEntryNode(entry) {
  const item = document.createElement("li");
  item.className = entry.status === "watched" ? "entry entry--watched" : "entry";

  const title = document.createElement("h2");
  title.className = "entry__title";
  title.textContent = entry.title ?? "Untitled";

  const meta = document.createElement("p");
  meta.className = "entry__meta";
  meta.textContent = metaLine(entry);

  const bar = document.createElement("div");
  bar.className = "entry__bar";
  const fill = document.createElement("div");
  fill.className = "entry__fill";
  fill.style.width = `${Math.round((entry.progress ?? 0) * 100)}%`;
  bar.append(fill);

  const status = document.createElement("p");
  status.className = "entry__status";
  status.textContent = statusLine(entry);

  const remove = document.createElement("button");
  remove.className = "entry__delete";
  remove.textContent = "×";
  remove.title = "Remove from history";
  remove.addEventListener("click", async () => {
    await deleteEntry(entry.id);
    render();
  });

  item.append(title, meta, bar, status, remove);
  return item;
}

async function render() {
  const entries = await searchEntries(searchInput.value);

  list.replaceChildren(...entries.map(createEntryNode));
  emptyMessage.hidden = entries.length > 0;
  emptyMessage.textContent = searchInput.value.trim()
    ? "No matches."
    : "Nothing tracked yet.";
}

searchInput.addEventListener("input", render);
render();
