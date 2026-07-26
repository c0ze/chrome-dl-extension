const MENU_ID = "download-with-ytdlp";
const PROFILE_BATCH_PREFIX = "profileBatch:";
const PROFILE_BATCH_TTL_MS = 10 * 60 * 1000;
const PROFILE_SCAN_CHUNK_MS = 4000;
const PROFILE_SCAN_MAX_PASSES = 36;
const PROFILE_SCAN_MAX_ROUNDS = 16;

const TWITTER_HOSTS = [
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "x.com",
  "www.x.com",
];

// Kept in sync with twitter_profile_media_username() in native-host/yt_dlp_host.py.
const RESERVED_PROFILE_USERNAMES = [
  "home",
  "explore",
  "notifications",
  "messages",
  "i",
  "settings",
];

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

/**
 * Runs in the scanned page. Must stay closure-free: everything it needs arrives
 * through `options` because chrome.scripting serialises the function source.
 *
 * One call scans for at most `options.budgetMs` so the service worker keeps
 * getting API responses (and therefore stays alive) while a long scan runs.
 */
async function profileScanChunk(options) {
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const hosts = new Set(options.hosts || []);
  const reserved = new Set(options.reserved || []);
  const usernamePattern = /^[A-Za-z0-9_]{1,15}$/;
  const videoSelector = "video,[data-testid='videoPlayer'],[data-testid='videoComponent']";

  function mediaUsername(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (!hosts.has(url.hostname)) {
        return null;
      }

      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length < 2 || parts[1].toLowerCase() !== "media") {
        return null;
      }

      const candidate = parts[0];
      if (!usernamePattern.test(candidate) || reserved.has(candidate.toLowerCase())) {
        return null;
      }

      return candidate;
    } catch (_error) {
      return null;
    }
  }

  const username = mediaUsername(window.location.href);
  if (!username) {
    return { ok: false, error: "Open an X/Twitter profile media page first." };
  }

  const expectedUsername = options.expectedUsername || "";
  if (expectedUsername && expectedUsername.toLowerCase() !== username.toLowerCase()) {
    return {
      ok: false,
      error: "Open the matching X/Twitter profile media page before starting a profile download.",
    };
  }

  const progress = Object.assign(
    {
      urls: [],
      passes: 0,
      stablePasses: 0,
      lastCount: 0,
      lastScrollY: -1,
      originalScrollY: null,
    },
    options.progress || {}
  );

  if (typeof progress.originalScrollY !== "number") {
    progress.originalScrollY = window.scrollY;
  }

  const links = new Map();
  (progress.urls || []).forEach((url) => links.set(url, url));

  // True when `node` sits inside a quoted post or an embedded article, i.e. it
  // belongs to a different author than the post `root` represents.
  function isEmbeddedContent(node, root) {
    let element = node.parentElement;
    while (element && element !== root) {
      if (element.tagName === "ARTICLE") {
        return true;
      }
      if (element.tagName === "DIV" && element.getAttribute("role") === "link") {
        return true;
      }
      element = element.parentElement;
    }
    return false;
  }

  function hasOwnVideoElement(root) {
    const nodes = root.querySelectorAll(videoSelector);
    for (const node of nodes) {
      if (!isEmbeddedContent(node, root)) {
        return true;
      }
    }
    return false;
  }

  function statusFromHref(href) {
    try {
      const url = new URL(href, window.location.href);
      if (!hosts.has(url.hostname)) {
        return null;
      }

      const parts = url.pathname.split("/").filter(Boolean);
      const statusIndex = parts.indexOf("status");
      if (statusIndex < 1 || statusIndex + 1 >= parts.length) {
        return null;
      }

      const owner = parts[statusIndex - 1];
      const id = parts[statusIndex + 1];
      if (!usernamePattern.test(owner) || !/^\d+$/.test(id)) {
        return null;
      }

      return {
        owner,
        id,
        url: `https://x.com/${owner}/status/${id}`,
        isVideoPath: (parts[statusIndex + 2] || "").toLowerCase() === "video",
      };
    } catch (_error) {
      return null;
    }
  }

  function ownedByProfile(status) {
    return Boolean(status) && status.owner.toLowerCase() === username.toLowerCase();
  }

  function ownAnchors(root) {
    const anchors = [];
    root.querySelectorAll("a[href*='/status/']").forEach((anchor) => {
      if (isEmbeddedContent(anchor, root)) {
        return;
      }
      const status = statusFromHref(anchor.getAttribute("href") || anchor.href);
      if (ownedByProfile(status)) {
        anchors.push({ anchor, status });
      }
    });
    return anchors;
  }

  // One canonical permalink per post: the timestamp anchor when present,
  // otherwise the first non-embedded status anchor owned by this profile.
  function canonicalPermalink(entries) {
    let fallback = null;
    for (const entry of entries) {
      if (entry.anchor.querySelector("time")) {
        return entry.status;
      }
      if (!fallback) {
        fallback = entry.status;
      }
    }
    return fallback;
  }

  function collectVisibleLinks() {
    document.querySelectorAll("article").forEach((article) => {
      if (isEmbeddedContent(article, document.body)) {
        return;
      }

      const entries = ownAnchors(article);
      const permalink = canonicalPermalink(entries);
      if (!permalink) {
        return;
      }

      const hasVideoAnchor = entries.some(
        (entry) => entry.status.isVideoPath && entry.status.id === permalink.id
      );
      if (!hasVideoAnchor && !hasOwnVideoElement(article)) {
        return;
      }

      links.set(permalink.url, permalink.url);
    });

    // Media-grid cells are plain anchors rather than articles.
    document.querySelectorAll("a[href*='/status/']").forEach((anchor) => {
      if (anchor.closest("article")) {
        return;
      }

      const status = statusFromHref(anchor.getAttribute("href") || anchor.href);
      if (!ownedByProfile(status)) {
        return;
      }
      if (!status.isVideoPath && !hasOwnVideoElement(anchor)) {
        return;
      }

      links.set(status.url, status.url);
    });
  }

  const startedAt = Date.now();
  const maxPasses = options.maxPasses || 36;
  const budgetMs = options.budgetMs || 4000;
  let done = false;

  collectVisibleLinks();

  while (true) {
    if (progress.passes >= maxPasses || progress.stablePasses >= 4) {
      done = true;
      break;
    }
    if (Date.now() - startedAt >= budgetMs) {
      break;
    }

    window.scrollBy(0, Math.max(700, Math.floor(window.innerHeight * 0.86)));
    await sleep(900);
    collectVisibleLinks();

    progress.passes += 1;
    const didGrow = links.size > progress.lastCount;
    const didMove = window.scrollY !== progress.lastScrollY;
    progress.stablePasses = didGrow || didMove ? 0 : progress.stablePasses + 1;
    progress.lastCount = links.size;
    progress.lastScrollY = window.scrollY;
  }

  progress.urls = Array.from(links.values());

  return { ok: true, username, done, progress };
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
