const HOST_NAME = "dev.arda.ytdlp_host";

const elements = {
  browser: document.getElementById("browser"),
  keyring: document.getElementById("keyring"),
  configPath: document.getElementById("config-path"),
  downloadDir: document.getElementById("download-dir"),
  extensionId: document.getElementById("extension-id"),
  extraArgs: document.getElementById("extra-args"),
  logPath: document.getElementById("log-path"),
  message: document.getElementById("message"),
  profile: document.getElementById("profile"),
  reloadButton: document.getElementById("reload-button"),
  saveButton: document.getElementById("save-button"),
  ytDlpPath: document.getElementById("yt-dlp-path"),
};

function showMessage(kind, text) {
  elements.message.className = `message ${kind}`;
  elements.message.textContent = text;
}

function hideMessage() {
  elements.message.className = "message hidden";
  elements.message.textContent = "";
}

function parseArgs(text) {
  return text
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

function renderConfig(config) {
  elements.browser.value = config.browser || "chrome";
  elements.keyring.value = config.keyring || "";
  elements.keyring.disabled = elements.browser.value === "firefox";
  elements.downloadDir.value = config.download_dir || "~/Downloads";
  elements.profile.value = config.profile || "";
  elements.ytDlpPath.value = config.yt_dlp_path || "yt-dlp";
  elements.extraArgs.value = (config.extra_args || []).join("\n");
}

function collectConfig() {
  return {
    browser: elements.browser.value.trim(),
    keyring: elements.keyring.value,
    download_dir: elements.downloadDir.value.trim(),
    profile: elements.profile.value.trim(),
    yt_dlp_path: elements.ytDlpPath.value.trim(),
    extra_args: parseArgs(elements.extraArgs.value),
  };
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

async function loadConfig() {
  elements.extensionId.textContent = chrome.runtime.id;

  try {
    const response = await callHost({ type: "get_config" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not load config.");
    }

    renderConfig(response.config);
    elements.configPath.textContent = response.config_path || "Unknown";
    elements.logPath.textContent = response.log_path || "Unknown";

    const reason = new URLSearchParams(window.location.search).get("reason");
    if (reason === "host-error") {
      showMessage(
        "error",
        "Chrome could not reach the native host. Run ./scripts/install_native_host.py --browser chrome and reload the extension."
      );
      return;
    }

    if (reason === "invalid-url") {
      showMessage(
        "error",
        "The current page or clicked link was not a valid http(s) URL."
      );
      return;
    }

    showMessage("success", "Native host detected. Settings are ready to edit.");
  } catch (error) {
    elements.configPath.textContent = "Not installed";
    elements.logPath.textContent = "Not installed";
    showMessage(
      "error",
      `Native host unavailable. Run ./scripts/install_native_host.py --browser chrome. Details: ${error.message}`
    );
  }
}

async function saveConfig() {
  hideMessage();
  elements.saveButton.disabled = true;

  try {
    const response = await callHost({
      type: "save_config",
      config: collectConfig(),
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not save config.");
    }

    renderConfig(response.config);
    elements.configPath.textContent = response.config_path || elements.configPath.textContent;
    elements.logPath.textContent = response.log_path || elements.logPath.textContent;
    showMessage("success", "Config saved.");
  } catch (error) {
    showMessage("error", error.message);
  } finally {
    elements.saveButton.disabled = false;
  }
}

elements.browser.addEventListener("change", () => {
  elements.keyring.disabled = elements.browser.value === "firefox";
});

elements.reloadButton.addEventListener("click", () => {
  void loadConfig();
});

elements.saveButton.addEventListener("click", () => {
  void saveConfig();
});

void loadConfig();
