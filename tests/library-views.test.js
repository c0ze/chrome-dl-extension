import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { initLibraryViews } from "../extension/library-views.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await tick();
};

const FAVORITES = () => [
  { path: "/srv/archive/group a/alice/1.mp4", relative: "group a/alice/1.mp4", name: "1.mp4", handle: "alice",
    exists: true, added: "2026-01-01 10:00:00", thumb: "k1" },
  { path: "/srv/archive/group a/bob/2.mp4", relative: "group a/bob/2.mp4", name: "2.mp4", handle: "bob",
    exists: false, added: "2026-01-02 10:00:00", thumb: "k2" },
  { path: "/srv/archive/group a/bob/3.mp4", relative: "group a/bob/3.mp4", name: "3.mp4", handle: "bob",
    exists: true, added: "2026-01-03 10:00:00", thumb: "k3" },
];

// The favorites view over a fake host and a fake player that records how it
// was opened. `fail` maps a host message type to the error it answers with.
async function setup({ confirm = true, fail = {}, hold = {}, favorites = {} } = {}) {
  const dom = new JSDOM(
    `<!doctype html><p id="label"></p><p id="summary"></p><div id="controls"></div>
     <div id="list"></div><div id="view" class="hidden"></div><button id="removed"></button>`,
    { url: "http://localhost/" }
  );
  global.window = dom.window;
  global.document = dom.window.document;
  dom.window.confirm = () => confirm;
  const $ = (id) => dom.window.document.getElementById(id);

  const host = [];
  const messages = [];
  const opened = [];
  let changed = 0;
  let playersClosed = 0;
  const callHost = async (payload) => {
    host.push(payload);
    if (fail[payload.type]) return { ok: false, error: fail[payload.type] };
    if (payload.type === "get_favorites") {
      // `hold[group]` keeps that group's answer back until the promise settles.
      if (hold[payload.group]) await hold[payload.group];
      return { ok: true, items: favorites[payload.group] || FAVORITES() };
    }
    if (payload.type === "get_favorite_thumbnails") return { ok: true, thumbs: {} };
    if (payload.type === "set_favorite") return { ok: true, favorite: payload.favorite };
    return { ok: true, removed: 1 };
  };
  const views = initLibraryViews({
    callHost,
    showMessage: (kind, text) => messages.push([kind, text]),
    elements: {
      libraryView: $("view"),
      downloadList: $("list"),
      downloadControls: $("controls"),
      dashboardSummary: $("summary"),
      dashboardLabel: $("label"),
      removedButton: $("removed"),
    },
    onChanged: () => { changed += 1; },
    getPlayer: () => ({ open: (items, index, handlers) => opened.push({ items, index, handlers }) }),
    getPlayerName: () => "Haruna",
    closePlayer: () => { playersClosed += 1; host.push({ type: "closePlayer" }); },
  });
  views.showFavorites("group a");
  await settle();

  const view = $("view");
  const tiles = () => [...view.querySelectorAll(".download-tile")];
  const button = (tile, label) => [...tile.querySelectorAll("button")].find((b) => b.textContent === label);
  const count = (type) => host.filter((payload) => payload.type === type).length;
  return { view, views, tiles, button, host, messages, opened, count, changed: () => changed, settle, playersClosed: () => playersClosed };
}

test("Play on a favorite opens the player over the favorites whose file is there", async () => {
  const page = await setup();
  const [first, , third] = page.tiles();
  page.button(third, "Play").click();
  assert.equal(page.opened.length, 1);
  const { items, index } = page.opened[0];
  assert.deepEqual(items.map((item) => [item.path, item.title, item.favorite]), [
    ["/srv/archive/group a/alice/1.mp4", "alice", true],
    ["/srv/archive/group a/bob/3.mp4", "bob", true],
  ]);
  assert.equal(index, 1);
  page.button(first, "Play").click();
  assert.equal(page.opened[1].index, 0);
});

