import { batchTargetForUrl } from "./providers.js";

const HOST_NAME = "dev.arda.ytdlp_host";
const RECENT_DIRECTORIES_KEY = "recentDownloadDirectories";
const MAX_RECENT_DIRECTORIES = 10;
const MAX_VISIBLE_DOWNLOADS = 8;

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
  browseButton: document.getElementById("browse-button"),
  clearButton: document.getElementById("clear-button"),
  dashboardSummary: document.getElementById("dashboard-summary"),
  defaultButton: document.getElementById("default-button"),
  downloadList: document.getElementById("download-list"),
  downloadButton: document.getElementById("download-button"),
  downloadDir: document.getElementById("download-dir"),
  downloadForm: document.getElementById("download-form"),
  message: document.getElementById("message"),
  recentList: document.getElementById("recent-list"),
  refreshButton: document.getElementById("refresh-button"),
  rescanButton: document.getElementById("rescan-button"),
  targetUrl: document.getElementById("target-url"),
};

const state = {
  defaultDirectory: "~/Downloads",
  partialAcknowledged: false,
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
  targetUrl: "",
};

let downloadBusy = false;
let pollTimer = null;
let pollInFlight = false;
let pollPending = false;
let pollStopped = false;
let scanWatchdogTimer = null;

function showMessage(kind, text) {
  elements.message.className = `message ${kind}`;
  elements.message.textContent = text;
}

function hideMessage() {
  elements.message.className = "message hidden";
  elements.message.textContent = "";
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

function renderRecentDirectories(directories) {
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
    button.textContent = directory;
    button.title = `Download to ${directory}`;
    button.addEventListener("click", () => {
      void startDownload(directory);
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
    "Scroll further down the profile media page and scan again to pick up older posts."
  );
}

function partialScanPromptText(count) {
  const label = count === 1 ? "video" : "videos";
  return (
    "The profile scan stopped early before it reached the end of this profile.\n\n" +
    `Only ${count} ${label} were found so far. Scrolling further down the profile media ` +
    "page and scanning again would find more.\n\n" +
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
  const blocked = downloadBusy || isScanning();
  elements.downloadButton.disabled = blocked;
  elements.defaultButton.disabled = blocked;
  elements.browseButton.disabled = downloadBusy;
  elements.downloadDir.disabled = downloadBusy;
  elements.rescanButton.disabled = blocked;
  elements.recentList.querySelectorAll("button").forEach((button) => {
    button.disabled = blocked;
  });
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

async function removeDashboardJob(jobId) {
  try {
    const response = await callHost({ type: "remove_download_job", job_id: jobId });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not remove this download.");
    }

    void pollDownloads();
  } catch (error) {
    showMessage("error", error.message || "Could not remove this download.");
  }
}

async function clearDashboardJobs() {
  try {
    const response = await callHost({ type: "clear_download_jobs" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not clear the download list.");
    }

    showMessage("success", `Removed ${response.removed || 0} downloads from the dashboard.`);
    void pollDownloads();
  } catch (error) {
    showMessage("error", error.message || "Could not clear the download list.");
  }
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

function makeJobActions(job) {
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

  if (job.filename || job.download_dir) {
    actions.append(
      makeActionButton("Folder", "Open the containing folder", "button-muted-small", () => {
        void openDashboardFolder(job.id);
      })
    );
  }

  if (job.status !== "running") {
    actions.append(
      makeActionButton("Remove", "Remove this item from the dashboard", "button-danger", () => {
        void removeDashboardJob(job.id);
      })
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

function makeDownloadItem(job) {
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

  main.append(titleGroup, makeJobActions(job));

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

function renderDownloads(jobs, totals) {
  elements.downloadList.textContent = "";
  const visibleJobs = jobs.slice(0, MAX_VISIBLE_DOWNLOADS);
  const totalJobs = Math.max(totals.total, jobs.length);

  const runningLabel = totals.active === 1 ? "1 running" : `${totals.active} running`;
  const queuedLabel = totals.queued === 1 ? "1 queued" : `${totals.queued} queued`;
  const totalLabel = totalJobs ? `, ${totalJobs} total` : "";
  elements.dashboardSummary.textContent = `${runningLabel}, ${queuedLabel}${totalLabel}`;

  if (!visibleJobs.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "No downloads have been started yet.";
    elements.downloadList.append(emptyState);
    return;
  }

  visibleJobs.forEach((job) => {
    elements.downloadList.append(makeDownloadItem(job));
  });

  if (totalJobs > visibleJobs.length) {
    const note = document.createElement("p");
    note.className = "download-more";
    note.textContent = `Showing ${visibleJobs.length} of ${totalJobs} downloads.`;
    elements.downloadList.append(note);
  }
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
    return totals;
  } catch (error) {
    elements.dashboardSummary.textContent = "Download status unavailable";
    elements.downloadList.textContent = "";
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

async function startDownload(directory, allowDuplicate = false) {
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

  hideMessage();
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

    if (!response?.ok) {
      throw new Error(response?.error || "The native host rejected the request.");
    }

    const recentDirectories = await saveRecentDirectory(selectedDirectory);
    renderRecentDirectories(recentDirectories);
    if (response.profile) {
      const count = response.queued_count || 0;
      const skipped = response.skipped_count || 0;
      const label = count === 1 ? "download" : "downloads";
      const suffix = skipped > 0 ? ` (skipped ${skipped} already queued or downloaded)` : "";
      const partialNote = state.scanPartial
        ? " This was a partial scan — scroll the profile media page further and scan again for older posts."
        : "";
      showMessage(
        state.scanPartial ? "warning" : "success",
        `Queued ${count} profile ${label} in ${response.download_dir}${suffix}.${partialNote}`
      );
    } else {
      showMessage("success", `Download queued in ${selectedDirectory}`);
    }
    void pollDownloads();
  } catch (error) {
    showMessage(
      "error",
      `Could not start the download. ${error.message || "Please check the native host setup."}`
    );
  } finally {
    setBusy(false);
  }
}

async function loadDefaultDirectory() {
  const response = await callHost({ type: "get_config" });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not load native host config.");
  }

  return response.config?.download_dir || "~/Downloads";
}

async function initialize() {
  elements.targetUrl.textContent = state.targetUrl || "Missing URL";

  if (!state.targetUrl) {
    showMessage("error", "No target URL was provided.");
    setBusy(true);
    return;
  }

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
        : "Open the X/Twitter profile media page in a tab and use the toolbar button there to scan it.";
    showMessage("error", state.profileScanError);
  }

  try {
    const [defaultDirectory, recentDirectories] = await Promise.all([
      loadDefaultDirectory(),
      getRecentDirectories(),
    ]);

    state.defaultDirectory = defaultDirectory;
    elements.downloadDir.value = recentDirectories[0] || defaultDirectory;
    renderRecentDirectories(recentDirectories);
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
  void startDownload(elements.downloadDir.value);
});

elements.defaultButton.addEventListener("click", () => {
  elements.downloadDir.value = state.defaultDirectory;
  void startDownload(state.defaultDirectory);
});

elements.browseButton.addEventListener("click", async () => {
  hideMessage();
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

void initialize();
void pollDownloads();
