import { batchTargetForUrl } from "./providers.js";
import {
  autoStartReady,
  downloadPlan,
  groupDirectory,
  groupJobsByHandle,
  groupSummary,
  playableJobs,
  shortPath,
  videoRemoved,
} from "./grouping.js";
import { initHandles } from "./handles.js";
import { initLibraryViews } from "./library-views.js";
import { autoStartNotice, pickerTarget, renderGroupButtons } from "./picker.js";
import { createPlayer, playerLabel } from "./player.js";

const HOST_NAME = "dev.arda.ytdlp_host";
const RECENT_DIRECTORIES_KEY = "recentDownloadDirectories";
const MAX_RECENT_DIRECTORIES = 10;
const VIEW_KEY = "downloadsView";
const THUMBNAIL_BATCH = 24;

// Completion-scheduled polling: a new native host process is spawned per poll,
// so idle windows must not keep paying for it. Progress bars still read as live
// at 2.5s while an active download is running.
const POLL_RUNNING_MS = 2500;
const POLL_IDLE_MS = 6000;
const POLL_HIDDEN_MS = 30000;

// The service worker rewrites the scan record after every ~4s scan chunk, so a
// much longer silence means it was terminated mid-scan and nothing else will
// ever arrive. The watchdog therefore measures the gap since the last progress
// update, never total elapsed time: a full scan legitimately runs for tens of
// seconds.
const SCAN_WATCHDOG_MS = 20000;

const TOTAL_JOB_COUNT_KEYS = ["total_count", "total_jobs", "job_count", "total"];

const elements = {
  addHandleButton: document.getElementById("add-handle-button"),
  browseButton: document.getElementById("browse-button"),
  checkAllButton: document.getElementById("check-all-button"),
  clearButton: document.getElementById("clear-button"),
  dashboardSummary: document.getElementById("dashboard-summary"),
  defaultButton: document.getElementById("default-button"),
  downloadList: document.getElementById("download-list"),
  downloadButton: document.getElementById("download-button"),
  downloadDir: document.getElementById("download-dir"),
  dashboardLabel: document.getElementById("dashboard-label"),
  downloadControls: document.getElementById("download-controls"),
  downloadForm: document.getElementById("download-form"),
  libraryView: document.getElementById("library-view"),
  player: document.getElementById("player"),
  removedButton: document.getElementById("removed-button"),
  groupButtons: document.getElementById("group-buttons"),
  handleGroups: document.getElementById("handle-groups"),
  handleList: document.getElementById("handle-list"),
  handleSearch: document.getElementById("handle-search"),
  handleSort: document.getElementById("handle-sort"),
  handlesSummary: document.getElementById("handles-summary"),
  importButton: document.getElementById("import-button"),
  message: document.getElementById("message"),
  recentList: document.getElementById("recent-list"),
  refreshButton: document.getElementById("refresh-button"),
  rescanButton: document.getElementById("rescan-button"),
  targetUrl: document.getElementById("target-url"),
  viewList: document.getElementById("view-list"),
  viewTiles: document.getElementById("view-tiles"),
};

// `plan` says where this creator's downloads go (null until the handle list has
// loaded, and for anything but an X/Twitter page). `started` is set by the first
// download this tab sends, by hand or by itself, so nothing starts twice;
// `folderEdited` is set once the user has chosen a destination (typed a folder,
// Choose Folder…, or asked for a start by hand), which ends any pending auto-start.
const state = {
  defaultDirectory: "~/Downloads",
  folderEdited: false,
  handles: [],
  libraryRoot: "",
  partialAcknowledged: false,
  plan: null,
  playerName: playerLabel(""),
  profileName: "",
  profileScanError: "",
  profileUrls: null,
  rescanTabId: null,
  scanKey: "",
  scanPartial: false,
  scanSeenAt: 0,
  scanSettled: false,
  scanStatus: "none",
  source: "extension",
  started: false,
  targetUrl: "",
};

let downloadBusy = false;
let pollTimer = null;
let pollInFlight = false;
let pollPending = false;
let pollStopped = false;
let scanWatchdogTimer = null;

// Dashboard display state. The view survives reloads; collapsed groups and
// fetched pictures last as long as the tab.
let downloadsView = "list";
let lastJobs = [];
let lastTotals = { active: 0, queued: 0, total: 0 };
let lastRenderKey = "";
let thumbnailsInFlight = false;
const collapsedGroups = new Set();
const thumbnails = new Map();
const missingThumbnails = new Set();

function showMessage(kind, text) {
  elements.message.className = `message ${kind}`;
  elements.message.textContent = text;
}

function hideMessage() {
  elements.message.className = "message hidden";
  elements.message.textContent = "";
}

