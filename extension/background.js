import {
  TWITTER_HOSTS,
  RESERVED_PROFILE_USERNAMES,
  batchTargetForUrl,
  profileScanChunk,
} from "./providers.js";

const MENU_ID = "download-with-ytdlp";
const PROFILE_BATCH_PREFIX = "profileBatch:";
const PROFILE_BATCH_TTL_MS = 10 * 60 * 1000;
const PROFILE_SCAN_CHUNK_MS = 4000;
const PROFILE_SCAN_MAX_PASSES = 36;
const PROFILE_SCAN_MAX_ROUNDS = 16;

const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

// Batch keys whose scan is running in this worker instance. Empty after a
// worker restart, which is exactly when a popup-driven rescan should be allowed.
const activeScans = new Set();

function isTwitterHost(hostname) {
  return TWITTER_HOSTS.includes(hostname);
}

function normalizeUrl(rawUrl) {
  if (!rawUrl) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    url.hash = "";
    if (isTwitterHost(url.hostname)) {
      url.search = "";
    }

    return url.toString();
  } catch (_error) {
    return null;
  }
}

function twitterProfileMediaUsername(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!isTwitterHost(url.hostname)) {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || parts[1].toLowerCase() !== "media") {
      return null;
    }

    const username = parts[0];
    if (!USERNAME_PATTERN.test(username)) {
      return null;
    }

    return RESERVED_PROFILE_USERNAMES.includes(username.toLowerCase()) ? null : username;
  } catch (_error) {
    return null;
  }
}

function openHelpPage(reason) {
  const url = chrome.runtime.getURL(`options.html?reason=${encodeURIComponent(reason)}`);
  chrome.tabs.create({ url });
}

function getTargetUrl(info, tab) {
  return normalizeUrl(info.linkUrl || info.pageUrl || info.srcUrl || tab?.url || "");
}

function makeProfileBatchKey() {
  return `${PROFILE_BATCH_PREFIX}${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

async function writeScanRecord(key, record) {
  try {
    await chrome.storage.session.set({
      [key]: Object.assign({ urls: [], found: 0, updatedAt: Date.now() }, record),
    });
  } catch (_error) {
    // The popup falls back to its own error state when the record never lands.
  }
}

async function sweepProfileBatches() {
  try {
    const stored = await chrome.storage.session.get(null);
    const now = Date.now();
    const stale = Object.entries(stored)
      .filter(
        ([key, value]) =>
          key.startsWith(PROFILE_BATCH_PREFIX) && now - (value?.updatedAt || 0) > PROFILE_BATCH_TTL_MS
      )
      .map(([key]) => key);

    if (stale.length) {
      await chrome.storage.session.remove(stale);
    }
  } catch (_error) {
    // Best effort only.
  }
}

async function restoreScrollPosition(tabId, scrollY) {
  if (typeof scrollY !== "number") {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (y) => {
        window.scrollTo(0, y);
      },
      args: [scrollY],
    });
  } catch (_error) {
    // The tab may be gone or navigated away; nothing to restore.
  }
}

async function runProfileScan(tabId, expectedUsername, key) {
  if (activeScans.has(key)) {
    return;
  }

  activeScans.add(key);
  let progress = null;

  try {
    for (let round = 0; round < PROFILE_SCAN_MAX_ROUNDS; round += 1) {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: profileScanChunk,
        args: [
          {
            hosts: TWITTER_HOSTS,
            reserved: RESERVED_PROFILE_USERNAMES,
            expectedUsername,
            budgetMs: PROFILE_SCAN_CHUNK_MS,
            maxPasses: PROFILE_SCAN_MAX_PASSES,
            progress,
          },
        ],
      });

      const result = injection?.result;
      if (!result) {
        throw new Error("Could not inspect the profile page.");
      }
      if (!result.ok) {
        await writeScanRecord(key, {
          status: "error",
          username: expectedUsername,
          error: result.error || "Could not scan the profile media page.",
        });
        return;
      }

      progress = result.progress;
      const urls = Array.isArray(progress?.urls) ? progress.urls : [];

      if (result.done) {
        await writeScanRecord(key, {
          status: "done",
          username: result.username || expectedUsername,
          urls,
          found: urls.length,
        });
        return;
      }

      await writeScanRecord(key, {
        status: "scanning",
        username: result.username || expectedUsername,
        found: urls.length,
      });
    }

    const urls = Array.isArray(progress?.urls) ? progress.urls : [];
    await writeScanRecord(key, {
      status: "done",
      username: expectedUsername,
      urls,
      found: urls.length,
      partial: true,
    });
  } catch (error) {
    await writeScanRecord(key, {
      status: "error",
      username: expectedUsername,
      error: error?.message || "Could not scan the profile media page. Try reloading it first.",
    });
  } finally {
    activeScans.delete(key);
    await restoreScrollPosition(tabId, progress?.originalScrollY);
  }
}

/**
 * Restarts a scan whose worker was terminated mid-run. The popup's watchdog is
 * the only thing that can notice that, so it drives this.
 */
async function restartProfileScan(message) {
  const key = typeof message?.key === "string" ? message.key : "";
  const tabId = message?.tabId;
  const username = typeof message?.username === "string" ? message.username : "";

  const usable =
    key.startsWith(PROFILE_BATCH_PREFIX) &&
    typeof tabId === "number" &&
    USERNAME_PATTERN.test(username) &&
    !RESERVED_PROFILE_USERNAMES.includes(username.toLowerCase());

  if (!usable) {
    return { ok: false, error: "This profile scan cannot be restarted." };
  }

  // A watchdog can fire while the scan is in fact still alive; let it finish
  // rather than racing a second writer against it.
  if (activeScans.has(key)) {
    return { ok: true, alreadyRunning: true };
  }

  await writeScanRecord(key, { status: "scanning", username });
  void runProfileScan(tabId, username, key);
  return { ok: true };
}

async function openDownloadPicker(url, source, tab) {
  if (!url) {
    openHelpPage("invalid-url");
    return;
  }

  void sweepProfileBatches();

  const params = new URLSearchParams({ url, source });
  const username = twitterProfileMediaUsername(url);
  const scannable = Boolean(username) && typeof tab?.id === "number";
  const batchKey = scannable ? makeProfileBatchKey() : null;

  if (batchKey) {
    params.set("profileBatchKey", batchKey);
    params.set("profileTabId", String(tab.id));
    await writeScanRecord(batchKey, { status: "scanning", username });
  }

  await chrome.windows.create({
    url: chrome.runtime.getURL(`download.html?${params.toString()}`),
    type: "popup",
    width: 520,
    height: 720,
  });

  if (batchKey) {
    await runProfileScan(tab.id, username, batchKey);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Download with yt-dlp",
      contexts: ["page", "link"],
    });
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "rescan-profile") {
    return false;
  }

  restartProfileScan(message).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: error?.message || "Could not restart the profile scan." });
  });
  return true;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) {
    return;
  }

  void openDownloadPicker(getTargetUrl(info, tab), "context-menu", tab);
});

chrome.action.onClicked.addListener((tab) => {
  void openDownloadPicker(normalizeUrl(tab?.url || ""), "toolbar", tab);
});
