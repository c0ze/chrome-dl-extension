import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { profileScanChunk } from "../extension/providers.js";

// The service worker (background.js) over a fake chrome: tabs that remember
// their URL and scroll position, a scripting API that answers for the scan
// function, and session storage. Time is virtual (mock timers), so the scan's
// waits for pages to load cost nothing.

const EXTENSION = "chrome-extension://abc/";
const plain = (url) => String(url || "").replace(/\/$/, "").toLowerCase();

afterEach(() => mock.timers.reset());

// `pages[url]` is what a scan of that page finds. `chunkHook(tab, options)` may
// hold a scan pass open or change the tab under it; return a result to use it.
function makeWorld({ tabUrl, scrollY = 0, pages = {} }) {
  const world = {
    tabs: new Map([[7, { id: 7, windowId: 1, index: 0, url: tabUrl, scrollY, status: "complete" }]]),
    pages,
    log: [], // ["update", tabId, url] and ["scroll", url, y], in order
    chunks: [], // [{ url, scrollY }] per scan pass
    created: [],
    store: new Map(),
    writes: [],
    listeners: {},
    chunkHook: null,
    setHook: null,
  };
  const register = (name) => ({ addListener: (listener) => (world.listeners[name] = listener) });
  world.chrome = {
    runtime: {
      getURL: (path) => `${EXTENSION}${path}`,
      getContexts: async () => [],
      onInstalled: register("installed"),
      onMessage: register("message"),
    },
    contextMenus: { removeAll: (callback) => callback?.(), create: () => {}, onClicked: register("menu") },
    action: { onClicked: register("action") },
    windows: { update: async () => {} },
    tabs: {
      get: async (id) => {
        const tab = world.tabs.get(id);
        if (!tab) throw new Error("No tab with that id.");
        return { ...tab };
      },
      update: async (id, props) => {
        const tab = world.tabs.get(id);
        world.log.push(["update", id, props.url]);
        if (props.url) {
          tab.url = props.url;
          tab.scrollY = 0;
        }
        return { ...tab };
      },
      create: async (props) => {
        world.created.push(props);
        return { id: 100 + world.created.length };
      },
      remove: async () => {},
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        const tab = world.tabs.get(target.tabId);
        if (func === profileScanChunk) {
          const [options] = args;
          world.chunks.push({ url: tab.url, scrollY: tab.scrollY });
          const hooked = world.chunkHook ? await world.chunkHook(tab, options) : null;
          if (hooked) return [{ result: hooked }];
          const urls = world.pages[plain(tab.url)] || [];
          return [
            {
              result: {
                ok: true,
                username: options.expectedUsername,
                done: true,
                capped: false,
                reachedStop: false,
                newestId: "1001",
                profileName: "Alice",
                urls,
                progress: { urls, originalScrollY: tab.scrollY },
              },
            },
          ];
        }
        if (args?.length === 2) {
          const [y, expected] = args; // restoreScrollPosition
          if (expected !== null && tab.url !== expected) return [{ result: null }];
          world.log.push(["scroll", tab.url, y]);
          tab.scrollY = y;
          return [{ result: tab.scrollY }];
        }
        return [{ result: tab.scrollY }]; // readScrollPosition
      },
    },
    storage: {
      session: {
        get: async (key) => (key === null ? Object.fromEntries(world.store) : { [key]: world.store.get(key) }),
        remove: async (keys) => [].concat(keys).forEach((key) => world.store.delete(key)),
        set: async (values) => {
          for (const [key, record] of Object.entries(values)) {
            if (world.setHook) await world.setHook(key, record);
            world.writes.push([key, record.status]);
            world.store.set(key, record);
          }
        },
      },
    },
  };
  return world;
}

let imports = 0;
async function load(world) {
  globalThis.chrome = world.chrome;
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  await import(`../extension/background.js?world=${imports++}`);
}

