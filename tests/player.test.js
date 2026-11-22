import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createPlayer, fileUrl } from "../extension/player.js";

const PATHS = ["/srv/archive/a.mp4", "/srv/archive/b.mp4", "/srv/archive/c.mp4"];

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// A fresh page with the overlay container; pause() and load() are the
// media methods jsdom does not implement, so they are counted no-ops.
function setup({ items = PATHS, index = 0, handlers = {}, playerName = "haruna" } = {}) {
  const dom = new JSDOM(`<!doctype html><div id="player" class="hidden"></div>`, {
    url: "http://localhost/",
  });
  const { window } = dom;
  const calls = { pause: 0, load: 0 };
  window.HTMLMediaElement.prototype.pause = () => { calls.pause += 1; };
  window.HTMLMediaElement.prototype.load = () => { calls.load += 1; };

  const root = window.document.getElementById("player");
  const player = createPlayer({ root, playerName });
  const list = items.map((path, i) => ({ path, title: "alice", favorite: i === 0 }));
  const allHandlers = {
    toggleFavorite: async (item) => !item.favorite,
    remove: async () => true,
    external: () => {},
    ...handlers,
  };
  player.open(list, index, allHandlers);

  const q = (selector) => root.querySelector(selector);
  return {
    window,
    root,
    player,
    list,
    calls,
    video: q("video"),
    header: () => q(".player-title").textContent,
    notice: () => q(".player-notice"),
    button: (action) => q(`[data-action="${action}"]`),
  };
}

test("fileUrl encodes each segment", () => {
  assert.equal(fileUrl("/srv/a b/#1 ?.mp4"), "file:///srv/a%20b/%231%20%3F.mp4");
  assert.equal(fileUrl("/srv/山田/x%.mp4"), "file:///srv/%E5%B1%B1%E7%94%B0/x%25.mp4");
});

test("the player starts muted on the chosen item", () => {
  const { video, header, root } = setup({ index: 1 });
  assert.equal(video.muted, true);
  assert.equal(video.controls, true);
  assert.equal(video.autoplay, true);
  assert.ok(video.src.endsWith("/srv/archive/b.mp4"), video.src);
  assert.ok(header().includes("2 of 3"), header());
  assert.ok(header().includes("@alice"), header());
  assert.equal(root.classList.contains("hidden"), false);
});

test("next and prev step through and stop at the ends", () => {
  const { button, header, video } = setup();
  assert.equal(button("prev").disabled, true);
  assert.equal(button("next").disabled, false);

  button("next").click();
  assert.ok(header().includes("2 of 3"), header());
  assert.ok(video.src.endsWith("/srv/archive/b.mp4"), video.src);
  assert.equal(button("prev").disabled, false);

  button("next").click();
  assert.ok(header().includes("3 of 3"), header());
  assert.equal(button("next").disabled, true);

  button("prev").click();
  assert.ok(header().includes("2 of 3"), header());
});

test("every step starts the next video muted again", () => {
  const { button, video } = setup();
  video.muted = false; // the viewer turned the sound on
  button("next").click();
  assert.equal(video.muted, true);
});

test("removing a middle video shows the next one; removing the last closes", async () => {
  const removed = [];
  const middle = setup({
    index: 1,
    handlers: { remove: async (item) => { removed.push(item.path); return true; } },
  });
  middle.button("remove").click();
  await tick();
  assert.deepEqual(removed, ["/srv/archive/b.mp4"]);
  assert.ok(middle.header().includes("2 of 2"), middle.header());
  assert.ok(middle.video.src.endsWith("/srv/archive/c.mp4"), middle.video.src);
  assert.equal(middle.root.classList.contains("hidden"), false);

  // At the end of the list the previous video is shown.
  middle.button("remove").click();
  await tick();
  assert.ok(middle.header().includes("1 of 1"), middle.header());
  assert.ok(middle.video.src.endsWith("/srv/archive/a.mp4"), middle.video.src);

  const last = setup({ items: [PATHS[0]] });
  last.button("remove").click();
  await tick();
  assert.equal(last.root.classList.contains("hidden"), true);
  assert.equal(last.video.hasAttribute("src"), false);
});

test("removing the last item of a longer list shows the one before it", async () => {
  const { button, header, video } = setup({ index: 2 });
  button("remove").click();
  await tick();
  assert.ok(header().includes("2 of 2"), header());
  assert.ok(video.src.endsWith("/srv/archive/b.mp4"), video.src);
});

test("a declined remove keeps the video", async () => {
  const { button, header, video, root } = setup({
    index: 1,
    handlers: { remove: async () => false },
  });
  button("remove").click();
  await tick();
  assert.ok(header().includes("2 of 3"), header());
  assert.ok(video.src.endsWith("/srv/archive/b.mp4"), video.src);
  assert.equal(root.classList.contains("hidden"), false);
  assert.equal(button("remove").disabled, false);
});

