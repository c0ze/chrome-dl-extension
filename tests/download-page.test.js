import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// The whole picker/dashboard page (download.html and download.js) over a fake
// native host and a fake chrome. Each test boots its own copy of the page.

const ROOT = new URL("..", import.meta.url);
const LIBRARY = "/srv/archive/media/twitter";
const HTML = readFileSync(new URL("extension/download.html", ROOT), "utf8");

// Every page a test booted, closed afterwards so its poll timer cannot keep the
// run alive when an assertion failed first.
const openWindows = [];
afterEach(() => openWindows.splice(0).forEach((window) => window.close()));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 25; i += 1) await tick();
};

async function waitFor(condition, what, limit = 3000) {
  const start = Date.now();
  for (;;) {
    const value = condition();
    if (value) return value;
    if (Date.now() - start > limit) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

const folder = (group, name) => ({ group, base_dir: `${LIBRARY}/${group}`, name });
const entry = (handle, group, extra = {}) => ({
  handle,
  name: handle,
  profile_url: `https://x.com/${handle}/media`,
  base_dir: `${LIBRARY}/${group}`,
  group,
  folders: [folder(group, handle)],
  aliases: [],
  video_count: 3,
  known_count: 3,
  pending_count: 0,
  last_checked: null,
  checked_through: null,
  stale: null,
  ...extra,
});
const job = (id, handle, extra = {}) => ({
  id,
  url: `https://x.com/${handle}/status/${id}`,
  handle,
  status: "complete",
  filename: `/srv/archive/${handle}/${id}.mp4`,
  ...extra,
});

function makeWorld() {
  return {
    entries: [entry("alice", "group a"), entry("bob", "group a", { pending_count: 2 })],
    favorites: { "group a": 2 },
    jobs: [job("1", "alice"), job("2", "bob")],
    // What a check of a profile finds; the permission and config can be held.
    checkResult: { complete: true, urls: [] },
    configGate: null,
    chosenFolder: "/home/u/chosen",
    log: [],
  };
}

// Boots the page at `search` (the picker's query string). `world.log` collects
// every native message; `world.entries` is what the handle list answers.
async function boot(world, search = "") {
  const dom = new JSDOM(HTML, { url: `http://localhost/download.html${search}`, pretendToBeVisual: true });
  const { window } = dom;
  openWindows.push(window);
  window.confirm = () => true;
  window.HTMLMediaElement.prototype.pause = () => {};
  window.HTMLMediaElement.prototype.load = () => {};
  globalThis.window = window;
  globalThis.document = window.document;
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  globalThis.Node = window.Node;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Event = window.Event;

  const hostReply = async (payload) => {
    world.log.push(payload);
    switch (payload.type) {
      case "get_config":
        if (world.configGate) await world.configGate;
        return { ok: true, config: { download_dir: LIBRARY, player: "haruna" } };
      case "get_downloads":
        return { ok: true, jobs: world.jobs, active_count: 0, queued_count: 0, total_count: world.jobs.length };
      case "get_handles":
        return {
          ok: true,
          handles: JSON.parse(JSON.stringify(world.entries)),
          groups: ["group a", "group b"],
          library_root: LIBRARY,
        };
      case "get_favorites":
        if (payload.group) {
          return {
            ok: true,
            items: [
              {
                path: `${LIBRARY}/${payload.group}/alice/1.mp4`,
                relative: `${payload.group}/alice/1.mp4`,
                name: "1.mp4",
                handle: "alice",
                exists: true,
                added: "2026-01-01 10:00:00",
                thumb: "k1",
              },
            ],
          };
        }
        return { ok: true, groups: world.favorites };
      case "choose_download_dir":
        return { ok: true, path: world.chosenFolder };
      case "record_handle_scan": {
        const target = world.entries.find((candidate) => candidate.handle === payload.handle);
        target.pending_count = payload.urls.length;
        target.last_checked = "2026-11-23 10:00:00";
        return { ok: true, handle: JSON.parse(JSON.stringify(target)) };
      }
      case "download":
        return { ok: true, download_dir: payload.download_dir };
      default:
        return { ok: true, thumbs: {} };
    }
  };

  const noop = () => {};
  const storage = new Map();
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendNativeMessage: (_name, payload, callback) => {
        hostReply(payload).then((response) => setTimeout(() => callback(response), 0));
      },
      sendMessage: async (message) => {
        world.log.push({ via: "sendMessage", ...message });
        if (message.type === "check-handle") {
          return { ok: true, newestId: "1001", ...world.checkResult };
        }
        if (message.type === "rescan-profile") {
          return world.rescanResponse || { ok: true, continuation: true };
        }
        return { ok: true };
      },
    },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.filter((key) => storage.has(key)).map((key) => [key, storage.get(key)])),
        set: async (values) => Object.entries(values).forEach(([key, value]) => storage.set(key, value)),
      },
      session: { get: async () => ({}), remove: async () => {}, set: async () => {} },
      // The service worker's scan records arrive through here.
      onChanged: { addListener: (listener) => (world.onChanged = listener) },
    },
    permissions: { request: async () => true },
  };

  await import(`../extension/download.js?page=${boot.count++}`);
  const $ = (selector) => window.document.querySelector(selector);
  const $$ = (selector) => [...window.document.querySelectorAll(selector)];
  await waitFor(() => $$("#download-list .download-group").length >= 2, "the downloads list");
  await waitFor(() => $$("#handle-list .download-group").length, "the handle list");
  await settle();
  return {
    window,
    $,
    $$,
    sent: (type) => world.log.filter((message) => message.type === type),
    // The service worker writes a scan record for the picker's key.
    deliver: (record) => world.onChanged({ [SCAN_KEY]: { newValue: record } }, "session"),
    rescan: () => $("#rescan-button"),
    start: () => $("#download-form").dispatchEvent(new window.Event("submit", { cancelable: true })),
    message: () => $("#message"),
    header: (name) => {
      const group = $$("#download-list > .download-group").find(
        (details) => details.querySelector(".group-handle").textContent === name
      );
      const controls = group?.querySelector(".group-check-controls");
      return controls
        ? [...controls.children].map((child) => (child.tagName === "BUTTON" ? `[${child.textContent}]` : child.textContent))
        : null;
    },
  };
}
boot.count = 0;

