// The Library Check page: starts a scan of the download folder and shows what
// it found: broken videos and sets of duplicates, with removal to the trash.

import { formatBytes, formatDuration, scanSummary } from "./grouping.js";

const HOST_NAME = "dev.arda.ytdlp_host";
const PAGE_SIZE = 40;
const POLL_MS = 2000;
const THUMBNAIL_BATCH = 24;

const TABS = {
  broken: "Files that are empty, unreadable or cut short. Check one before removing it; a broken file is usually worth downloading again.",
  identical: "Byte-for-byte the same video saved more than once. The first copy of each set is kept.",
  similar: "The same length and the same pictures, so most likely one video at different qualities. The largest picture is listed first. Play them before removing anything.",
};

const elements = Object.fromEntries(
  [
    "message", "scan-summary", "library-root", "scan-button", "scan-progress", "scan-fill",
    "tab-broken", "tab-identical", "tab-similar", "bulk-button", "tab-hint", "report-list", "more-button",
  ].map((id) => [id, document.getElementById(id)])
);

let status = { state: "never" };
let tab = "identical";
let items = [];
let total = 0;
let pollTimer = null;
const thumbnails = new Map();
const missingThumbnails = new Set();

function showMessage(kind, text) {
  elements.message.className = `message ${kind}`;
  elements.message.textContent = text;
}

function callHost(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function hostAction(payload, failure) {
  const response = await callHost(payload);
  if (!response?.ok) {
    throw new Error(response?.error || failure);
  }
  return response;
}

function makeButton(label, title, extraClass, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `download-action-button ${extraClass}`.trim();
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", onClick);
  return button;
}

function fileActions(path) {
  const actions = document.createElement("div");
  actions.className = "download-actions";
  actions.append(
    makeButton("Play", "Open this video in the configured player", "", () => {
      void fileAction("play_library_file", path);
    }),
    makeButton("Folder", "Open the containing folder", "button-muted-small", () => {
      void fileAction("open_library_folder", path);
    }),
    makeButton("Trash", "Move this video to the trash folder", "button-danger", () => {
      void trash([path]);
    })
  );
  return actions;
}

function makeBrokenItem(item) {
  const row = document.createElement("article");
  row.className = "download-item";
  const main = document.createElement("div");
  main.className = "download-main";
  const title = document.createElement("p");
  title.className = "download-title";
  title.textContent = item.path;
  main.append(title, fileActions(item.path));
  const error = document.createElement("p");
  error.className = "download-error";
  error.textContent = `${formatBytes(item.size)}: ${item.error}`;
  row.append(main, error);
  return row;
}

function makeFileTile(file, keep) {
  const tile = document.createElement("article");
  tile.className = "download-tile";

  const picture = document.createElement("div");
  picture.className = "tile-picture";
  const data = thumbnails.get(file.thumb);
  if (data) {
    const image = document.createElement("img");
    image.src = `data:image/jpeg;base64,${data}`;
    image.alt = "";
    picture.append(image);
  } else {
    picture.textContent = "No preview";
  }
  if (keep) {
    const badge = document.createElement("span");
    badge.className = "download-status complete";
    badge.textContent = "Keep";
    picture.append(badge);
  }

  const body = document.createElement("div");
  body.className = "tile-body";
  const title = document.createElement("p");
  title.className = "download-title file-path";
  title.textContent = file.path;
  title.title = file.path;
  const meta = document.createElement("div");
  meta.className = "download-meta";
  for (const text of [formatBytes(file.size), `${file.width}×${file.height}`, formatDuration(file.duration)]) {
    const part = document.createElement("span");
    part.textContent = text;
    meta.append(part);
  }
  body.append(title, meta, fileActions(file.path));
  tile.append(picture, body);
  return tile;
}

function makeGroup(group) {
  const card = document.createElement("section");
  card.className = "download-group";
  const head = document.createElement("div");
  head.className = "group-head";
  const extras = group.files.slice(1);
  const summary = document.createElement("span");
  summary.className = "group-summary";
  summary.textContent = `${group.files.length} copies, ${formatBytes(extras.reduce((sum, file) => sum + file.size, 0))} extra`;
  head.append(
    summary,
    makeButton(
      extras.length === 1 ? "Trash the Other" : `Trash the Other ${extras.length}`,
      "Keep the first copy and move the rest to the trash folder",
      "button-danger group-check",
      () => {
        void trash(extras.map((file) => file.path));
      }
    )
  );
  const files = document.createElement("div");
  files.className = "group-items tiles";
  group.files.forEach((file, index) => files.append(makeFileTile(file, index === 0)));
  card.append(head, files);
  return card;
}

function render() {
  const running = status.state === "running";
  elements["scan-summary"].textContent = scanSummary(status);
  elements["library-root"].textContent = status.library_root || "";
  elements["scan-button"].disabled = running;
  elements["scan-button"].textContent = running ? "Scanning…" : "Scan Library";
  elements["scan-progress"].classList.toggle("hidden", !running);
  elements["scan-fill"].style.width = running && status.total ? `${(100 * status.done) / status.total}%` : "0%";

  for (const name of Object.keys(TABS)) {
    elements[`tab-${name}`].classList.toggle("active", name === tab);
  }
  const similar = (status.group_count || 0) - (status.identical_count || 0);
  elements["tab-broken"].textContent = `Broken (${status.broken_count || 0})`;
  elements["tab-identical"].textContent = `Identical (${status.identical_count || 0})`;
  elements["tab-similar"].textContent = `Similar (${similar})`;
  elements["tab-hint"].textContent = TABS[tab];

  const bulk = tab === "identical" && total > 0 && !running;
  elements["bulk-button"].classList.toggle("hidden", !bulk);
  elements["bulk-button"].textContent = "Trash All Extra Copies";

  elements["report-list"].textContent = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = status.finished_at ? "Nothing here." : "Scan the library to fill this in.";
    elements["report-list"].append(empty);
  }
  items.forEach((item) => {
    elements["report-list"].append(tab === "broken" ? makeBrokenItem(item) : makeGroup(item));
  });
  elements["more-button"].classList.toggle("hidden", items.length >= total);
  elements["more-button"].textContent = `Show More (${total - items.length} left)`;
}