test("favorite reflects the handler's answer", async () => {
  let asked = null;
  const { button, list } = setup({
    index: 1,
    handlers: { toggleFavorite: async (item) => { asked = item; return true; } },
  });
  assert.ok(button("favorite").textContent.includes("☆"), button("favorite").textContent);
  button("favorite").click();
  await tick();
  assert.equal(asked, list[1]);
  assert.ok(button("favorite").textContent.includes("★"), button("favorite").textContent);
  assert.equal(button("favorite").classList.contains("active"), true);
  assert.equal(list[1].favorite, true);

  // The star is the item's own: stepping away and back keeps it.
  button("prev").click();
  assert.ok(button("favorite").textContent.includes("★"), "first item starts a favorite");
  button("next").click();
  assert.ok(button("favorite").textContent.includes("★"));
});

test("a favorite the handler turns off shows the empty star", async () => {
  const { button } = setup({ handlers: { toggleFavorite: async () => false } });
  assert.ok(button("favorite").textContent.includes("★"));
  button("favorite").click();
  await tick();
  assert.ok(button("favorite").textContent.includes("☆"));
  assert.equal(button("favorite").classList.contains("active"), false);
});

test("the external button carries the player's name and opens the current video", () => {
  let opened = null;
  const { button, list } = setup({
    index: 2,
    playerName: "mpv",
    handlers: { external: (item) => { opened = item; } },
  });
  assert.equal(button("external").textContent, "mpv");
  button("external").click();
  assert.equal(opened, list[2]);
});

test("closing pauses, unloads the video and hides the overlay", () => {
  const { button, video, root, calls, player } = setup();
  const pausesBefore = calls.pause;
  const loadsBefore = calls.load;
  button("close").click();
  assert.equal(calls.pause, pausesBefore + 1);
  assert.equal(calls.load, loadsBefore + 1);
  assert.equal(video.hasAttribute("src"), false);
  assert.equal(root.classList.contains("hidden"), true);

  // A second close is a no-op.
  player.close();
  assert.equal(calls.pause, pausesBefore + 1);
});

test("Escape closes the player and only while it is open", () => {
  const { window, root, player, list } = setup();
  const press = () => window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  press();
  assert.equal(root.classList.contains("hidden"), true);

  // Once closed, Escape does nothing; reopening works again.
  player.open(list, 0, { toggleFavorite: async () => true, remove: async () => true, external: () => {} });
  assert.equal(root.classList.contains("hidden"), false);
  press();
  assert.equal(root.classList.contains("hidden"), true);
});

test("other keys leave the player alone", () => {
  const { window, root } = setup();
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight" }));
  assert.equal(root.classList.contains("hidden"), false);
});

test("the closed handler runs once when the player closes", async () => {
  let closed = 0;
  const { button, window } = setup({
    items: [PATHS[0], PATHS[1]],
    handlers: { closed: () => { closed += 1; } },
  });
  button("close").click();
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(closed, 1);
});

test("a video that fails to load shows the error and keeps the buttons", () => {
  const { video, window, notice, button } = setup();
  assert.equal(notice().classList.contains("hidden"), true);
  video.dispatchEvent(new window.Event("error"));
  assert.equal(notice().classList.contains("hidden"), false);
  assert.equal(notice().textContent, "Could not play this file.");
  assert.equal(video.classList.contains("hidden"), true);
  assert.equal(button("external").hidden, false);

  // The next video clears the error.
  button("next").click();
  assert.equal(notice().classList.contains("hidden"), true);
  assert.equal(video.classList.contains("hidden"), false);
});

test("an error after closing is ignored", () => {
  const { video, window, notice, button } = setup();
  button("close").click();
  video.dispatchEvent(new window.Event("error"));
  assert.equal(notice().classList.contains("hidden"), true);
});

test("without file access the overlay explains how to turn it on", async () => {
  globalThis.chrome = { extension: { isAllowedFileSchemeAccess: async () => false } };
  try {
    const { video, notice, button, header } = setup();
    await tick();
    assert.equal(
      notice().textContent,
      "Turn on “Allow access to file URLs” for this extension in chrome://extensions."
    );
    assert.equal(notice().classList.contains("hidden"), false);
    assert.equal(video.hasAttribute("src"), false);
    assert.equal(button("external").disabled, false);
    assert.ok(header().includes("1 of 3"), header());
  } finally {
    delete globalThis.chrome;
  }
});

test("with file access the video loads once the check has answered", async () => {
  let asked = 0;
  globalThis.chrome = {
    extension: { isAllowedFileSchemeAccess: async () => { asked += 1; return true; } },
  };
  try {
    const { video, button, player, list } = setup();
    await tick();
    assert.ok(video.src.endsWith("/srv/archive/a.mp4"), video.src);
    assert.equal(video.muted, true);

    // The answer is kept for the next open, which loads at once.
    button("close").click();
    player.open(list, 1, { toggleFavorite: async () => true, remove: async () => true, external: () => {} });
    assert.ok(video.src.endsWith("/srv/archive/b.mp4"), video.src);
    assert.equal(asked, 1);
  } finally {
    delete globalThis.chrome;
  }
});