// --- I2: the downloads header never picks a group for a creator in several ---

test("a header Download for a creator filed in two groups is not offered; Seen still is", async () => {
  const world = makeWorld();
  world.entries = [
    entry("alice", "group a"),
    entry("bob", "group a", {
      pending_count: 2,
      folders: [folder("group a", "bob"), folder("group b", "Bob B")],
    }),
  ];
  const page = await boot(world);

  assert.deepEqual(page.header("@bob"), ["2 new", "[Seen]", "[Check]"]);
  const badge = page.$$("#download-list .group-check-controls .handle-new")[0];
  assert.match(badge.title, /handle list/i);
});

test("a header Download for a creator with one folder queues into it", async () => {
  const world = makeWorld();
  const page = await boot(world);

  assert.deepEqual(page.header("@bob"), ["2 new", "[Download]", "[Seen]", "[Check]"]);
});

// --- I7: a check that did not read everything never says "Nothing new" ---

test("an incomplete check that found nothing reads as partial, a complete one as nothing new", async () => {
  const world = makeWorld();
  const page = await boot(world);

  world.checkResult = { complete: false, urls: [] };
  [...page.$$("#download-list .group-check-controls button")].find((b) => b.textContent === "Check").click();
  await waitFor(() => page.header("@alice")?.includes("Checked (partial)"), "the partial note");
  assert.deepEqual(page.header("@alice"), ["Checked (partial)", "[Check]"]);

  world.checkResult = { complete: true, urls: [] };
  page.$$("#download-list .group-check-controls button").find((b) => b.textContent === "Check").click();
  await waitFor(() => page.header("@alice")?.includes("Nothing new"), "Nothing new");
  assert.deepEqual(page.header("@alice"), ["Nothing new", "[Check]"]);
});

// --- I3: a slow config never overwrites a folder the user chose ---

test("a folder typed before the host's config arrives is kept", async () => {
  const world = makeWorld();
  let release;
  world.configGate = new Promise((resolve) => (release = resolve));
  const booting = boot(world);
  await waitFor(() => world.log.some((message) => message.type === "get_config"), "the config request");
  const field = globalThis.document.getElementById("download-dir");
  field.value = "/home/u/typed";
  field.dispatchEvent(new globalThis.window.Event("input", { bubbles: true }));

  release();
  const page = await booting;

  assert.equal(page.$("#download-dir").value, "/home/u/typed");
});