// Where a failed Remove or Favorite shows when its button is on the page. The
// same actions started from the player throw into the player instead, which
// shows the failure under the video.
function reportToPage(error) {
  showMessage("error", error.message || "That did not work.");
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

async function getRecentDirectories() {
  const result = await chrome.storage.local.get([RECENT_DIRECTORIES_KEY]);
  const directories = result[RECENT_DIRECTORIES_KEY];
  return Array.isArray(directories)
    ? directories.filter((value) => typeof value === "string" && value.trim())
    : [];
}

async function saveRecentDirectory(directory) {
  const trimmed = directory.trim();
  if (!trimmed) {
    return [];
  }

  const current = await getRecentDirectories();
  const next = [trimmed, ...current.filter((value) => value !== trimmed)].slice(
    0,
    MAX_RECENT_DIRECTORIES
  );
  await chrome.storage.local.set({ [RECENT_DIRECTORIES_KEY]: next });
  return next;
}

async function forgetRecentDirectory(directory) {
  const trimmed = directory.trim();
  const next = (await getRecentDirectories()).filter((value) => value !== trimmed);
  await chrome.storage.local.set({ [RECENT_DIRECTORIES_KEY]: next });
  return next;
}

// Kept so the buttons can be drawn again, with shorter paths, once the library
// root arrives.
let shownRecentDirectories = [];

function renderRecentDirectories(directories) {
  shownRecentDirectories = directories;
  elements.recentList.textContent = "";

  if (!directories.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent =
      "No recent folders yet. Start one download and the folder will show up here.";
    elements.recentList.append(emptyState);
    return;
  }

  directories.forEach((directory) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-button";
    button.textContent = shortPath(directory, state.libraryRoot);
    button.title = `Download to ${directory}`;
    button.addEventListener("click", () => {
      startByHand(directory);
    });
    elements.recentList.append(button);
  });

  applyBusyState();
}

function formatJobTitle(job) {
  if (job.filename) {
    return job.filename.split("/").pop().replace(/^"|"$/g, "");
  }

  try {
    const url = new URL(job.url);
    return url.hostname + url.pathname;
  } catch (_error) {
    return job.url || "Download";
  }
}

function formatProgress(job) {
  if (typeof job.progress === "number") {
    return `${Math.round(job.progress)}%`;
  }

  if (job.status === "complete") {
    return "100%";
  }
  if (job.status === "cancelled") {
    return "Cancelled";
  }

  return "Waiting";
}

function makeMetaItem(text) {
  const item = document.createElement("span");
  item.textContent = text;
  return item;
}

function duplicatePromptText(duplicateJob, duplicateCount) {
  const title = duplicateJob ? formatJobTitle(duplicateJob) : "this video";
  const status = duplicateJob?.status || "existing";
  const location = duplicateJob?.download_dir ? `\n\nFolder: ${duplicateJob.download_dir}` : "";
  const intro =
    typeof duplicateCount === "number" && duplicateCount > 1
      ? `${duplicateCount} videos from this profile are already queued, running, or complete.`
      : `This video is already ${status}:`;
  return `${intro}\n\n${title}${location}\n\nDownload duplicate video files anyway?`;
}

function partialScanMessage(count) {
  const label = count === 1 ? "video link" : "video links";
  return (
    `The scan stopped early, so this is only part of the profile: ${count} ${label} found so far. ` +
    "Queue these first, then scroll further down the profile page and scan again to pick up " +
    "older posts. A new scan starts from where the page is scrolled, and already queued videos are skipped."
  );
}

function partialScanPromptText(count) {
  const label = count === 1 ? "video" : "videos";
  return (
    "The profile scan stopped early before it reached the end of this profile.\n\n" +
    `Only ${count} ${label} were found so far. After queueing them, scroll further down the ` +
    "profile page and scan again to find older posts.\n\n" +
    `Queue these ${count} ${label} now anyway?`
  );
}

function isProfileBatchUrl(rawUrl) {
  return batchTargetForUrl(rawUrl) !== null;
}

function isScanning() {
  return state.scanStatus === "scanning";
}

function applyBusyState() {
  const blocked = downloadBusy || isScanning() || !state.targetUrl;
  elements.downloadButton.disabled = blocked;
  elements.defaultButton.disabled = blocked;
  elements.browseButton.disabled = downloadBusy;
  elements.downloadDir.disabled = downloadBusy;
  elements.rescanButton.disabled = blocked;
  for (const container of [elements.recentList, elements.groupButtons]) {
    container.querySelectorAll("button").forEach((button) => {
      button.disabled = blocked;
    });
  }
}

function setBusy(isBusy) {
  downloadBusy = isBusy;
  applyBusyState();
}

function releaseScanRecord() {
  if (!state.scanKey) {
    return;
  }

  const key = state.scanKey;
  void chrome.storage.session.remove([key]).catch(() => {});
}

function canRescan() {
  return (
    Boolean(state.scanKey) &&
    state.rescanTabId !== null &&
    isProfileBatchUrl(state.targetUrl)
  );
}

function setRescanVisible(visible) {
  elements.rescanButton.classList.toggle("hidden", !visible);
}

function clearScanWatchdog() {
  if (scanWatchdogTimer !== null) {
    window.clearTimeout(scanWatchdogTimer);
    scanWatchdogTimer = null;
  }
}

// Restarted on every progress update, so a long-but-healthy scan is never
// interrupted; only silence trips it.
function armScanWatchdog() {
  clearScanWatchdog();
  if (!state.scanKey || state.scanSettled) {
    return;
  }

  scanWatchdogTimer = window.setTimeout(() => {
    scanWatchdogTimer = null;
    void handleScanStall();
  }, SCAN_WATCHDOG_MS);
}

/**
 * Applies a profile scan record written by the service worker.
 * Record shape: { status: "scanning" | "done" | "error", username, urls, found, error, partial }
 */
