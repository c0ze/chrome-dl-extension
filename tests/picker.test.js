import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { autoStartNotice, pickerTarget, renderGroupButtons } from "../extension/picker.js";

function setup() {
  const dom = new JSDOM(`<!doctype html><div id="group-buttons" class="panel hidden"></div>`);
  const container = dom.window.document.getElementById("group-buttons");
  const picked = [];
  const render = (options) => renderGroupButtons(container, { onPick: (group) => picked.push(group), ...options });
  const buttons = () => [...container.querySelectorAll("button")];
  return { container, picked, render, buttons };
}

test("one button per group, in the order given; a click names the group", () => {
  const { container, picked, render, buttons } = setup();
  render({ groups: ["group b", "group a", "group c"], highlight: [] });
  assert.equal(container.classList.contains("hidden"), false);
  assert.deepEqual(buttons().map((button) => button.textContent), ["group b", "group a", "group c"]);
  assert.ok(buttons().every((button) => button.type === "button"));
  buttons()[1].click();
  assert.deepEqual(picked, ["group a"]);
});

test("no groups: nothing is drawn and the panel stays hidden", () => {
  const { container, render, buttons } = setup();
  render({ groups: [], highlight: ["group a"] });
  assert.equal(container.classList.contains("hidden"), true);
  assert.equal(container.children.length, 0);
  assert.equal(buttons().length, 0);
});

test("a group with an empty name never gets a button, and each group gets one", () => {
  const { render, buttons } = setup();
  render({ groups: ["", "group a", "   ", "group a", null, "group b"], highlight: [] });
  assert.deepEqual(buttons().map((button) => button.textContent), ["group a", "group b"]);
});

test("only groups that are all empty keep the panel hidden", () => {
  const { container, render, buttons } = setup();
  render({ groups: ["", " "], highlight: [""] });
  assert.equal(container.classList.contains("hidden"), true);
  assert.equal(buttons().length, 0);
});

test("the creator's groups are highlighted, once each", () => {
  const { render, buttons } = setup();
  // The plan keeps one entry per folder, so a group can repeat, and an
  // ungrouped folder is "": neither may highlight anything extra.
  render({ groups: ["group a", "group b", "group c"], highlight: ["group a", "", "group c", "group a"] });
  assert.deepEqual(
    buttons().map((button) => [button.textContent, button.classList.contains("highlighted")]),
    [["group a", true], ["group b", false], ["group c", true]]
  );
});

test("a highlight for a group that has no button adds none", () => {
  const { render, buttons } = setup();
  render({ groups: ["group a"], highlight: ["group z"] });
  assert.deepEqual(buttons().map((button) => button.textContent), ["group a"]);
  assert.equal(buttons()[0].classList.contains("highlighted"), false);
});

test("drawing again replaces the buttons, and shows or hides the panel as groups come and go", () => {
  const { container, picked, render, buttons } = setup();
  render({ groups: ["group a"], highlight: [] });
  render({ groups: ["group b", "group c"], highlight: ["group c"] });
  assert.deepEqual(buttons().map((button) => button.textContent), ["group b", "group c"]);
  buttons()[0].click();
  assert.deepEqual(picked, ["group b"], "the old button's handler is gone");
  render({ groups: [], highlight: [] });
  assert.equal(container.classList.contains("hidden"), true);
  assert.equal(container.children.length, 0);
  render({ groups: ["group a"], highlight: [] });
  assert.equal(container.classList.contains("hidden"), false);
});

test("a button's tooltip says where it files, and which groups hold the creator", () => {
  const { render, buttons } = setup();
  render({ groups: ["group a", "group b"], highlight: ["group b"] });
  assert.equal(buttons()[0].title, "Download into group a");
  assert.match(buttons()[1].title, /group b/);
  assert.match(buttons()[1].title, /already/i);
});

test("X and Twitter profiles are profile targets with the handle as written", () => {
  assert.deepEqual(pickerTarget("https://x.com/Alice/media"), { twitter: true, handle: "Alice", isProfile: true });
  assert.deepEqual(pickerTarget("https://twitter.com/alice"), { twitter: true, handle: "alice", isProfile: true });
});

test("a post is a Twitter target with its author, and not a profile", () => {
  assert.deepEqual(pickerTarget("https://x.com/alice/status/1001"), { twitter: true, handle: "alice", isProfile: false });
  assert.deepEqual(pickerTarget("https://www.x.com/bob/status/1002?s=20"), { twitter: true, handle: "bob", isProfile: false });
});

test("a post link with no author is still a Twitter post, without a handle", () => {
  assert.deepEqual(pickerTarget("https://x.com/i/status/1001"), { twitter: true, handle: "", isProfile: false });
  assert.deepEqual(pickerTarget("https://x.com/i/web/status/1001"), { twitter: true, handle: "", isProfile: false });
  assert.deepEqual(pickerTarget("https://twitter.com/i/statuses/1001"), { twitter: true, handle: "", isProfile: false });
});

test("a post's own sub-pages are the post", () => {
  assert.deepEqual(pickerTarget("https://x.com/alice/status/1001/video/1"), { twitter: true, handle: "alice", isProfile: false });
  assert.deepEqual(pickerTarget("https://x.com/alice/status/1001/photo/1").twitter, true);
});

test("other X pages are neither a post nor a profile, so they get no group buttons", () => {
  for (const url of [
    "https://x.com/home",
    "https://x.com/explore",
    "https://x.com/search?q=cats",
    "https://x.com/notifications",
    "https://x.com/i/bookmarks",
    "https://x.com/i/lists/1001",
    "https://x.com/alice/followers",
    "https://x.com/alice/status",
    "https://x.com/alice/status/abc",
    "https://x.com/",
  ]) {
    assert.deepEqual(pickerTarget(url), { twitter: false, handle: "", isProfile: false }, url);
  }
});

test("Facebook and other sites are not Twitter targets", () => {
  assert.equal(pickerTarget("https://www.facebook.com/somepage/reels").twitter, false);
  assert.equal(pickerTarget("https://www.facebook.com/somepage/reels").handle, "");
  assert.equal(pickerTarget("https://www.facebook.com/reel/123").twitter, false);
  assert.equal(pickerTarget("https://example.com/alice/status/1001").twitter, false);
  assert.equal(pickerTarget("https://example.com/alice/status/1001").handle, "");
  assert.equal(pickerTarget("").twitter, false);
  assert.equal(pickerTarget("not a url").twitter, false);
});

test("the auto-start message names the group and the creator", () => {
  assert.equal(autoStartNotice({ group: "group a", handle: "alice" }), "Downloading into group a / alice");
  assert.equal(autoStartNotice({ group: "", handle: "alice" }), "Downloading into alice");
});
