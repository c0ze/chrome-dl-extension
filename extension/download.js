const HOST_NAME = "dev.arda.ytdlp_host";
const RECENT_DIRECTORIES_KEY = "recentDownloadDirectories";
const MAX_RECENT_DIRECTORIES = 10;
const DASHBOARD_POLL_MS = 1600;
const MAX_VISIBLE_DOWNLOADS = 8;

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
  targetUrl: document.getElementById("target-url"),
};

const state = {
  defaultDirectory: "~/Downloads",
  source: "extension",
  targetUrl: "",
};

let dashboardTimer = null;

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

  return job.status === "complete" ? "100%" : "Waiting";
}

function makeMetaItem(text) {
  const item = document.createElement("span");
  item.textContent = text;
  return item;
}

function duplicatePromptText(duplicateJob) {
  const title = duplicateJob ? formatJobTitle(duplicateJob) : "this video";
  const status = duplicateJob?.status || "existing";
  const location = duplicateJob?.download_dir ? `\n\nFolder: ${duplicateJob.download_dir}` : "";
  return `This video is already ${status}:\n\n${title}${location}\n\nDownload a duplicate video anyway?`;
}

async function startDashboardJob(jobId) {
  try {
    const response = await callHost({ type: "start_download_job", job_id: jobId });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not start the queued download.");
    }

    void refreshDownloads();
  } catch (error) {
    showMessage("error", error.message || "Could not start the queued download.");
  }
}

async function removeDashboardJob(jobId) {
  try {
    const response = await callHost({ type: "remove_download_job", job_id: jobId });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not remove this download.");
    }

    void refreshDownloads();
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
    void refreshDownloads();
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

function renderDownloads(jobs, activeCount, queuedCount) {
  elements.downloadList.textContent = "";
  const visibleJobs = jobs.slice(0, MAX_VISIBLE_DOWNLOADS);

  const runningLabel = activeCount === 1 ? "1 running" : `${activeCount} running`;
  const queuedLabel = queuedCount === 1 ? "1 queued" : `${queuedCount} queued`;
  elements.dashboardSummary.textContent = `${runningLabel}, ${queuedLabel}`;

  if (!visibleJobs.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = "No downloads have been started yet.";
    elements.downloadList.append(emptyState);
    return;
  }

  visibleJobs.forEach((job) => {
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

    const status = document.createElement("span");
    status.className = `download-status ${job.status || "queued"}`;
    status.textContent = job.status_detail || job.status || "Queued";

    const actions = document.createElement("div");
    actions.className = "download-actions";
    actions.append(status);

    if (["queued", "failed"].includes(job.status)) {
      const startButton = document.createElement("button");
      startButton.type = "button";
      startButton.className = "download-action-button";
      startButton.textContent = job.status === "failed" ? "Retry" : "Start";
      startButton.title =
        job.status === "failed"
          ? "Retry this failed download"
          : "Start this queued download next";
      startButton.addEventListener("click", () => {
        void startDashboardJob(job.id);
      });
      actions.append(startButton);
    }

    if (job.filename || job.download_dir) {
      const folderButton = document.createElement("button");
      folderButton.type = "button";
      folderButton.className = "download-action-button button-muted-small";
      folderButton.textContent = "Folder";
      folderButton.title = "Open the containing folder";
      folderButton.addEventListener("click", () => {
        void openDashboardFolder(job.id);
      });
      actions.append(folderButton);
    }

    if (job.status !== "running") {
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "download-action-button button-danger";
      removeButton.textContent = "Remove";
      removeButton.title = "Remove this item from the dashboard";
      removeButton.addEventListener("click", () => {
        void removeDashboardJob(job.id);
      });
      actions.append(removeButton);
    }

    main.append(titleGroup, actions);

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

    item.append(main, track, meta);

    if (job.error) {
      const error = document.createElement("p");
      error.className = "download-error";
      error.textContent = job.error;
      item.append(error);
    }

    elements.downloadList.append(item);
  });
}

async function refreshDownloads() {
  try {
    const response = await callHost({ type: "get_downloads" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not load download status.");
    }

    renderDownloads(
      response.jobs || [],
      response.active_count || 0,
      response.queued_count || 0
    );
  } catch (error) {
    elements.dashboardSummary.textContent = "Download status unavailable";
    elements.downloadList.textContent = "";
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = error.message || "Could not reach the native host.";
    elements.downloadList.append(emptyState);
  }
}

function startDashboardPolling() {
  if (dashboardTimer !== null) {
    window.clearInterval(dashboardTimer);
  }

  void refreshDownloads();
  dashboardTimer = window.setInterval(() => {
    void refreshDownloads();
  }, DASHBOARD_POLL_MS);
}

function setBusy(isBusy) {
  elements.downloadButton.disabled = isBusy;
  elements.defaultButton.disabled = isBusy;
  elements.browseButton.disabled = isBusy;
  elements.downloadDir.disabled = isBusy;
}

async function startDownload(directory, allowDuplicate = false) {
  const selectedDirectory = directory.trim();
  if (!selectedDirectory) {
    showMessage("error", "Enter a folder path first.");
    elements.downloadDir.focus();
    return;
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
    });

    if (response?.duplicate) {
      void refreshDownloads();
      const shouldDownloadDuplicate = window.confirm(duplicatePromptText(response.duplicate_job));
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
    showMessage("success", `Download queued in ${selectedDirectory}`);
    void refreshDownloads();
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
  const params = new URLSearchParams(window.location.search);
  state.targetUrl = params.get("url") || "";
  state.source = params.get("source") || "extension";
  elements.targetUrl.textContent = state.targetUrl || "Missing URL";

  if (!state.targetUrl) {
    showMessage("error", "No target URL was provided.");
    setBusy(true);
    return;
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
}

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

elements.refreshButton.addEventListener("click", () => {
  void refreshDownloads();
});

elements.clearButton.addEventListener("click", () => {
  void clearDashboardJobs();
});

window.addEventListener("beforeunload", () => {
  if (dashboardTimer !== null) {
    window.clearInterval(dashboardTimer);
  }
});

void initialize();
startDashboardPolling();