test("clicking a favorite's picture opens the player; a missing file has nothing to open", async () => {
  const page = await setup();
  const [first, missing] = page.tiles();
  first.querySelector(".tile-picture").click();
  assert.equal(page.opened.length, 1);
  assert.equal(page.opened[0].index, 0);
  missing.querySelector(".tile-picture").click();
  assert.equal(page.opened.length, 1);
});

test("the external player's button is named after the player and plays the file there", async () => {
  const page = await setup();
  const [first] = page.tiles();
  page.button(first, "Haruna").click();
  await page.settle();
  assert.equal(page.opened.length, 0);
  assert.deepEqual(page.host.filter((p) => p.type === "play_library_file"), [
    { type: "play_library_file", path: "group a/alice/1.mp4" },
  ]);
});

test("the player's own external button plays the file there too", async () => {
  const page = await setup();
  page.button(page.tiles()[2], "Play").click();
  const { items, handlers } = page.opened[0];
  handlers.external(items[1]);
  await page.settle();
  assert.deepEqual(page.host.filter((p) => p.type === "play_library_file"), [
    { type: "play_library_file", path: "group a/bob/3.mp4" },
  ]);
});

test("the player's Favorite unfavorites a favorite and favorites it again", async () => {
  const page = await setup();
  page.button(page.tiles()[0], "Play").click();
  const { items, handlers } = page.opened[0];
  assert.equal(await handlers.toggleFavorite(items[0]), false);
  items[0].favorite = false; // the player keeps this up to date
  assert.equal(await handlers.toggleFavorite(items[0]), true);
  assert.deepEqual(page.host.filter((p) => p.type === "set_favorite").map((p) => [p.relative, p.favorite]), [
    ["group a/alice/1.mp4", false],
    ["group a/alice/1.mp4", true],
  ]);
  assert.equal(page.changed(), 2);
});

test("a favorite the host could not change is reported by the player, not the page", async () => {
  const page = await setup({ fail: { set_favorite: "The video file is not there any more." } });
  page.button(page.tiles()[0], "Play").click();
  const { items, handlers } = page.opened[0];
  await assert.rejects(handlers.toggleFavorite(items[0]), /not there any more/);
  assert.deepEqual(page.messages, []);
});

test("the player's Remove deletes the file once confirmed", async () => {
  const page = await setup();
  page.button(page.tiles()[0], "Play").click();
  const { items, handlers } = page.opened[0];
  assert.equal(await handlers.remove(items[0]), true);
  assert.deepEqual(page.host.filter((p) => p.type === "remove_library_files"), [
    { type: "remove_library_files", paths: ["group a/alice/1.mp4"], reason: "removed" },
  ]);
  assert.deepEqual(page.messages, [["success", "Deleted 1.mp4."]]);
  assert.equal(page.changed(), 1);
});

test("declining the confirmation keeps the file and is not a failure", async () => {
  const page = await setup({ confirm: false });
  page.button(page.tiles()[0], "Play").click();
  const { items, handlers } = page.opened[0];
  assert.equal(await handlers.remove(items[0]), false);
  assert.equal(page.count("remove_library_files"), 0);
  assert.deepEqual(page.messages, []);
});

test("a Remove the host refused is reported by the player, not the page", async () => {
  const page = await setup({ fail: { remove_library_files: "A library scan is running." } });
  page.button(page.tiles()[0], "Play").click();
  const { items, handlers } = page.opened[0];
  await assert.rejects(handlers.remove(items[0]), /library scan is running/);
  assert.deepEqual(page.messages, []);
});

test("the view reloads when the player closes", async () => {
  const page = await setup();
  page.button(page.tiles()[0], "Play").click();
  assert.equal(page.count("get_favorites"), 1);
  page.opened[0].handlers.closed();
  await page.settle();
  assert.equal(page.count("get_favorites"), 2);
});