// Lets virtual time run until `condition` holds.
async function until(condition, what = "the condition") {
  for (let i = 0; i < 5000; i += 1) {
    if (condition()) return;
    mock.timers.tick(100);
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const settledRecord = (world, key) => {
  const record = world.store.get(key);
  return record && record.status !== "scanning" ? record : null;
};

const batchKey = (world) => new URL(world.created[0].url).searchParams.get("profileBatchKey");

async function clickToolbar(world) {
  const tab = await world.chrome.tabs.get(7);
  world.listeners.action(tab);
}

const POSTS = "https://x.com/alice";
const MEDIA = "https://x.com/alice/media";
const REPLIES = "https://x.com/alice/with_replies";

// --- I4: the picker is told when auto-start is allowed -----------------------

test("the toolbar button and the page menu mark the picker for auto-start", async () => {
  for (const [open, source] of [
    [(world) => world.listeners.action({ id: 7, url: POSTS, windowId: 1, index: 0 }), "toolbar"],
    [(world) => world.listeners.menu({ menuItemId: "download-with-ytdlp", pageUrl: POSTS }, { id: 7, url: POSTS, windowId: 1, index: 0 }), "context-menu"],
  ]) {
    const world = makeWorld({ tabUrl: POSTS });
    await load(world);
    open(world);
    await until(() => world.created.length === 1, "the picker");
    const params = new URL(world.created[0].url).searchParams;
    assert.equal(params.get("auto"), "1", source);
    assert.equal(params.get("source"), source);
    mock.timers.reset();
  }
});

test("a right-clicked link never marks the picker for auto-start", async () => {
  const world = makeWorld({ tabUrl: "https://x.com/home" });
  await load(world);

  world.listeners.menu(
    { menuItemId: "download-with-ytdlp", linkUrl: "https://x.com/alice/status/1001", pageUrl: "https://x.com/home" },
    { id: 7, url: "https://x.com/home", windowId: 1, index: 0 }
  );
  await until(() => world.created.length === 1, "the picker");

  assert.equal(new URL(world.created[0].url).searchParams.has("auto"), false);
});

test("a picker opened with nothing to download has no marker either", async () => {
  const world = makeWorld({ tabUrl: "chrome://newtab/" });
  await load(world);

  world.listeners.action({ id: 7, url: "chrome://newtab/", windowId: 1, index: 0 });
  await until(() => world.created.length === 1, "the picker");

  assert.equal(world.created[0].url, `${EXTENSION}download.html`);
});

// --- I5: where a scan starts, and what Scan Again does ------------------------

test("a toolbar scan reads each tab from its top, whichever tab and scroll it started from", async () => {
  for (const startUrl of [POSTS, MEDIA, REPLIES]) {
    const world = makeWorld({ tabUrl: startUrl, scrollY: 1500, pages: { [plain(POSTS)]: ["p1"], [plain(MEDIA)]: ["m1"] } });
    await load(world);

    await clickToolbar(world);
    await until(() => world.created.length === 1 && settledRecord(world, batchKey(world)), "the scan result");

    assert.deepEqual(world.chunks.map((chunk) => [plain(chunk.url), chunk.scrollY]), [
      [plain(POSTS), 0],
      [plain(MEDIA), 0],
    ], startUrl);
    const record = settledRecord(world, batchKey(world));
    assert.equal(record.status, "done");
    assert.deepEqual(record.urls, ["p1", "m1"]);
    assert.equal(record.continuation, undefined);
    // The user's page and scroll are put back.
    const tab = world.tabs.get(7);
    assert.equal(tab.url, startUrl);
    assert.equal(tab.scrollY, 1500);
    mock.timers.reset();
  }
});

async function scanAgain(world, key, url) {
  let answer;
  const answered = new Promise((resolve) => (answer = resolve));
  world.listeners.message({ type: "rescan-profile", key, tabId: 7, username: "alice", url }, {}, answer);
  let response = null;
  answered.then((value) => (response = value));
  await until(() => response, "the answer to Scan Again");
  return response;
}

test("Scan Again on the Media tab carries on from where it was scrolled, without moving the tab", async () => {
  const world = makeWorld({ tabUrl: MEDIA, scrollY: 1500, pages: { [plain(MEDIA)]: ["m2"] } });
  await load(world);
  const key = "profileBatch:1:a";

  const response = await scanAgain(world, key, MEDIA);
  await until(() => settledRecord(world, key), "the result");

  assert.equal(response.continuation, true);
  assert.deepEqual(world.chunks.map((chunk) => [plain(chunk.url), chunk.scrollY]), [[plain(MEDIA), 1500]]);
  assert.deepEqual(world.log.filter(([kind]) => kind === "update"), [], "the tab was not navigated");
  assert.deepEqual(world.log.filter(([kind]) => kind === "scroll"), [], "nor scrolled");
  const record = settledRecord(world, key);
  assert.equal(record.status, "done");
  assert.equal(record.continuation, true);
  assert.deepEqual(record.urls, ["m2"]);
});

test("Scan Again on the Posts tab carries on there too", async () => {
  const world = makeWorld({ tabUrl: `${POSTS}?s=20`, scrollY: 900, pages: {} });
  await load(world);
  const key = "profileBatch:1:b";

  const response = await scanAgain(world, key, MEDIA);
  await until(() => settledRecord(world, key), "the result");

  assert.equal(response.continuation, true);
  assert.deepEqual(world.chunks.map((chunk) => chunk.scrollY), [900]);
});

test("Scan Again from any other tab runs the whole scan from the top and puts the tab back", async () => {
  const world = makeWorld({ tabUrl: REPLIES, scrollY: 1200, pages: { [plain(POSTS)]: ["p1"], [plain(MEDIA)]: ["m1"] } });
  await load(world);
  const key = "profileBatch:1:c";

  const response = await scanAgain(world, key, MEDIA);
  await until(() => settledRecord(world, key), "the result");

  assert.equal(response.continuation, false);
  assert.deepEqual(world.chunks.map((chunk) => [plain(chunk.url), chunk.scrollY]), [
    [plain(POSTS), 0],
    [plain(MEDIA), 0],
  ]);
  const record = settledRecord(world, key);
  assert.equal(record.continuation, undefined);
  assert.deepEqual(record.urls, ["p1", "m1"]);
  assert.equal(world.tabs.get(7).url, REPLIES, "back on the page it was on");
  assert.equal(world.tabs.get(7).scrollY, 1200);
});

// --- I6: a scan leaves a tab alone once it is not its to touch ---------------

test("a tab the user took somewhere else during the scan is not navigated or scrolled back", async () => {
  const world = makeWorld({ tabUrl: REPLIES, scrollY: 800, pages: { [plain(POSTS)]: ["p1"] } });
  let userLeftAt = -1;
  world.chunkHook = (tab) => {
    if (plain(tab.url) !== plain(MEDIA)) return null;
    // The user opens another page in this tab while its Media tab is read.
    userLeftAt = world.log.length;
    tab.url = "https://x.com/home";
    tab.scrollY = 300;
    return { ok: false, error: "The page changed during the scan. Open the profile again and rescan." };
  };
  await load(world);

  await clickToolbar(world);
  await until(() => world.created.length === 1 && settledRecord(world, batchKey(world)), "the result");

  assert.ok(userLeftAt > 0, "the user left during the Media pass");
  assert.deepEqual(world.log.slice(userLeftAt), [], "nothing was done to the tab after the user left");
  assert.equal(world.tabs.get(7).url, "https://x.com/home");
  assert.equal(world.tabs.get(7).scrollY, 300);
  // The Posts videos found before it are kept.
  assert.equal(settledRecord(world, batchKey(world)).status, "done");
});

test("a newer scan on a tab replaces an older one, which stops without touching the tab or the record", async () => {
  const world = makeWorld({ tabUrl: REPLIES, scrollY: 640, pages: { [plain(POSTS)]: ["p1"], [plain(MEDIA)]: ["m1"] } });
  let heldCalls = 0;
  let letFirstGo;
  const firstPassHeld = new Promise((resolve) => (letFirstGo = resolve));
  world.chunkHook = async () => {
    heldCalls += 1;
    if (heldCalls === 1) await firstPassHeld; // the older scan's Posts pass hangs here
    return null;
  };
  await load(world);

  await clickToolbar(world);
  await until(() => world.created.length === 1 && world.chunks.length === 1, "the first scan to reach its Posts pass");
  const firstKey = batchKey(world);

  await clickToolbar(world); // the tab is on Posts now, mid-scan
  await until(() => world.created.length === 2 && settledRecord(world, new URL(world.created[1].url).searchParams.get("profileBatchKey")), "the second scan");
  const secondKey = new URL(world.created[1].url).searchParams.get("profileBatchKey");
  assert.equal(settledRecord(world, secondKey).status, "done");
  assert.equal(world.tabs.get(7).url, REPLIES, "the newer scan put the tab back where the user had it");
  assert.equal(world.tabs.get(7).scrollY, 640);

  const touched = world.log.length;
  letFirstGo();
  await until(() => !world.store.has(firstKey), "the older scan to stop");
  await until(() => false === false && world.chunks.length >= 3, "never").catch(() => {});

  assert.equal(world.log.length, touched, "the older scan did not touch the tab again");
  assert.equal(world.store.has(firstKey), false, "and left no record behind");
  assert.equal(world.writes.filter(([key, status]) => key === firstKey && status !== "scanning").length, 0);
  assert.equal(world.tabs.get(7).url, REPLIES);
});

// --- I12: a heartbeat write never lands after the result ---------------------

test("a progress write still in flight when a pass ends cannot overwrite the result", async () => {
  const world = makeWorld({ tabUrl: POSTS, pages: { [plain(POSTS)]: ["p1"], [plain(MEDIA)]: ["m1"] } });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let heldOnce = false;
  world.setHook = async (key, record) => {
    // The first progress write made while a page is still loading comes from the
    // heartbeat (a pass's own first write comes before it navigates); it is held
    // up in storage.
    if (record.status === "scanning" && world.tabs.get(7).status === "loading" && !heldOnce) {
      heldOnce = true;
      await held;
    }
  };
  // A slow page keeps the Posts pass's navigation going past one heartbeat.
  const update = world.chrome.tabs.update;
  world.chrome.tabs.update = async (id, props) => {
    const tab = await update(id, props);
    world.tabs.get(id).status = "loading";
    setTimeout(() => (world.tabs.get(id).status = "complete"), 6000);
    return tab;
  };
  const get = world.chrome.tabs.get;
  world.chrome.tabs.get = async (id) => ({ ...(await get(id)), status: world.tabs.get(id).status });
  await load(world);

  await clickToolbar(world);
  await until(() => heldOnce, "a heartbeat write to be held");
  // The scan must wait for that write rather than race it.
  for (let i = 0; i < 400; i += 1) {
    mock.timers.tick(100);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(world.created.length === 1 && Boolean(settledRecord(world, batchKey(world))), false, "the result waits");

  release();
  await until(() => world.created.length === 1 && settledRecord(world, batchKey(world)), "the result");
  for (let i = 0; i < 50; i += 1) {
    mock.timers.tick(100);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(world.store.get(batchKey(world)).status, "done", "the last write is the result");
  const order = world.writes.filter(([key]) => key === batchKey(world)).map(([, status]) => status);
  assert.equal(order.at(-1), "done");
});
