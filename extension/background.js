import {
  TWITTER_HOSTS,
  FACEBOOK_HOSTS,
  RESERVED_PROFILE_USERNAMES,
  batchTargetForUrl,
  mergeScanPasses,
  profileScanChunk,
  twitterMediaUrl,
  twitterPostsUrl,
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

/**
 * Scans a profile page for the picker and settles `key` with one final record.
 * A Twitter profile is read twice, Posts then Media, in the tab it was started
 * from; the tab is put back on `returnUrl` afterwards.
 */
async function scanProfileTab(tabId, provider, username, key, returnUrl = null) {
  if (activeScans.has(key)) {
    return;
  }

  activeScans.add(key);
  try {
    if (provider === "twitter") {
      await scanTwitterProfile(tabId, username, key, returnUrl);
    } else {
      await runProfileScan(tabId, provider, username, key);
    }
  } finally {
    activeScans.delete(key);
  }
}

async function runProfileScan(tabId, provider, username, key) {
  const pass = await scanPass(tabId, provider, username, key);
  await writeScanRecord(key, scanRecord(provider, username, pass, pass.profileName));
  await restoreScrollPosition(tabId, pass.originalScrollY);
}

// The one record that settles a scan; `merged` says how it ended.
function scanRecord(provider, username, merged, profileName = "") {
  if (!merged.ok) {
    return {
      status: "error",
      provider,
      username,
      gone: merged.gone,
      error: merged.error || "Could not scan the profile media page.",
    };
  }
  return {
    status: "done",
    provider,
    username,
    urls: merged.urls,
    found: merged.urls.length,
    partial: merged.partial,
    newestId: merged.newestId,
    profileName,
  };
}

async function scanTwitterProfile(tabId, username, key, returnUrl) {
  let postsPass = null;
  let mediaPass = null;
  try {
    try {
      await showTwitterPosts(tabId, username);
    } catch (error) {
      await writeScanRecord(key, {
        status: "error",
        provider: "twitter",
        username,
        error: error?.message || "Could not open the profile's Posts tab.",
      });
      return;
    }

    postsPass = await scanPass(tabId, "twitter", username, key);
    if (postsPass.ok) {
      mediaPass = await scanTwitterMedia(tabId, username, key, postsPass);
    }
    const merged = mergeScanPasses(postsPass, mediaPass);
    await writeScanRecord(key, scanRecord("twitter", username, merged, postsPass.profileName));
  } finally {
    await returnToStartPage(tabId, username, returnUrl, postsPass, mediaPass);
  }
}

/**
 * The Media pass of a Twitter scan, after the Posts pass: moves the tab to the
 * Media tab and reads it, counting the Posts videos as already found. Never
 * throws: a Media tab that will not open is a failed pass, which the merge
 * keeps the Posts videos for.
 */
async function scanTwitterMedia(tabId, username, key, postsPass, { stopAtId = null } = {}) {
  try {
    // Nothing is written while the tab loads, which can outlast the picker's
    // watchdog; this keeps the scan looking alive.
    await writeScanRecord(key, {
      status: "scanning",
      provider: "twitter",
      username,
      found: postsPass.urls.length,
    });
    await showTabUrl(tabId, twitterMediaUrl(username));
  } catch (error) {
    return { ok: false, error: error?.message || "Could not open the profile's Media tab.", urls: [] };
  }
  return scanPass(tabId, "twitter", username, key, { stopAtId, carryUrls: postsPass.urls });
}

/**
 * Puts the tab back on the page the scan was started from and, when that is the
 * Posts or Media tab, scrolls it to where it was. With no `returnUrl` the tab
 * stays where the scan left it. Best effort: the tab may be gone.
 */
async function returnToStartPage(tabId, username, returnUrl, postsPass, mediaPass) {
  try {
    if (returnUrl) {
      await showTabUrl(tabId, returnUrl);
    }
    const here = pageKey((await chrome.tabs.get(tabId)).url);
    const pass =
      here === pageKey(twitterPostsUrl(username))
        ? postsPass
        : here === pageKey(twitterMediaUrl(username))
          ? mediaPass
          : null;
    await restoreScrollPosition(tabId, pass?.originalScrollY);
  } catch (_error) {
    // The tab was closed or would not load; there is nothing to go back to.
  }
}

/**
 * One read of a profile page, scrolling it in chunks until it stops growing, the
 * round limit is reached or, with `stopAtId`, the scan is back at a post a
 * previous check saw. Resolves to the merge-ready pass (see mergeScanPasses),
 * with the profile name and the scroll position the page started at.
 *
 * Only ever writes `scanning` records: a pass is part of a scan, and the
 * picker takes a `done` or `error` record as the end of it, so the caller
 * writes that once. `carryUrls` are videos earlier passes found, counted in the
 * progress so it grows across passes.
 */
async function scanPass(
  tabId,
  provider,
  expectedUsername,
  key,
  { maxRounds = PROFILE_SCAN_MAX_ROUNDS, stopAtId = null, carryUrls = [] } = {}
) {
  let progress = null;
  let profileName = "";
  const hosts = provider === "facebook" ? FACEBOOK_HOSTS : TWITTER_HOSTS;
  const pass = (fields) => ({
    ok: true,
    urls: [],
    partial: false,
    complete: false,
    newestId: null,
    profileName,
    originalScrollY: progress?.originalScrollY ?? null,
    ...fields,
  });

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
            stopAtId,
            progress,
          },
        ],
      });

      const result = injection?.result;
      if (!result) {
        throw new Error("Could not inspect the profile page.");
      }
      if (!result.ok) {
        return pass({
          ok: false,
          gone: Boolean(result.gone),
          error: result.error || "Could not scan the profile media page.",
        });
      }

      progress = result.progress;
      if (result.profileName) {
        profileName = result.profileName;
      }
      const urls = Array.isArray(result.urls) ? result.urls : [];

      if (result.done) {
        const partial = Boolean(result.capped);
        return pass({
          urls,
          partial,
          // Reached the previous check's place, or the end of the timeline.
          complete: Boolean(result.reachedStop) || !partial,
          newestId: result.newestId || null,
        });
      }

      await writeScanRecord(key, {
        status: "scanning",
        provider,
        username: result.username || expectedUsername,
        // A video both passes found counts once.
        found: new Set([...carryUrls, ...urls]).size,
        profileName,
      });
    }

    // Out of rounds with the page still growing: only part of the profile.
    return pass({
      urls: Array.isArray(progress?.urls) ? progress.urls : [],
      partial: true,
      newestId: progress?.newestId || null,
    });
  } catch (error) {
    return pass({
      ok: false,
      error: error?.message || "Could not scan the profile media page. Try reloading it first.",
    });
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
  void scanProfileTab(tabId, provider, username, key);
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

// A page without its query, hash or trailing slash, to tell whether two URLs are
// the same page. Null for something that is not a URL.
function pageKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch (_error) {
    return null;
  }
}

