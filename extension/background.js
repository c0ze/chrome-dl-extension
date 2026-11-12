import {
  TWITTER_HOSTS,
  FACEBOOK_HOSTS,
  RESERVED_PROFILE_USERNAMES,
  batchTargetForUrl,
  profileScanChunk,
} from "./providers.js";

const MENU_ID = "download-with-ytdlp";
const PICKER_URL = chrome.runtime.getURL("download.html");
const PROFILE_BATCH_PREFIX = "profileBatch:";
const PROFILE_BATCH_TTL_MS = 10 * 60 * 1000;
const PROFILE_SCAN_CHUNK_MS = 4000;
const PROFILE_SCAN_MAX_PASSES = 36;
const PROFILE_SCAN_MAX_ROUNDS = 16;
// A check for new videos only needs the top of the media page, where the
// newest posts are; the full-depth scan stays with the toolbar button.
const HANDLE_CHECK_MAX_ROUNDS = 2;
const HANDLE_CHECK_LOAD_TIMEOUT_MS = 30000;
const HANDLE_CHECK_SETTLE_MS = 2500;

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

async function runProfileScan(
  tabId,
  provider,
  expectedUsername,
  key,
  maxRounds = PROFILE_SCAN_MAX_ROUNDS
) {
  if (activeScans.has(key)) {
    return;
  }

  activeScans.add(key);
  let progress = null;
  let profileName = "";
  const hosts = provider === "facebook" ? FACEBOOK_HOSTS : TWITTER_HOSTS;

  try {
    for (let round = 0; round < maxRounds; round += 1) {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: profileScanChunk,
        args: [
          {
            provider,
            hosts,
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
          provider,
          username: expectedUsername,
          error: result.error || "Could not scan the profile media page.",
        });
        return;
      }

      progress = result.progress;
      if (result.profileName) {
        profileName = result.profileName;
      }
      const urls = Array.isArray(result.urls) ? result.urls : [];

      if (result.done) {
        await writeScanRecord(key, {
          status: "done",
          provider,
          username: result.username || expectedUsername,
          urls,
          found: urls.length,
          partial: Boolean(result.capped),
          profileName,
        });
        return;
      }

      await writeScanRecord(key, {
        status: "scanning",
        provider,
        username: result.username || expectedUsername,
        found: urls.length,
        profileName,
      });
    }

    const urls = Array.isArray(progress?.urls) ? progress.urls : [];
    await writeScanRecord(key, {
      status: "done",
      provider,
      username: expectedUsername,
      urls,
      found: urls.length,
      partial: true,
      profileName,
    });
  } catch (error) {
    await writeScanRecord(key, {
      status: "error",
      provider,
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
 *
 * Validation is stateless: the provider and key are re-derived from the page
 * URL via the shared batchTargetForUrl validator (the same one used when the
 * scan was first started), not read back from a scan record. Session storage
 * deletes that record on every settled outcome (see releaseScanRecord), so it
 * can't be relied on as the source of truth here.
 */
async function restartProfileScan(message) {
  const key = typeof message?.key === "string" ? message.key : "";
  const tabId = message?.tabId;
  const username = typeof message?.username === "string" ? message.username : "";
  const url = typeof message?.url === "string" ? message.url : "";

  if (!key.startsWith(PROFILE_BATCH_PREFIX) || typeof tabId !== "number" || !username || !url) {
    return { ok: false, error: "This profile scan cannot be restarted." };
  }

  const target = batchTargetForUrl(url);
  if (!target || target.key !== username) {
    return { ok: false, error: "This profile scan cannot be restarted." };
  }

  const provider = target.provider;

  // A watchdog can fire while the scan is in fact still alive; let it finish
  // rather than racing a second writer against it.
  if (activeScans.has(key)) {
    return { ok: true, alreadyRunning: true };
  }

  await writeScanRecord(key, { status: "scanning", provider, username });
  void runProfileScan(tabId, provider, username, key);
  return { ok: true };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTabLoad(tabId) {
  const deadline = Date.now() + HANDLE_CHECK_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      // The page is a single-page app: "complete" is the shell, and the media
      // grid arrives a moment later.
      await sleep(HANDLE_CHECK_SETTLE_MS);
      return;
    }
    await sleep(500);
  }

  throw new Error("The profile page took too long to load.");
}

/**
 * Looks at one handle's media page for the handle list: opens it in a
 * background tab, scans the top of it and closes it again. The URL is
 * validated the same way a toolbar scan's is, so only a real X/Twitter media
 * page is ever opened and read.
 */
async function checkHandle(message) {
  const url = typeof message?.profileUrl === "string" ? message.profileUrl : "";
  const target = batchTargetForUrl(url);
  if (!target || target.provider !== "twitter") {
    return { ok: false, error: "This profile cannot be checked." };
  }

  const key = makeProfileBatchKey();
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    await waitForTabLoad(tabId);
    await runProfileScan(tabId, target.provider, target.key, key, HANDLE_CHECK_MAX_ROUNDS);

    const record = (await chrome.storage.session.get(key))[key];
    if (record?.status !== "done") {
      return { ok: false, error: record?.error || "The profile could not be scanned." };
    }
    return { ok: true, urls: Array.isArray(record.urls) ? record.urls : [] };
  } catch (error) {
    return { ok: false, error: error?.message || "The profile could not be scanned." };
  } finally {
    await chrome.storage.session.remove(key).catch(() => {});
    if (tabId !== null) {
      await chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

async function findPickerTab() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
  const picker = contexts.find(
    (context) => context.documentUrl?.startsWith(PICKER_URL) && context.tabId >= 0
  );
  return picker ? { tabId: picker.tabId, windowId: picker.windowId } : null;
}

/**
 * Shows the picker in a tab next to the page it was opened from. There is only
 * ever one picker: an open one is pointed at the new target and brought
 * forward instead of a second one being opened.
 */
async function showDownloadPicker(pickerUrl, sourceTab) {
  const existing = await findPickerTab();
  if (existing) {
    try {
      await chrome.tabs.update(existing.tabId, { url: pickerUrl, active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
      return;
    } catch (_error) {
      // The picker closed between the lookup and the update; open a new one.
    }
  }

  const placement =
    typeof sourceTab?.id === "number"
      ? { windowId: sourceTab.windowId, index: sourceTab.index + 1, openerTabId: sourceTab.id }
      : {};
  await chrome.tabs.create({ url: pickerUrl, ...placement });
}

async function openDownloadPicker(url, source, tab) {
  if (tab?.url?.startsWith(PICKER_URL)) {
    // The button was clicked on the picker itself; it is already in front.
    return;
  }

  if (!url) {
    openHelpPage("invalid-url");
    return;
  }

  void sweepProfileBatches();

  const params = new URLSearchParams({ url, source });
  const target = batchTargetForUrl(url);
  const scannable = Boolean(target) && typeof tab?.id === "number";
  const batchKey = scannable ? makeProfileBatchKey() : null;

  if (batchKey) {
    params.set("profileBatchKey", batchKey);
    params.set("profileTabId", String(tab.id));
    await writeScanRecord(batchKey, {
      status: "scanning",
      provider: target.provider,
      username: target.key,
    });
  }

  await showDownloadPicker(chrome.runtime.getURL(`download.html?${params.toString()}`), tab);

  if (batchKey) {
    await runProfileScan(tab.id, target.provider, target.key, batchKey);
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
  if (message?.type === "check-handle") {
    checkHandle(message).then(sendResponse);
    return true;
  }

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
