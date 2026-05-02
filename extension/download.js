const HOST_NAME = "dev.arda.ytdlp_host";
const RECENT_DIRECTORIES_KEY = "recentDownloadDirectories";
const MAX_RECENT_DIRECTORIES = 10;

const elements = {
  browseButton: document.getElementById("browse-button"),
  defaultButton: document.getElementById("default-button"),
  downloadButton: document.getElementById("download-button"),
  downloadDir: document.getElementById("download-dir"),
  downloadForm: document.getElementById("download-form"),
  message: document.getElementById("message"),
  recentList: document.getElementById("recent-list"),
  targetUrl: document.getElementById("target-url"),
};

const state = {
  defaultDirectory: "~/Downloads",
  source: "extension",
  targetUrl: "",
};

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

function setBusy(isBusy) {
  elements.downloadButton.disabled = isBusy;
  elements.defaultButton.disabled = isBusy;
  elements.browseButton.disabled = isBusy;
  elements.downloadDir.disabled = isBusy;
}

async function startDownload(directory) {
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
    });

    if (!response?.ok) {
      throw new Error(response?.error || "The native host rejected the request.");
    }

    const recentDirectories = await saveRecentDirectory(selectedDirectory);
    renderRecentDirectories(recentDirectories);
    showMessage("success", `Download started in ${selectedDirectory}`);
    window.setTimeout(() => window.close(), 450);
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

void initialize();