async function loadThumbnails() {
  const wanted = items
    .flatMap((item) => item.files || [])
    .map((file) => file.thumb)
    .filter((key) => !thumbnails.has(key) && !missingThumbnails.has(key))
    .slice(0, THUMBNAIL_BATCH);
  if (!wanted.length) {
    return;
  }

  let received = 0;
  try {
    const response = await callHost({ type: "get_library_thumbnails", keys: wanted });
    for (const [key, data] of Object.entries(response?.thumbs || {})) {
      thumbnails.set(key, data);
      received += 1;
    }
  } catch (_error) {
    // Tiles stay without a picture.
  }
  if (!received) {
    wanted.forEach((key) => missingThumbnails.add(key));
  }
  render();
  void loadThumbnails();
}

async function loadReport(append = false) {
  try {
    const response = await hostAction(
      { type: "get_library_report", kind: tab, offset: append ? items.length : 0, limit: PAGE_SIZE },
      "The report could not be loaded."
    );
    items = append ? [...items, ...response.items] : response.items;
    total = response.total;
  } catch (error) {
    items = [];
    total = 0;
    showMessage("error", error.message);
  }
  render();
  void loadThumbnails();
}

async function refreshStatus() {
  const wasRunning = status.state === "running";
  try {
    status = await hostAction({ type: "get_library_scan" }, "The scan status could not be read.");
  } catch (error) {
    status = { state: "failed", error: error.message };
  }

  window.clearTimeout(pollTimer);
  if (status.state === "running") {
    pollTimer = window.setTimeout(() => void refreshStatus(), POLL_MS);
    render();
  } else if (wasRunning || !items.length) {
    await loadReport();
  } else {
    render();
  }
}

async function startScan() {
  try {
    await hostAction({ type: "start_library_scan" }, "The scan could not be started.");
    elements.message.className = "message hidden";
  } catch (error) {
    showMessage("error", error.message);
  }
  await refreshStatus();
}

async function fileAction(type, path) {
  try {
    await hostAction({ type, path }, "That did not work.");
  } catch (error) {
    showMessage("error", error.message);
  }
}

async function trash(paths, payload = { paths }) {
  try {
    const response = await hostAction({ type: "trash_library_files", ...payload }, "The files could not be moved.");
    showMessage("success", `Moved ${response.moved} ${response.moved === 1 ? "file" : "files"} to ${response.trash}`);
  } catch (error) {
    showMessage("error", error.message);
  }
  await refreshStatus();
  await loadReport();
}

elements["scan-button"].addEventListener("click", () => void startScan());
elements["more-button"].addEventListener("click", () => void loadReport(true));
elements["bulk-button"].addEventListener("click", () => {
  const sets = status.identical_count || 0;
  if (window.confirm(`Keep one copy of each of the ${sets} sets of identical videos and move the rest to the trash folder?`)) {
    void trash([], { all_identical: true });
  }
});
for (const name of Object.keys(TABS)) {
  elements[`tab-${name}`].addEventListener("click", () => {
    tab = name;
    items = [];
    void loadReport();
  });
}

void refreshStatus();