function applyScanRecord(record) {
  if (state.scanSettled || !record) {
    return;
  }

  if (record.status === "scanning") {
    state.scanStatus = "scanning";
    state.profileUrls = null;
    state.scanSeenAt = typeof record.updatedAt === "number" ? record.updatedAt : Date.now();
    const found = typeof record.found === "number" ? record.found : 0;
    showMessage(
      "info",
      found > 0
        ? `Scanning this profile page for videos… ${found} found so far.`
        : "Scanning this profile page for videos…"
    );
    setRescanVisible(false);
    armScanWatchdog();
    applyBusyState();
    return;
  }

  if (record.status !== "done" && record.status !== "error") {
    return;
  }

  clearScanWatchdog();

  if (record.status === "error") {
    state.scanSettled = true;
    state.scanStatus = "error";
    state.profileUrls = [];
    state.profileScanError = record.error || "Could not scan the profile media page.";
    showMessage("error", state.profileScanError);
    setRescanVisible(canRescan());
    releaseScanRecord();
    applyBusyState();
    return;
  }

  state.scanSettled = true;
  state.scanStatus = "done";
  const urls = Array.isArray(record.urls)
    ? record.urls.filter((url) => typeof url === "string" && url.startsWith("https://"))
    : [];
  state.profileUrls = urls;
  state.profileName = record.profileName || "";
  state.scanPartial = Boolean(record.partial) && urls.length > 0;
  state.partialAcknowledged = false;

  if (state.scanPartial) {
    // Downloading a partial set stays allowed, but the popup must not present it
    // as the whole profile: startDownload() asks for an explicit confirmation.
    showMessage("warning", partialScanMessage(urls.length));
    setRescanVisible(canRescan());
  } else if (urls.length) {
    showMessage("success", `Found ${urls.length} video links on this profile page.`);
    setRescanVisible(false);
  } else {
    const emptyScanMessage =
      batchTargetForUrl(state.targetUrl)?.provider === "facebook"
        ? "No reels were found. If you are signed out, Facebook hides profile reels — sign in, reload the page, and scan again."
        : "No video links were found. Scroll the profile media page to load videos, then try again.";
    state.profileScanError = emptyScanMessage;
    showMessage("error", emptyScanMessage);
    setRescanVisible(canRescan());
  }

  releaseScanRecord();
  applyBusyState();
  maybeAutoStart();
}

async function readScanRecord() {
  if (!state.scanKey) {
    return null;
  }

  try {
    const result = await chrome.storage.session.get([state.scanKey]);
    return result[state.scanKey] || null;
  } catch (_error) {
    // The onChanged listener still delivers the result once it lands.
    return null;
  }
}

async function loadScanRecord() {
  const record = await readScanRecord();
  if (record) {
    applyScanRecord(record);
  }
}

/**
 * The MV3 service worker can be terminated mid-scan, in which case no further
 * storage change ever arrives. Fail the scan open instead of blocking the popup
 * forever.
 */
async function handleScanStall() {
  if (state.scanSettled || !isScanning()) {
    return;
  }

  // A change event can be missed; only give up when storage holds nothing newer
  // than the update the popup already applied.
  const record = await readScanRecord();
  const updatedAt = typeof record?.updatedAt === "number" ? record.updatedAt : 0;
  if (record && (record.status !== "scanning" || updatedAt > state.scanSeenAt)) {
    applyScanRecord(record);
    return;
  }

  state.scanStatus = "stalled";
  state.profileUrls = [];
  state.profileScanError =
    "The profile scan stopped responding — Chrome may have shut down the extension's " +
    "background worker. " +
    (canRescan()
      ? "Use Scan Again to restart it."
      : "Reload the profile media page and start the download again.");
  showMessage("error", state.profileScanError);
  setRescanVisible(canRescan());
  applyBusyState();
}

async function requestRescan() {
  if (!canRescan()) {
    return;
  }

  clearScanWatchdog();
  setRescanVisible(false);
  state.scanSettled = false;
  state.scanStatus = "scanning";
  state.scanSeenAt = 0;
  state.scanPartial = false;
  state.partialAcknowledged = false;
  state.profileScanError = "";
  state.profileUrls = null;
  showMessage("info", "Scanning this profile page for videos…");
  armScanWatchdog();
  applyBusyState();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "rescan-profile",
      key: state.scanKey,
      tabId: state.rescanTabId,
      username: batchTargetForUrl(state.targetUrl)?.key,
      url: state.targetUrl,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not restart the profile scan.");
    }
  } catch (error) {
    clearScanWatchdog();
    state.scanStatus = "stalled";
    state.profileUrls = [];
    state.profileScanError = error.message || "Could not restart the profile scan.";
    showMessage("error", state.profileScanError);
    setRescanVisible(canRescan());
    applyBusyState();
  }
}

async function startDashboardJob(jobId) {
  try {
    const response = await callHost({ type: "start_download_job", job_id: jobId });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not start the queued download.");
    }

    void pollDownloads();
  } catch (error) {
    showMessage("error", error.message || "Could not start the queued download.");
  }
}

async function cancelDashboardJob(jobId) {
  try {
    const response = await callHost({ type: "cancel_download_job", job_id: jobId });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not cancel this download.");
    }

    showMessage("success", "Download cancelled.");
    void pollDownloads();
  } catch (error) {
    showMessage("error", error.message || "Could not cancel this download.");
  }
}

