import {
  TWITTER_HOSTS,
  FACEBOOK_HOSTS,
  RESERVED_PROFILE_USERNAMES,
  batchTargetForUrl,
  isScanPageUrl,
  mergeScanPasses,
  scanPageTab,
  profileScanChunk,
  twitterMediaUrl,
  twitterPostsUrl,
  twitterProfileUsername,
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
const SCROLL_RESTORE_TIMEOUT_MS = 4000;
const SCROLL_RESTORE_RETRY_MS = 500;
// After a page is scrolled back to the top, X's feed takes a moment to draw
// the posts there; the scan reads the page only once they are in.
const SCROLL_TOP_SETTLE_MS = 800;

// Batch keys whose scan is running in this worker instance. Empty after a
// worker restart, which is exactly when a popup-driven rescan should be allowed.
const activeScans = new Set();

// The scan that owns each source tab: { key, username, chain }. Starting another
// scan on a tab replaces its entry, and the older scan, seeing it is no longer
// the owner, stops at its next step without touching the tab or writing a result.
const tabScans = new Map();

// Where a run of overlapping scans on one tab puts the tab back: { username,
// returnUrl, scrollY }, `scrollY` being the promise of the scroll read before
// the run's first scan moved the tab. It is made once, by that first scan; each
// scan that replaces another for the same creator, while the tab is still on
// that creator's profile, uses the same entry and never changes it, so a third
// scan cannot inherit anything half-settled. It is dropped when the scan that
// owns the tab finishes.
const tabReturns = new Map();

class ScanSuperseded extends Error {
  constructor() {
    super("A newer scan took over this tab.");
    this.name = "ScanSuperseded";
  }
}

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

async function readScrollPosition(tabId) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.scrollY,
    });
    return typeof injection?.result === "number" ? injection.result : null;
  } catch (_error) {
    // The page cannot be read; there is no position to bring back.
    return null;
  }
}

// Scrolls the tab to `scrollY` once; resolves to where the page ended up (a page
// shorter than that stops at its bottom), or null when it could not be done.
// With `expectedUrl` the scroll happens only if the page is still on that URL,
// which the page itself checks right before scrolling, so a tab that moved on in
// the meantime is left alone.
async function restoreScrollPosition(tabId, scrollY, expectedUrl = null) {
  if (typeof scrollY !== "number") {
    return null;
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (y, expected) => {
        if (expected !== null && window.location.href !== expected) {
          return null;
        }
        window.scrollTo(0, y);
        return window.scrollY;
      },
      args: [scrollY, expectedUrl],
    });
    return typeof injection?.result === "number" ? injection.result : null;
  } catch (_error) {
    // The tab may be gone or navigated away; nothing to restore.
    return null;
  }
}

// A page that was just reloaded is shorter than the one the user left: the feed
// loads more as it is scrolled. So scroll again, a moment apart, until the page
// has reached `scrollY` or the time is up; best effort, the position may never
// be reachable. Every try is for `url` only: the page may be left (a redirect, a
// click) between tries, and the offset means nothing on another page, so the
// first try on a different URL ends it.
async function restoreScrollUntilReached(tabId, scrollY, url, current = () => true) {
  const deadline = Date.now() + SCROLL_RESTORE_TIMEOUT_MS;
  while (current()) {
    const reached = await restoreScrollPosition(tabId, scrollY, url);
    if (reached === null || reached >= scrollY - 2 || Date.now() >= deadline) {
      return;
    }
    await sleep(SCROLL_RESTORE_RETRY_MS);
  }
}

// Scrolls the tab to its top and waits for the posts there to be drawn, so a
// pass reads a page from the same place whatever the user had scrolled to.
async function scrollToTop(tabId) {
  await restoreScrollPosition(tabId, 0);
  await sleep(SCROLL_TOP_SETTLE_MS);
}

/**
 * Scans a profile page for the picker and settles `key` with one final record.
 * A Twitter profile is read twice, Posts then Media, in the tab it was started
 * from; the tab is put back on `returnUrl` afterwards.
 *
 * The final record is the last thing written: the tab is already back where it
 * was and the scan guard is released, because the picker offers Scan Again the
 * moment it sees the record and a restart must then be able to run.
 */