test("a folder chosen with Choose Folder before the config arrives is kept", async () => {
  const world = makeWorld();
  let release;
  world.configGate = new Promise((resolve) => (release = resolve));
  const booting = boot(world);
  await waitFor(() => world.log.some((message) => message.type === "get_config"), "the config request");
  globalThis.document.getElementById("browse-button").click();
  await waitFor(() => globalThis.document.getElementById("download-dir").value === "/home/u/chosen", "the chosen folder");

  release();
  const page = await booting;

  assert.equal(page.$("#download-dir").value, "/home/u/chosen");
});

test("with nothing typed the field takes the host's default folder", async () => {
  const page = await boot(makeWorld());
  assert.equal(page.$("#download-dir").value, LIBRARY);
});

// --- I4: auto-start belongs to one toolbar click, never to a reload ---

const POST = encodeURIComponent("https://x.com/alice/status/1001");

test("a toolbar click's picker starts the download once and takes the marker off its address", async () => {
  const world = makeWorld();
  const page = await boot(world, `?url=${POST}&source=toolbar&auto=1`);
  await waitFor(() => page.sent("download").length, "the automatic download");

  assert.equal(page.sent("download").length, 1);
  assert.equal(page.sent("download")[0].download_dir, `${LIBRARY}/group a/alice`);
  assert.equal(new URL(page.window.location.href).searchParams.has("auto"), false);
  assert.equal(new URL(page.window.location.href).searchParams.get("url"), "https://x.com/alice/status/1001");
});

test("reloading that picker does not start the download again", async () => {
  const first = await boot(makeWorld(), `?url=${POST}&source=toolbar&auto=1`);
  await waitFor(() => first.sent("download").length, "the automatic download");
  const reloaded = new URL(first.window.location.href).search;
  first.window.close();

  const world = makeWorld();
  const page = await boot(world, reloaded);
  await settle();

  assert.equal(page.sent("download").length, 0);
});

test("a picker with no marker never starts anything by itself", async () => {
  const world = makeWorld();
  const page = await boot(world, `?url=${POST}&source=context-menu`);
  await settle();

  assert.equal(page.sent("download").length, 0);
  assert.equal(page.$("#download-dir").value, `${LIBRARY}/group a/alice`, "the folder is still filled in");
});

test("choosing a folder cancels the automatic start and the marker is gone for a reload too", async () => {
  const world = makeWorld();
  let release;
  world.configGate = new Promise((resolve) => (release = resolve));
  const booting = boot(world, `?url=${POST}&source=toolbar&auto=1`);
  await waitFor(() => world.log.some((message) => message.type === "get_config"), "the config request");
  const field = globalThis.document.getElementById("download-dir");
  field.value = "/home/u/typed";
  field.dispatchEvent(new globalThis.window.Event("input", { bubbles: true }));
  release();
  const page = await booting;
  await settle();

  assert.equal(page.sent("download").length, 0);
  assert.equal(new URL(page.window.location.href).searchParams.has("auto"), false);
});

// --- I9: a favorites view replaces an open player ---

test("opening a favorites view from the chips closes an open player first", async () => {
  const world = makeWorld();
  const page = await boot(world);

  page.$$("#download-list button").find((button) => button.textContent === "Play").click();
  assert.equal(page.$("#player").classList.contains("hidden"), false, "the player is open");

  page.$("#favorite-chips .favorite-chip").click();
  await settle();

  assert.equal(page.$("#player").classList.contains("hidden"), true, "the player closed");
  assert.equal(page.$("#library-view").classList.contains("hidden"), false);
  assert.match(page.$("#dashboard-label").textContent, /Favorites in group a/);
});

// --- Scan Again: earlier videos and partial state survive a retry ------------

const SCAN_KEY = "profileBatch:1:picker";
const MEDIA_PAGE = encodeURIComponent("https://x.com/alice/media");
const SCANNED = `?url=${MEDIA_PAGE}&source=toolbar&profileBatchKey=${encodeURIComponent(SCAN_KEY)}&profileTabId=7`;
const link = (id) => `https://x.com/alice/status/${id}`;
const done = (extra) => ({ status: "done", provider: "twitter", username: "alice", partial: false, ...extra });
const startedWith = (page) => page.sent("download").at(-1)?.profile_urls;