// Resolves to true when the job's video is gone: deleted now, or already
// missing from disk when the job was taken off the list. False when the
// confirmation was declined, or when there was no video to delete (a failed or
// queued job). Throws when the host refused, or when it took the job off the
// list but left a video on disk (one outside the library folder); the caller
// shows the failure.
async function removeDashboardJob(job, deletes) {
  if (
    deletes &&
    !window.confirm(
      `Delete ${formatJobTitle(job)} from disk? It stays listed under Removed and will not be downloaded again.`
    )
  ) {
    return false;
  }

  const response = await callHost({ type: "remove_download", job_id: job.id });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not remove this download.");
  }

  // The entry is off the list whatever happened to the file.
  void pollDownloads();
  if (response.deleted) {
    showMessage("success", `Deleted ${formatJobTitle(job)}. It is listed under Removed.`);
    void handlesPanel.refresh();
  }
  return videoRemoved(response, deletes);
}

async function clearDashboardJobs() {
  try {
    const response = await callHost({ type: "clear_download_jobs" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not clear the download list.");
    }

    showMessage("success", `Cleared ${response.removed || 0} downloads from the list. Their files are kept.`);
    void pollDownloads();
  } catch (error) {
    showMessage("error", error.message || "Could not clear the download list.");
  }
}

async function playDashboardJob(jobId) {
  try {
    const response = await callHost({ type: "play_download", job_id: jobId });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not open the video.");
    }
  } catch (error) {
    showMessage("error", error.message || "Could not open the video.");
  }
}

// Resolves to the favorite's new state. `favorite` is the state to set; the
// tile's star flips what the list last showed, the player what it shows now.
// Throws when the host refused; the caller shows the failure.
async function favoriteDashboardJob(job, favorite = !job.favorite) {
  const response = await callHost({ type: "set_favorite", job_id: job.id, favorite });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not change the favorite.");
  }
  void pollDownloads();
  void handlesPanel.refresh();
  return Boolean(response.favorite);
}

async function openDashboardFolder(jobId) {
  try {
    const response = await callHost({ type: "open_download_folder", job_id: jobId });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not open the containing folder.");
    }

    showMessage("success", `Opened ${response.path || "the containing folder"}.`);
  } catch (error) {
    showMessage("error", error.message || "Could not open the containing folder.");
  }
}

function pickCount(response, keys) {
  for (const key of keys) {
    const value = response?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }

  return null;
}

function makeActionButton(label, title, extraClass, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = extraClass
    ? `download-action-button ${extraClass}`
    : "download-action-button";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", onClick);
  return button;
}

// The one inline player, made the first time a video is played. Its external
// player button gets the name from the host's config, now or when it arrives.
let inlinePlayer = null;

function getPlayer() {
  inlinePlayer ??= createPlayer({ root: elements.player, playerName: state.playerName });
  return inlinePlayer;
}

/**
 * Plays a finished download in the inline player, with the rest of its
 * handle group's finished downloads to step through. The player reports a
 * failed Favorite or Remove itself, so those handlers throw instead of using
 * the page's message; the list has already refreshed behind it by the time it
 * closes.
 */
function playJob(job, group) {
  const queue = playableJobs(group);
  const index = queue.findIndex((entry) => entry.job === job);
  if (index < 0) {
    return;
  }

  getPlayer().open(queue, index, {
    toggleFavorite: (entry) => favoriteDashboardJob(entry.job, !entry.favorite),
    remove: (entry) => removeDashboardJob(entry.job, true),
    external: (entry) => {
      void playDashboardJob(entry.job.id);
    },
  });
}

function makeJobActions(job, group) {
  const actions = document.createElement("div");
  actions.className = "download-actions";

  const status = document.createElement("span");
  status.className = `download-status ${job.status || "queued"}`;
  status.textContent = job.status_detail || job.status || "Queued";
  actions.append(status);

  if (["queued", "failed", "cancelled"].includes(job.status)) {
    const isRetry = job.status !== "queued";
    actions.append(
      makeActionButton(
        isRetry ? "Retry" : "Start",
        isRetry ? `Retry this ${job.status} download` : "Start this queued download next",
        "",
        () => {
          void startDashboardJob(job.id);
        }
      )
    );
  }

  if (job.status === "running") {
    actions.append(
      makeActionButton("Cancel", "Stop this running download", "button-danger", () => {
        void cancelDashboardJob(job.id);
      })
    );
  }

  if (job.status === "complete" && job.filename) {
    actions.append(
      makeActionButton("Play", "Play this video here", "", () => {
        playJob(job, group);
      }),
      makeActionButton(state.playerName, "Open this video in the configured player", "button-muted-small", () => {
        void playDashboardJob(job.id);
      }),
      makeActionButton(
        job.favorite ? "★" : "☆",
        job.favorite ? "Remove from favorites" : "Add to this group's favorites",
        job.favorite ? "favorite-button active" : "favorite-button",
        () => {
          favoriteDashboardJob(job).catch(reportToPage);
        }
      )
    );
  }

  if (job.filename || job.download_dir) {
    actions.append(
      makeActionButton("Folder", "Open the containing folder", "button-muted-small", () => {
        void openDashboardFolder(job.id);
      })
    );
  }

  if (job.status !== "running") {
    const deletes = job.status === "complete" && Boolean(job.filename);
    actions.append(
      makeActionButton(
        "Remove",
        deletes
          ? "Delete this video from disk, keep it under Removed and never download it again"
          : "Take this download off the list",
        "button-danger",
        () => {
          removeDashboardJob(job, deletes).catch(reportToPage);
        }
      )
    );
  }

  return actions;
}