async function scanProfileTab(tabId, provider, username, key, returnUrl = null, { continuation = false } = {}) {
  if (activeScans.has(key)) {
    return;
  }

  activeScans.add(key);
  const replacing = tabScans.has(tabId);
  const run = { key, username, chain: null };
  tabScans.set(tabId, run);
  const current = () => tabScans.get(tabId) === run;
  let record = null;
  let owner = false;
  try {
    run.chain = await joinReturnChain(tabId, username, returnUrl, replacing, current);
    record =
      provider === "twitter"
        ? await scanTwitterProfile(tabId, username, key, run, { current, continuation })
        : await runProfileScan(tabId, provider, username, key, current);
  } catch (error) {
    if (!(error instanceof ScanSuperseded)) {
      record = {
        status: "error",
        provider,
        username,
        error: error?.message || "Could not scan the profile media page.",
      };
    }
  } finally {
    // Asked here, with nothing awaited before the write below: a scan that lost
    // the tab at any point, even during its last read, settles nothing.
    owner = current();
    activeScans.delete(key);
    if (owner) {
      tabScans.delete(tabId);
      tabReturns.delete(tabId);
    }
  }
  if (!record || !owner) {
    // Replaced by a newer scan: the picker that waited on this key was pointed
    // at the newer one, so there is nothing to settle.
    await chrome.storage.session.remove(key).catch(() => {});
    return;
  }
  await writeScanRecord(key, record);
}

// The return point a scan works to. One that replaces a scan on the same
// creator, while the tab is still on one of that creator's profile pages, joins
// the entry the run already has (the tab was moved by the older scan, so its
// own page is not where the user left it). Any other scan makes a new entry from
// the page it started on; one that no longer owns the tab publishes nothing.
async function joinReturnChain(tabId, username, returnUrl, replacing, current) {
  const wanted = String(username).toLowerCase();
  const running = () => {
    const chain = tabReturns.get(tabId);
    return chain?.returnUrl && String(chain.username).toLowerCase() === wanted ? chain : null;
  };
  if (replacing && running()) {
    try {
      const tab = await chrome.tabs.get(tabId);
      // Asked again after the wait: the entry may have been replaced meanwhile.
      const chain = running();
      if (chain && twitterProfileUsername(tab.url)?.toLowerCase() === wanted) {
        return chain;
      }
    } catch (_error) {
      // The tab is gone; the scan reports that itself.
    }
  }
  const chain = {
    username,
    returnUrl,
    scrollY: returnUrl ? readScrollPosition(tabId) : Promise.resolve(null),
  };
  if (returnUrl && current()) {
    tabReturns.set(tabId, chain);
  }
  return chain;
}

// Resolves to the record that settles the scan (see scanProfileTab).
async function runProfileScan(tabId, provider, username, key, current = () => true) {
  const pass = await scanPass(tabId, provider, username, key, { current });
  // A scan that lost the tab leaves its scroll to the one that took it over.
  if (!current()) {
    throw new ScanSuperseded();
  }
  await restoreScrollPosition(tabId, pass.originalScrollY);
  return scanRecord(provider, username, pass, pass.profileName);
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
    // Which tab is only part read (a full Twitter scan only): see mergeScanPasses.
    ...(merged.partialTabs ? { partialTabs: merged.partialTabs } : {}),
    newestId: merged.newestId,
    profileName,
  };
}

const scanningRecord = (username, found) => ({
  status: "scanning",
  provider: "twitter",
  username,
  found,
});

// The picker takes 20 seconds without a record for a stalled worker, and a page
// load can take longer than that (waitForTabLoad gives up after 30), so while a
// tab is moving the scanning record is rewritten every few seconds.
const SCAN_HEARTBEAT_MS = 5000;

async function whileKeepingScanAlive(key, record, work) {
  await writeScanRecord(key, record);
  // A write still in flight when the work ends must land before the caller
  // writes the result, or it could overwrite it.
  let inflight = Promise.resolve();
  const timer = setInterval(() => {
    inflight = writeScanRecord(key, record);
  }, SCAN_HEARTBEAT_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await inflight;
  }
}