async function scanned() {
  const world = makeWorld();
  const page = await boot(world, SCANNED);
  return { world, page };
}

test("a failed Scan Again leaves the earlier videos queueable, and the retry adds to them", async () => {
  const { page } = await scanned();
  page.deliver(done({ urls: [link(1001)], partial: true, partialTabs: ["media"] }));
  assert.equal(page.rescan().classList.contains("hidden"), false, "Scan Again is offered");

  page.rescan().click();
  await settle();
  page.deliver({ status: "error", provider: "twitter", username: "alice", error: "The page changed during the scan." });
  assert.equal(page.rescan().classList.contains("hidden"), false, "and offered again");
  assert.match(page.message().textContent, /The page changed during the scan\. The 1 video found earlier can still be queued\./);

  page.start();
  await waitFor(() => page.sent("download").length === 1, "the download");
  assert.deepEqual(startedWith(page), [link(1001)], "the earlier video is still queued");
  await settle();

  page.rescan().click();
  await settle();
  page.deliver(done({ continuation: true, tab: "media", urls: [link(1002)], partial: false }));
  page.start();
  await waitFor(() => page.sent("download").length === 2, "the second download");
  assert.deepEqual(startedWith(page), [link(1001), link(1002)], "the retry adds to the earlier video, not to nothing");
});

test("two failures in a row still keep the earlier videos", async () => {
  const { page } = await scanned();
  page.deliver(done({ urls: [link(1001)], partial: true, partialTabs: ["media"] }));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    page.rescan().click();
    await settle();
    page.deliver({ status: "error", provider: "twitter", username: "alice", error: "Nope." });
  }
  page.rescan().click();
  await settle();
  page.deliver(done({ continuation: true, tab: "media", urls: [link(1003)], partial: false }));
  page.start();
  await waitFor(() => page.sent("download").length === 1, "the download");
  assert.deepEqual(startedWith(page), [link(1001), link(1003)]);
});

test("a Scan Again that cannot be sent leaves the earlier videos too", async () => {
  const { world, page } = await scanned();
  world.rescanResponse = { ok: false, error: "The profile tab is gone." };
  page.deliver(done({ urls: [link(1001)], partial: true, partialTabs: ["media"] }));

  page.rescan().click();
  await settle();

  assert.match(page.message().textContent, /The profile tab is gone\. The 1 video found earlier can still be queued\./);
  page.start();
  await waitFor(() => page.sent("download").length === 1, "the download");
  assert.deepEqual(startedWith(page), [link(1001)]);
});

test("a continuation that finds nothing new keeps the videos it was started with", async () => {
  const { page } = await scanned();
  page.deliver(done({ urls: [link(1001)], partial: true, partialTabs: ["media"] }));
  page.rescan().click();
  await settle();
  page.deliver(done({ continuation: true, tab: "media", urls: [], partial: false }));
  page.start();
  await waitFor(() => page.sent("download").length === 1, "the download");
  assert.deepEqual(startedWith(page), [link(1001)]);
});

// --- Partial state is per tab -------------------------------------------------

test("a complete pass over one tab does not clear the other tab's partial warning", async () => {
  const { page } = await scanned();
  let confirms = 0;
  page.window.confirm = () => {
    confirms += 1;
    return true;
  };
  // The Media tab could not be opened, so only Posts was read.
  page.deliver(done({ urls: [link(1001)], partial: true, partialTabs: ["media"] }));
  assert.equal(page.message().className.includes("warning"), true);

  page.rescan().click();
  await settle();
  page.deliver(done({ continuation: true, tab: "posts", urls: [link(1002)], partial: false }));

  assert.equal(page.message().className.includes("warning"), true, "Media is still unread");
  assert.equal(page.rescan().classList.contains("hidden"), false, "Scan Again is still offered");
  page.start();
  await waitFor(() => page.sent("download").length === 1, "the download");
  assert.equal(confirms, 1, "the partial-scan confirmation was asked");
  assert.deepEqual(startedWith(page), [link(1001), link(1002)]);
  await settle();

  // Reading Media to the end by a continuation does not clear Media's mark either:
  // only a scan from the top can say a tab is whole.
  page.rescan().click();
  await settle();
  page.deliver(done({ continuation: true, tab: "media", urls: [link(1003)], partial: false }));
  assert.equal(page.message().className.includes("warning"), true);
  assert.equal(page.rescan().classList.contains("hidden"), false);

  // A scan from the top that read both tabs through does.
  page.rescan().click();
  await settle();
  page.deliver(done({ urls: [link(1001), link(1002), link(1003)], partialTabs: [] }));
  assert.equal(page.message().className.includes("success"), true);
  assert.equal(page.rescan().classList.contains("hidden"), true);
  page.start();
  await waitFor(() => page.sent("download").length === 2, "the second download");
  assert.equal(confirms, 1, "no confirmation once nothing is partial");
});