function makeJobMeta(job) {
  const meta = document.createElement("div");
  meta.className = "download-meta";
  meta.append(makeMetaItem(formatProgress(job)));

  if (job.speed && job.status === "running") {
    meta.append(makeMetaItem(job.speed));
  }
  if (job.eta && job.status === "running") {
    meta.append(makeMetaItem(`ETA ${job.eta}`));
  }
  if (job.fragment && job.status === "running") {
    meta.append(makeMetaItem(`Fragment ${job.fragment}`));
  }
  if (job.download_dir) {
    meta.append(makeMetaItem(job.download_dir));
  }

  return meta;
}

function makeDownloadItem(job, group) {
  const item = document.createElement("article");
  item.className = "download-item";

  const main = document.createElement("div");
  main.className = "download-main";

  const titleGroup = document.createElement("div");
  titleGroup.className = "download-title-group";

  const title = document.createElement("p");
  title.className = "download-title";
  title.textContent = formatJobTitle(job);
  title.title = job.url || "";
  titleGroup.append(title);

  main.append(titleGroup, makeJobActions(job, group));

  const track = document.createElement("div");
  track.className = "progress-track";

  const fill = document.createElement("div");
  fill.className = "progress-fill";
  const progress = typeof job.progress === "number" ? job.progress : 0;
  fill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  track.append(fill);

  item.append(main, track, makeJobMeta(job));

  if (job.error) {
    const error = document.createElement("p");
    error.className = "download-error";
    error.textContent = job.error;
    item.append(error);
  }

  return item;
}

function makeDownloadTile(job, group) {
  const tile = document.createElement("article");
  tile.className = "download-tile";

  const picture = document.createElement("div");
  picture.className = "tile-picture";
  const data = thumbnails.get(job.id);
  if (data) {
    const image = document.createElement("img");
    image.src = `data:image/jpeg;base64,${data}`;
    image.alt = "";
    picture.append(image);
  } else {
    picture.textContent = job.status === "complete" ? "No preview" : formatProgress(job);
  }
  if (job.status === "complete" && job.filename) {
    picture.classList.add("playable");
    picture.addEventListener("click", () => playJob(job, group));
  }

  const actions = makeJobActions(job, group);
  // The status reads better on the picture than squeezed in with the buttons.
  picture.append(actions.querySelector(".download-status"));

  const body = document.createElement("div");
  body.className = "tile-body";

  const title = document.createElement("p");
  title.className = "download-title";
  title.textContent = formatJobTitle(job);
  title.title = `${formatJobTitle(job)}\n${job.url || ""}`;
  body.append(title);

  if (job.status === "running") {
    const track = document.createElement("div");
    track.className = "progress-track";
    const fill = document.createElement("div");
    fill.className = "progress-fill";
    const progress = typeof job.progress === "number" ? job.progress : 0;
    fill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    track.append(fill);

    const meta = document.createElement("div");
    meta.className = "download-meta";
    meta.append(makeMetaItem(formatProgress(job)));
    if (job.speed) meta.append(makeMetaItem(job.speed));
    if (job.eta) meta.append(makeMetaItem(`ETA ${job.eta}`));
    body.append(track, meta);
  }

  body.append(actions);

  if (job.error) {
    const error = document.createElement("p");
    error.className = "download-error";
    error.textContent = job.error;
    body.append(error);
  }

  tile.append(picture, body);
  return tile;
}

function makeDownloadGroup(group) {
  const details = document.createElement("details");
  details.className = "download-group";
  details.open = !collapsedGroups.has(group.key);
  details.addEventListener("toggle", () => {
    if (details.open) {
      collapsedGroups.delete(group.key);
    } else {
      collapsedGroups.add(group.key);
    }
  });

  const summary = document.createElement("summary");
  const handle = document.createElement("span");
  handle.className = "group-handle";
  handle.textContent = group.handle ? `@${group.handle}` : "Other downloads";
  const counts = document.createElement("span");
  counts.className = "group-summary";
  counts.textContent = groupSummary(group);
  summary.append(handle, counts);

  const items = document.createElement("div");
  items.className = downloadsView === "tiles" ? "group-items tiles" : "group-items";
  const makeItem = downloadsView === "tiles" ? makeDownloadTile : makeDownloadItem;
  group.jobs.forEach((job) => items.append(makeItem(job, group)));

  details.append(summary, items);
  return details;
}