// Resolves to the record that settles the scan (see scanProfileTab). `run` is
// the tab's scan entry: where to put the tab back (`returnUrl`, with the scroll
// read before the scan moves the tab away). `current` says whether this scan
// still owns the tab; throws ScanSuperseded when it does not. A `continuation`
// reads only the tab as it stands (Scan Again on the profile's Posts or Media
// tab, scrolled where the user left it) and the picker adds what it finds to
// what it had; otherwise both tabs are read, each from its top.
async function scanTwitterProfile(tabId, username, key, run, { current = () => true, continuation = false } = {}) {
  const stillOurs = () => {
    if (!current()) {
      throw new ScanSuperseded();
    }
  };
  if (continuation) {
    // The record names the tab the pass read, as the scanned page itself said
    // (the user may have switched tabs since the request): the picker settles
    // that tab alone and keeps the other's partial state as it was.
    const pass = await scanPass(tabId, "twitter", username, key, { current });
    const record = scanRecord("twitter", username, pass, pass.profileName);
    return pass.ok ? { ...record, continuation: true, tab: pass.tab || continuation } : record;
  }

  // Where the user left the page, shared by the scans that replace one another.
  const { returnUrl } = run.chain;
  const startScrollY = returnUrl ? await run.chain.scrollY : null;
  let postsPass = null;
  let mediaPass = null;
  try {
    try {
      await whileKeepingScanAlive(key, scanningRecord(username, 0), async () => {
        stillOurs();
        await showTwitterPosts(tabId, username, current);
        stillOurs();
        await scrollToTop(tabId);
      });
    } catch (error) {
      if (error instanceof ScanSuperseded) {
        throw error;
      }
      return {
        status: "error",
        provider: "twitter",
        username,
        error: error?.message || "Could not open the profile's Posts tab.",
      };
    }

    stillOurs();
    postsPass = await scanPass(tabId, "twitter", username, key, { current });
    if (postsPass.ok) {
      mediaPass = await scanTwitterMedia(tabId, username, key, postsPass, { current, fromTop: true });
    }
    const merged = mergeScanPasses(postsPass, mediaPass);
    return scanRecord("twitter", username, merged, postsPass.profileName);
  } finally {
    // A scan that lost the tab leaves it to the one that took it over.
    if (returnUrl && current()) {
      const found = new Set([...(postsPass?.urls ?? []), ...(mediaPass?.urls ?? [])]).size;
      await whileKeepingScanAlive(key, scanningRecord(username, found), () =>
        returnToStartPage(tabId, returnUrl, startScrollY, username, current)
      );
    }
  }
}

/**
 * The Media pass of a Twitter scan, after the Posts pass: moves the tab to the
 * Media tab and reads it, counting the Posts videos as already found. Never
 * throws: a Media tab that will not open is a failed pass, which the merge
 * keeps the Posts videos for.
 */
async function scanTwitterMedia(
  tabId,
  username,
  key,
  postsPass,
  { stopAtId = null, current = () => true, fromTop = false } = {}
) {
  if (!current()) {
    throw new ScanSuperseded();
  }
  try {
    await whileKeepingScanAlive(key, scanningRecord(username, postsPass.urls.length), async () => {
      await showTabUrl(tabId, twitterMediaUrl(username), { current });
      if (!current()) {
        throw new ScanSuperseded();
      }
      // A tab that was already on Media keeps its scroll through the "move".
      if (fromTop) {
        await scrollToTop(tabId);
      }
    });
  } catch (error) {
    if (error instanceof ScanSuperseded) {
      throw error;
    }
    return { ok: false, error: error?.message || "Could not open the profile's Media tab.", urls: [] };
  }
  return scanPass(tabId, "twitter", username, key, { stopAtId, carryUrls: postsPass.urls, current });
}

/**
 * Puts the tab back on exactly the URL the scan was started from (query and
 * fragment included) and scrolls it to where the user had it, but only while
 * the page is really on that URL: a redirect lands on some other page, which
 * the old offset says nothing about. Only a tab still on one of the profile's
 * own pages the scan opened (or already on the start URL) is moved: one the
 * user has taken somewhere else is left alone. Best effort: the tab may be gone.
 */