test("an empty complete retry of a partial tab leaves it partial", async () => {
  const { page } = await scanned();
  let confirms = 0;
  page.window.confirm = () => {
    confirms += 1;
    return true;
  };
  page.deliver(done({ urls: [link(1001)], partial: true, partialTabs: ["media"] }));

  page.rescan().click();
  await settle();
  page.deliver(done({ continuation: true, tab: "media", urls: [], partial: false }));

  assert.equal(page.message().className.includes("warning"), true, "still the partial warning");
  assert.equal(page.rescan().classList.contains("hidden"), false, "Scan Again is still offered");
  page.start();
  await waitFor(() => page.sent("download").length === 1, "the download");
  assert.equal(confirms, 1, "the confirmation was asked");
  assert.deepEqual(startedWith(page), [link(1001)]);
});

// --- A scan record that does not say which tab was partial --------------------

test("a record that does not name the partial tab is cleared by both tabs being read, or by a scan from the top", async () => {
  const first = await scanned();
  first.page.deliver(done({ urls: [link(1001)], partial: true })); // no partialTabs
  assert.equal(first.page.rescan().classList.contains("hidden"), false);

  first.page.rescan().click();
  await settle();
  first.page.deliver(done({ continuation: true, tab: "posts", urls: [link(1002)], partial: false }));
  assert.equal(first.page.message().className.includes("warning"), true, "Media is not read yet");

  first.page.rescan().click();
  await settle();
  first.page.deliver(done({ continuation: true, tab: "media", urls: [link(1003)], partial: false }));
  assert.equal(first.page.message().className.includes("success"), true, "both tabs read: the warning is gone");
  assert.equal(first.page.rescan().classList.contains("hidden"), true);

  const second = await scanned();
  second.page.deliver(done({ urls: [link(1001)], partial: true }));
  second.page.rescan().click();
  await settle();
  second.page.deliver(done({ urls: [link(1001), link(1002)], partial: false }));
  assert.equal(second.page.message().className.includes("success"), true, "a complete scan from the top clears it");
});

test("a pass over a tab that is still partial leaves it partial", async () => {
  const { page } = await scanned();
  page.deliver(done({ urls: [link(1001)], partial: true, partialTabs: ["posts"] }));
  page.rescan().click();
  await settle();
  page.deliver(done({ continuation: true, tab: "posts", urls: [link(1002)], partial: true }));

  assert.equal(page.rescan().classList.contains("hidden"), false);
  assert.equal(page.message().className.includes("warning"), true);
});

test("a complete scan offers no Scan Again", async () => {
  const { page } = await scanned();
  page.deliver(done({ urls: [link(1001)], partialTabs: [] }));
  assert.equal(page.rescan().classList.contains("hidden"), true);
});

// --- Facebook's Scan Again is a fresh scan -----------------------------------

test("a Facebook partial scan does not promise that Scan Again adds older posts", async () => {
  const world = makeWorld();
  const reels = encodeURIComponent("https://www.facebook.com/somepage/reels");
  const page = await boot(world, `?url=${reels}&source=toolbar&profileBatchKey=${encodeURIComponent(SCAN_KEY)}&profileTabId=7`);

  page.deliver({
    status: "done",
    provider: "facebook",
    username: "somepage",
    urls: ["https://www.facebook.com/reel/1"],
    partial: true,
  });

  const text = page.message().textContent;
  assert.match(text, /scan it afresh/);
  assert.doesNotMatch(text, /add older posts/);
});

test("an X partial scan says Scan Again adds older posts", async () => {
  const { page } = await scanned();
  page.deliver(done({ urls: [link(1001)], partial: true, partialTabs: ["media"] }));
  assert.match(page.message().textContent, /Scan Again to add older posts to them/);
});