function renderDownloads(jobs, totals) {
  lastJobs = jobs;
  lastTotals = totals;

  // The dashboard is polled every few seconds; rebuilding it when nothing
  // changed would reset scrolling inside it and reload every picture.
  const renderKey = JSON.stringify([jobs, totals, downloadsView, thumbnails.size, state.playerName]);
  if (renderKey === lastRenderKey) {
    return;
  }
  lastRenderKey = renderKey;

  elements.downloadList.textContent = "";
  const totalJobs = Math.max(totals.total, jobs.length);

  const runningLabel = totals.active === 1 ? "1 running" : `${totals.active} running`;
  const queuedLabel = totals.queued === 1 ? "1 queued" : `${totals.queued} queued`;
  const totalLabel = totalJobs ? `, ${totalJobs} total` : "";
  elements.dashboardSummary.textContent = `${runningLabel}, ${queuedLabel}${totalLabel}`;

  if (!jobs.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "No downloads have been started yet.";
    elements.downloadList.append(emptyState);
    return;
  }

  groupJobsByHandle(jobs).forEach((group) => {
    elements.downloadList.append(makeDownloadGroup(group));
  });

  if (totalJobs > jobs.length) {
    const note = document.createElement("p");
    note.className = "download-more";
    note.textContent = `Showing ${jobs.length} of ${totalJobs} downloads.`;
    elements.downloadList.append(note);
  }
}

function setDownloadsView(view) {
  downloadsView = view === "tiles" ? "tiles" : "list";
  elements.viewTiles.classList.toggle("active", downloadsView === "tiles");
  elements.viewList.classList.toggle("active", downloadsView === "list");
  try {
    window.localStorage.setItem(VIEW_KEY, downloadsView);
  } catch (_error) {
    // The choice simply does not survive a reload.
  }
  renderDownloads(lastJobs, lastTotals);
  void loadThumbnails();
}

/** Fetches pictures the tile view is missing, a batch per native message. */
async function loadThumbnails() {
  if (downloadsView !== "tiles" || thumbnailsInFlight) {
    return;
  }

  const wanted = lastJobs
    .filter((job) => job.thumb && !thumbnails.has(job.id) && !missingThumbnails.has(job.id))
    .map((job) => job.id)
    .slice(0, THUMBNAIL_BATCH);
  if (!wanted.length) {
    return;
  }

  thumbnailsInFlight = true;
  let received = 0;
  try {
    const response = await callHost({ type: "get_thumbnails", job_ids: wanted });
    const thumbs = response?.ok && response.thumbs ? response.thumbs : {};
    for (const [jobId, data] of Object.entries(thumbs)) {
      thumbnails.set(jobId, data);
      received += 1;
    }
    // The host stops early at its size limit; only a batch that came back
    // empty means these pictures are gone for good.
    if (!received) {
      wanted.forEach((jobId) => missingThumbnails.add(jobId));
    }
  } catch (_error) {
    wanted.forEach((jobId) => missingThumbnails.add(jobId));
  } finally {
    thumbnailsInFlight = false;
  }

  renderDownloads(lastJobs, lastTotals);
  void loadThumbnails();
}