// Moves a tab to `url` and waits for it to load; does nothing when it is there.
async function showTabUrl(tabId, url) {
  const tab = await chrome.tabs.get(tabId);
  const current = pageKey(tab.url);
  if (current !== null && current === pageKey(url)) {
    return;
  }
  await chrome.tabs.update(tabId, { url });
  await sleep(300); // Let the navigation start before waiting for it to finish.
  await waitForTabLoad(tabId);
}

/**
 * Puts a Twitter profile tab on the Posts tab, where a scan starts (see
 * twitterPostsUrl); a scan started from another tab moves the tab there.
 */
function showTwitterPosts(tabId, username) {
  return showTabUrl(tabId, twitterPostsUrl(username));
}

/**
 * Looks at one handle's profile for the handle list: opens it in a background
 * tab, scans the top of its Posts tab and then its Media tab, and closes it
 * again. The URL is validated the same way a toolbar scan's is, so only a real
 * X/Twitter profile is ever opened and read.
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
    const tab = await chrome.tabs.create({ url: twitterPostsUrl(target.key), active: false });
    tabId = tab.id;
    await waitForTabLoad(tabId);
    // A check reads down the timeline until it reaches the newest post the
    // previous complete check saw, so a regular check only reads what is new.
    const stopAtId = /^\d+$/.test(String(message.stopAtId || "")) ? String(message.stopAtId) : null;
    const postsPass = await scanPass(tabId, target.provider, target.key, key, { stopAtId });
    const mediaPass = postsPass.ok
      ? await scanTwitterMedia(tabId, target.key, key, postsPass, { stopAtId })
      : null;

    const merged = mergeScanPasses(postsPass, mediaPass);
    if (!merged.ok) {
      return {
        ok: false,
        gone: merged.gone,
        error: merged.error || "The profile could not be scanned.",
      };
    }
    return {
      ok: true,
      gone: false,
      urls: merged.urls,
      newestId: merged.newestId,
      complete: merged.complete,
    };
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
async function showDownloadPicker(pickerUrl, sourceTab, { keepTarget = false } = {}) {
  const existing = await findPickerTab();
  if (existing) {
    try {
      // With nothing new to download, an open picker keeps what it shows.
      await chrome.tabs.update(existing.tabId, keepTarget ? { active: true } : { url: pickerUrl, active: true });
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

async function openDownloadPicker(url, source, tab, { fromLink = false } = {}) {
  if (tab?.url?.startsWith(PICKER_URL)) {
    // The button was clicked on the picker itself; it is already in front.
    return;
  }

  if (!url) {
    // Nothing to download on this page (a new tab, a settings page): show the
    // downloads screen on its own.
    await showDownloadPicker(PICKER_URL, tab, { keepTarget: true });
    return;
  }

  void sweepProfileBatches();

  const target = batchTargetForUrl(url);
  // A Twitter profile batch always runs from the profile's media page, whichever
  // tab or link the profile was seen on.
  const pickerUrl = target?.provider === "twitter" ? twitterMediaUrl(target.key) : url;
  const params = new URLSearchParams({ url: pickerUrl, source });
  // A right-clicked link points at some other page than the tab the click
  // happened in, so only the toolbar button and the page menu scan a tab.
  const scannable = Boolean(target) && !fromLink && typeof tab?.id === "number";
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
    // The scan moves the tab between profile tabs; it goes back to where it was.
    await scanProfileTab(tab.id, target.provider, target.key, batchKey, tab.url || null);
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

  void openDownloadPicker(getTargetUrl(info, tab), "context-menu", tab, {
    fromLink: Boolean(info.linkUrl),
  });
});

chrome.action.onClicked.addListener((tab) => {
  void openDownloadPicker(normalizeUrl(tab?.url || ""), "toolbar", tab);
});