test("a player that closes after the view was left reloads nothing", async () => {
  const page = await setup();
  page.button(page.tiles()[0], "Play").click();
  [...page.view.querySelectorAll("button")].find((b) => b.textContent === "← Downloads").click();
  page.opened[0].handlers.closed();
  await page.settle();
  assert.equal(page.count("get_favorites"), 1);
  assert.deepEqual(page.messages, []);
});

test("the star on a tile still unfavorites on the page and reports a failure there", async () => {
  const page = await setup({ fail: { set_favorite: "Could not change the favorite." } });
  page.button(page.tiles()[0], "★").click();
  await page.settle();
  assert.deepEqual(page.messages, [["error", "Could not change the favorite."]]);
  assert.equal(page.count("get_favorites"), 2);
});

test("Remove on a tile still deletes on the page and reports a failure there", async () => {
  const page = await setup({ fail: { remove_library_files: "Could not remove the video." } });
  page.button(page.tiles()[0], "Remove").click();
  await page.settle();
  assert.deepEqual(page.messages, [["error", "Could not remove the video."]]);
  assert.equal(page.count("get_favorites"), 2);
});

const OTHER = [
  { path: "/srv/archive/group b/carol/9.mp4", relative: "group b/carol/9.mp4", name: "9.mp4", handle: "carol",
    exists: true, added: "2026-01-04 10:00:00", thumb: "k9" },
];

test("an answer for a view that was left cannot replace the one on screen", async () => {
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  // Group a's answer is held; group b is opened and answers first.
  const page = await setup({ hold: { "group a": slow }, favorites: { "group b": OTHER } });
  page.views.showFavorites("group b");
  await page.settle();
  assert.deepEqual(page.tiles().map((tile) => tile.querySelector(".download-title").textContent), ["9.mp4"]);

  release();
  await page.settle();

  assert.deepEqual(
    page.tiles().map((tile) => tile.querySelector(".download-title").textContent),
    ["9.mp4"],
    "group a's late answer did not take over"
  );
  page.button(page.tiles()[0], "Play").click();
  assert.equal(page.opened.length, 1, "Play finds the tile that is shown");
  assert.equal(page.opened[0].items[0].path, "/srv/archive/group b/carol/9.mp4");
});

test("a failed answer for a view that was left shows no message", async () => {
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  const page = await setup({ hold: { "group a": slow }, favorites: { "group b": OTHER } });
  page.views.showFavorites("group b");
  await page.settle();
  page.host.length = 0;
  release();
  await page.settle();
  assert.deepEqual(page.messages, []);
});

test("opening a favorites view closes an open player first", async () => {
  const page = await setup();
  assert.equal(page.playersClosed(), 1, "the first view closed any player too");
  const before = page.host.length;

  page.views.showFavorites("group b");

  assert.equal(page.playersClosed(), 2);
  assert.deepEqual(
    page.host.slice(before).map((message) => message.type),
    ["closePlayer", "get_favorites"],
    "closed before the new view asked the host for anything"
  );
});

test("a favorite outside the library only plays: no Favorite, Remove, Folder or external player", async () => {
  const outside = {
    path: "/elsewhere/clips/c.mp4", relative: "", name: "c.mp4", handle: "clips",
    exists: true, added: "2026-01-05 10:00:00", thumb: "k5",
  };
  const page = await setup({ favorites: { "group a": [outside, ...FAVORITES().slice(0, 1)] } });
  const [loose, inside] = page.tiles();

  assert.deepEqual([...loose.querySelectorAll("button")].map((b) => b.textContent), ["Play"]);
  assert.match(loose.textContent, /Manage this video in its own folder\./);
  assert.ok([...inside.querySelectorAll("button")].map((b) => b.textContent).includes("Remove"));
  assert.equal(inside.textContent.includes("Manage this video"), false);

  page.button(loose, "Play").click();
  assert.equal(page.opened[0].items[0].managed, false);
  assert.equal(page.opened[0].items[1].managed, true);
});