async function refreshDownloads() {
  try {
    const response = await callHost({ type: "get_downloads" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not load download status.");
    }

    const jobs = Array.isArray(response.jobs) ? response.jobs : [];
    const totals = {
      active: pickCount(response, ["active_count"]) ?? 0,
      queued: pickCount(response, ["queued_count"]) ?? 0,
      total: pickCount(response, TOTAL_JOB_COUNT_KEYS) ?? jobs.length,
    };

    renderDownloads(jobs, totals);
    void loadThumbnails();
    return totals;
  } catch (error) {
    elements.dashboardSummary.textContent = "Download status unavailable";
    elements.downloadList.textContent = "";
    lastRenderKey = "";
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = error.message || "Could not reach the native host.";
    elements.downloadList.append(emptyState);
    return null;
  }
}

function nextPollDelay(activeCount) {
  if (document.hidden) {
    return POLL_HIDDEN_MS;
  }

  return activeCount > 0 ? POLL_RUNNING_MS : POLL_IDLE_MS;
}

function clearPollTimer() {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function scheduleNextPoll(activeCount) {
  clearPollTimer();
  if (pollStopped) {
    return;
  }

  pollTimer = window.setTimeout(() => {
    pollTimer = null;
    void pollDownloads();
  }, nextPollDelay(activeCount));
}

async function pollDownloads() {
  if (pollStopped) {
    return;
  }

  // One native host process at a time: never let slow responses overlap.
  if (pollInFlight) {
    pollPending = true;
    return;
  }

  clearPollTimer();
  pollInFlight = true;
  let activeCount = 0;

  try {
    const totals = await refreshDownloads();
    activeCount = totals?.active || 0;
  } finally {
    pollInFlight = false;
    if (pollPending) {
      pollPending = false;
      void pollDownloads();
    } else {
      scheduleNextPoll(activeCount);
    }
  }
}

function stopDashboardPolling() {
  pollStopped = true;
  clearPollTimer();
}

// Every start the user asks for (Start Download, Use Default, a Recent Folder, a
// group button) goes through here, and choosing a destination ends any
// auto-start for this page at once, before startDownload asks anything: a
// declined confirmation or a refusal returns without having started, and a
// handle list that arrives later must not queue what the user turned down.
function startByHand(directory) {
  state.folderEdited = true;
  void startDownload(directory);
}

// `notice` is what to say while the request is out (the auto-start's "Downloading
// into …"); the result replaces it.
async function startDownload(directory, allowDuplicate = false, notice = "") {
  const selectedDirectory = directory.trim();
  if (!selectedDirectory) {
    showMessage("error", "Enter a folder path first.");
    elements.downloadDir.focus();
    return;
  }

  if (isScanning()) {
    showMessage(
      "info",
      "Still scanning this profile page for videos. Start the download once the scan finishes."
    );
    return;
  }

  if (isProfileBatchUrl(state.targetUrl) && !state.profileUrls?.length) {
    showMessage(
      "error",
      state.profileScanError ||
        "No profile video links were found. Scroll the profile media page to load videos, then try again."
    );
    return;
  }

  // Queueing a truncated profile is a legitimate choice, but never a silent one.
  if (state.scanPartial && !state.partialAcknowledged) {
    const found = state.profileUrls?.length || 0;
    if (!window.confirm(partialScanPromptText(found))) {
      showMessage("warning", partialScanMessage(found));
      return;
    }

    state.partialAcknowledged = true;
  }

  state.started = true;
  if (notice) {
    showMessage("info", notice);
  } else {
    hideMessage();
  }
  setBusy(true);

  try {
    const response = await callHost({
      type: "download",
      download_dir: selectedDirectory,
      source: state.source,
      url: state.targetUrl,
      allow_duplicate: allowDuplicate,
      profile_urls: state.profileUrls,
      profile_name: state.profileName || undefined,
    });

    if (response?.duplicate) {
      void pollDownloads();
      const shouldDownloadDuplicate = window.confirm(
        duplicatePromptText(response.duplicate_job, response.duplicate_count)
      );
      if (shouldDownloadDuplicate) {
        await startDownload(selectedDirectory, true);
      } else {
        showMessage("error", "Duplicate download was not queued.");
      }
      return;
    }

    if (response?.missing_dir) {
      // A remembered folder that no longer exists, such as a share that moved,
      // would keep failing; drop it so the list only offers real folders.
      renderRecentDirectories(await forgetRecentDirectory(selectedDirectory));
      showMessage("error", `${response.error} It was removed from Recent Folders.`);
      return;
    }

    if (!response?.ok) {
      throw new Error(response?.error || "The native host rejected the request.");
    }

    const recentDirectories = await saveRecentDirectory(selectedDirectory);
    renderRecentDirectories(recentDirectories);
    if (response.profile) {
      const count = response.queued_count || 0;
      const skipped = response.skipped_count || 0;
      const limited = response.limit_skipped_count || 0;
      const rejected = response.rejected_count || 0;
      const label = count === 1 ? "download" : "downloads";
      const notes = [];
      if (skipped > 0) {
        notes.push(`skipped ${skipped} already queued or downloaded`);
      }
      if (limited > 0) {
        notes.push(`${limited} not queued because the queue limit was reached`);
      }
      if (rejected > 0) {
        notes.push(`ignored ${rejected} links that are not from this profile`);
      }
      const suffix = notes.length ? ` (${notes.join("; ")})` : "";
      const partialNote = state.scanPartial
        ? " This was a partial scan — scroll the profile media page further and scan again for older posts."
        : "";
      showMessage(
        state.scanPartial ? "warning" : "success",
        `Queued ${count} profile ${label} in ${shortPath(response.download_dir || selectedDirectory, state.libraryRoot)}${suffix}.${partialNote}`
      );
    } else {
      showMessage("success", `Download queued in ${shortPath(selectedDirectory, state.libraryRoot)}`);
    }
    void pollDownloads();
    void handlesPanel.refresh();
  } catch (error) {
    showMessage(
      "error",
      `Could not start the download. ${error.message || "Please check the native host setup."}`
    );
  } finally {
    setBusy(false);
  }
}

async function loadHostConfig() {
  const response = await callHost({ type: "get_config" });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not load native host config.");
  }

  return response.config || {};
}

async function initialize() {
  // Opened from a page with nothing to download: the dashboard and the handle
  // list work as usual, and the download buttons wait for a page.
  elements.targetUrl.textContent =
    state.targetUrl || "Nothing to download. Open a post or profile and click the extension button there.";
  applyBusyState();

  if (state.scanKey) {
    state.scanStatus = "scanning";
    showMessage("info", "Scanning this profile page for videos…");
    armScanWatchdog();
    applyBusyState();
  } else if (isProfileBatchUrl(state.targetUrl)) {
    state.scanSettled = true;
    state.scanStatus = "error";
    state.profileUrls = [];
    state.profileScanError =
      batchTargetForUrl(state.targetUrl)?.provider === "facebook"
        ? "Open the Facebook profile reels page in a tab and use the toolbar button there to scan it."
        : "Open the profile in a tab and use the toolbar button there.";
    showMessage("error", state.profileScanError);
  }

  try {
    const [config, recentDirectories] = await Promise.all([loadHostConfig(), getRecentDirectories()]);
    const defaultDirectory = config.download_dir || "~/Downloads";

    state.defaultDirectory = defaultDirectory;
    elements.downloadDir.value = recentDirectories[0] || defaultDirectory;
    renderRecentDirectories(recentDirectories);

    // The Play buttons carry the external player's name. The list and the
    // overlay may both have been drawn before the config arrived (the jobs
    // and the config load independently), so rename what exists.
    state.playerName = playerLabel(config.player);
    inlinePlayer?.setPlayerName(state.playerName);
    renderDownloads(lastJobs, lastTotals);
  } catch (error) {
    showMessage(
      "error",
      `Native host unavailable. Run ./scripts/install_native_host.py --browser chrome. Details: ${error.message}`
    );
    renderRecentDirectories([]);
  }

  await loadScanRecord();
}

const params = new URLSearchParams(window.location.search);
state.targetUrl = params.get("url") || "";
state.source = params.get("source") || "extension";
state.scanKey = params.get("profileBatchKey") || "";

const rescanTabId = Number.parseInt(params.get("profileTabId") || "", 10);
state.rescanTabId = Number.isInteger(rescanTabId) ? rescanTabId : null;

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "session" || !state.scanKey) {
    return;
  }

  const change = changes[state.scanKey];
  if (change?.newValue) {
    applyScanRecord(change.newValue);
  }
});