async function returnToStartPage(tabId, returnUrl, scrollY, username, current = () => true) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!current() || (tab.url !== returnUrl && !isScanPageUrl(tab.url, username))) {
      return;
    }
    // Ownership is asked again right before the navigation and before each
    // scroll, since a newer scan may take the tab at any of those waits.
    await showTabUrl(tabId, returnUrl, { exact: true, current });
    await restoreScrollUntilReached(tabId, scrollY, returnUrl, current);
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
  { maxRounds = PROFILE_SCAN_MAX_ROUNDS, stopAtId = null, carryUrls = [], current = () => true } = {}
) {
  let progress = null;
  let profileName = "";
  // The profile tab the page reported on (X only), to label the pass with.
  let readTab = null;
  const hosts = provider === "facebook" ? FACEBOOK_HOSTS : TWITTER_HOSTS;
  const pass = (fields) => ({
    ok: true,
    urls: [],
    partial: false,
    complete: false,
    newestId: null,
    tab: readTab,
    profileName,
    originalScrollY: progress?.originalScrollY ?? null,
    ...fields,
  });

  try {
    for (let round = 0; round < maxRounds; round += 1) {
      if (!current()) {
        throw new ScanSuperseded();
      }
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

      // The page moving to the profile's other tab between two reads means the
      // pass read both: it can be labelled with neither.
      if (result.tab) {
        if (readTab && readTab !== result.tab) {
          return pass({ ok: false, error: "The page changed during the scan. Open the profile again and rescan." });
        }
        readTab = result.tab;
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
    if (error instanceof ScanSuperseded) {
      throw error;
    }
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

  // Scan Again on a tab that is already on the profile's Posts or Media page
  // carries on from where the user scrolled it, without moving the tab; the
  // picker adds what it finds to the videos it already has. From any other tab
  // the whole two-tab scan runs again, and the tab goes back where it was.
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_error) {
    // The scan reports the tab as unreadable.
  }
  const continuation = provider === "twitter" && tab ? scanPageTab(tab.url, username) : null;
  const returnUrl = provider === "twitter" && !continuation ? tab?.url || null : null;

  await writeScanRecord(key, { status: "scanning", provider, username });
  void scanProfileTab(tabId, provider, username, key, returnUrl, { continuation });
  return { ok: true, continuation: Boolean(continuation) };
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

// Moves a tab to `url` and waits for it to load; does nothing when it is there.
// A scan's own pages (a profile's tabs) count as there when they differ only in
// a trailing slash or letter case; with `exact` the URL must be the same string,
// so a query or fragment is not lost.
async function showTabUrl(tabId, url, { exact = false, current = () => true } = {}) {
  const plain = (value) => String(value || "").replace(/\/$/, "").toLowerCase();
  const tab = await chrome.tabs.get(tabId);
  if (exact ? tab.url === url : plain(tab.url) === plain(url)) {
    return;
  }
  if (!current()) {
    return; // A newer scan owns the tab; the caller finds that out and stops.
  }
  await chrome.tabs.update(tabId, { url });
  await sleep(300); // Let the navigation start before waiting for it to finish.
  await waitForTabLoad(tabId);
}

/**
 * Puts a Twitter profile tab on the Posts tab, where a scan starts (see
 * twitterPostsUrl); a scan started from another tab moves the tab there.
 */
function showTwitterPosts(tabId, username, current) {
  return showTabUrl(tabId, twitterPostsUrl(username), { current });
}

/**
 * Looks at one handle's profile for the handle list: opens it in a background
 * tab, scans the top of its Posts tab and then its Media tab, and closes it
 * again. The URL is validated the same way a toolbar scan's is, so only a real
 * X/Twitter profile is ever opened and read.
 */
async function checkHandle(message) {
  // Every reply has the same six fields, a failure included.
  const reply = (fields) => ({
    ok: false,
    gone: false,
    error: null,
    urls: [],
    newestId: null,
    complete: false,
    ...fields,
  });

  const url = typeof message?.profileUrl === "string" ? message.profileUrl : "";
  const target = batchTargetForUrl(url);
  if (!target || target.provider !== "twitter") {
    return reply({ error: "This profile cannot be checked." });
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
    return reply({
      ok: merged.ok,
      gone: merged.gone,
      error: merged.ok ? null : merged.error || "The profile could not be scanned.",
      urls: merged.urls,
      newestId: merged.newestId,
      complete: merged.complete,
    });
  } catch (error) {
    return reply({ error: error?.message || "The profile could not be scanned." });
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
  // The picker may start the download by itself for this one click of the
  // toolbar button or the page menu, never for a link that was right-clicked,
  // and never when the picker is reloaded or restored: it takes the marker off
  // its own address before it acts on it.
  if (!fromLink) {
    params.set("auto", "1");
  }
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