elements.downloadForm.addEventListener("submit", (event) => {
  event.preventDefault();
  startByHand(elements.downloadDir.value);
});

elements.defaultButton.addEventListener("click", () => {
  elements.downloadDir.value = state.defaultDirectory;
  startByHand(state.defaultDirectory);
});

elements.browseButton.addEventListener("click", async () => {
  hideMessage();
  state.folderEdited = true;
  elements.browseButton.disabled = true;

  try {
    const response = await callHost({
      type: "choose_download_dir",
      initial_dir: elements.downloadDir.value.trim(),
    });

    if (!response?.ok) {
      throw new Error(response?.error || "The native host could not open the folder picker.");
    }

    if (response.path) {
      elements.downloadDir.value = response.path;
    }
  } catch (error) {
    showMessage(
      "error",
      `Could not choose a folder. ${error.message || "Please check the native host setup."}`
    );
  } finally {
    elements.browseButton.disabled = false;
  }
});

elements.rescanButton.addEventListener("click", () => {
  void requestRescan();
});

elements.refreshButton.addEventListener("click", () => {
  void pollDownloads();
});

elements.clearButton.addEventListener("click", () => {
  void clearDashboardJobs();
});

elements.viewTiles.addEventListener("click", () => setDownloadsView("tiles"));
elements.viewList.addEventListener("click", () => setDownloadsView("list"));

// Typing a folder ends any pending auto-start: from then on the folder is the
// user's. (Choose Folder… does the same, above.)
elements.downloadDir.addEventListener("input", () => {
  state.folderEdited = true;
});

/**
 * Starts the download without a click when it is certain where it goes: the
 * creator has exactly one folder, the user has not chosen another, and nothing
 * started yet. A profile waits for its scan. It goes through startDownload, so
 * the duplicate prompt, the removed-video refusal and a missing folder are
 * handled as for a click. Called when the handle list loads and when a scan
 * ends. A partial scan is queued without the confirmation (the success message
 * carries the warning).
 */
function maybeAutoStart() {
  const auto = state.plan?.auto;
  const ready = autoStartReady({
    auto,
    isProfile: pickerTarget(state.targetUrl).isProfile,
    scanStatus: state.scanStatus,
    urlCount: state.profileUrls?.length || 0,
    folderEdited: state.folderEdited,
    started: state.started,
  });
  if (!ready) {
    return;
  }

  state.started = true;
  state.partialAcknowledged = true;
  elements.downloadDir.value = auto.directory;
  void startDownload(auto.directory, false, autoStartNotice(auto));
}

function pickGroup(group) {
  const { handle, isProfile } = pickerTarget(state.targetUrl);
  startByHand(groupDirectory(state.libraryRoot, group, handle, state.handles, isProfile));
}

/**
 * Called each time the handle list loads. Works out where this page's creator
 * goes, draws the group buttons (X/Twitter pages only, and only once the library
 * root is known, since a group's folder is under it), shows the creator's folder
 * in the field while the user has not chosen one, and starts the download if it
 * may.
 */
function onHandlesLoaded(handles, groups, libraryRoot) {
  const rootChanged = libraryRoot !== state.libraryRoot;
  state.handles = handles;
  state.libraryRoot = libraryRoot;
  if (rootChanged) {
    renderRecentDirectories(shownRecentDirectories);
  }

  const target = pickerTarget(state.targetUrl);
  state.plan = target.twitter ? downloadPlan(handles, target.handle, target.isProfile) : null;
  renderGroupButtons(elements.groupButtons, {
    groups: state.plan && libraryRoot ? groups : [],
    highlight: state.plan?.groups || [],
    onPick: pickGroup,
  });
  applyBusyState();

  if (state.plan?.auto && !state.folderEdited && !state.started) {
    elements.downloadDir.value = state.plan.auto.directory;
  }
  maybeAutoStart();
}

const libraryViews = initLibraryViews({
  callHost,
  showMessage,
  elements,
  onChanged: () => {
    void pollDownloads();
    void handlesPanel.refresh();
  },
  getPlayer,
  getPlayerName: () => state.playerName,
});

const handlesPanel = initHandles({
  onOpenFavorites: (group) => libraryViews.showFavorites(group),
  callHost,
  showMessage,
  onQueued: () => void pollDownloads(),
  onLoaded: onHandlesLoaded,
  elements,
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    scheduleNextPoll(0);
    return;
  }

  void pollDownloads();
});

window.addEventListener("beforeunload", () => {
  stopDashboardPolling();
  clearScanWatchdog();
});

let storedView = "list";
try {
  storedView = window.localStorage.getItem(VIEW_KEY) || "list";
} catch (_error) {
  // Keep the default.
}
setDownloadsView(storedView);

// The handle list loads after the folder field has its default, so a known
// handle's folder is what ends up in it.
void initialize().finally(() => handlesPanel.refresh());
void pollDownloads();
