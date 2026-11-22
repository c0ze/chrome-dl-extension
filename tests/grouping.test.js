import test from "node:test";
import assert from "node:assert/strict";
import {
  formatChecked,
  groupJobsByHandle,
  groupSummary,
  jobHandle,
} from "../extension/grouping.js";

const job = (handle, status, extra = {}) => ({
  url: `https://x.com/${handle}/status/1`,
  status,
  ...extra,
});

test("a download is filed under the handle the host recorded", () => {
  // Facebook reels and x.com/i/status links carry no handle in their URL.
  assert.equal(jobHandle({ handle: "alice", url: "https://x.com/i/status/1" }), "alice");
});

test("older downloads without a recorded handle fall back to the post URL", () => {
  assert.equal(jobHandle({ url: "https://twitter.com/Bob/status/42" }), "Bob");
});

test("a download with no owner is not filed under a route name", () => {
  assert.equal(jobHandle({ url: "https://x.com/i/status/42" }), "");
  assert.equal(jobHandle({ url: "https://www.facebook.com/reel/1" }), "");
  assert.equal(jobHandle({ url: "nonsense" }), "");
});

test("one handle spelled two ways is one group", () => {
  const groups = groupJobsByHandle([job("Alice", "complete"), job("alice", "complete")]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].jobs.length, 2);
  assert.equal(groups[0].handle, "Alice");
});

test("the group that is downloading now is listed first, then queued ones", () => {
  const groups = groupJobsByHandle([
    job("done", "complete"),
    job("waiting", "queued"),
    job("active", "running"),
    job("older", "failed"),
  ]);
  assert.deepEqual(
    groups.map((group) => group.handle),
    ["active", "waiting", "done", "older"]
  );
});

test("a group's summary counts every download in it", () => {
  const [group] = groupJobsByHandle([
    job("a", "running"),
    job("a", "queued"),
    job("a", "complete"),
    job("a", "complete"),
    job("a", "failed"),
    job("a", "cancelled"),
  ]);
  assert.equal(groupSummary(group), "1 running, 1 queued, 2 done, 1 failed, 1 cancelled");
});

test("the last check is shown as an age", () => {
  const now = new Date("2026-11-12T12:00:00").getTime();
  assert.equal(formatChecked(null, now), "never checked");
  assert.equal(formatChecked("2026-11-12 11:59:50", now), "checked just now");
  assert.equal(formatChecked("2026-11-12 11:30:00", now), "checked 30 min ago");
  assert.equal(formatChecked("2026-11-12 03:00:00", now), "checked 9 h ago");
  assert.equal(formatChecked("2026-11-02 12:00:00", now), "checked 10 days ago");
});

import { folderForTarget, groupHandles, handleMatches, sortHandles } from "../extension/grouping.js";

const handle = (name, extra = {}) => ({
  handle: name,
  name,
  group: "",
  base_dir: "/lib",
  aliases: [],
  pending_count: 0,
  video_count: 0,
  last_checked: null,
  ...extra,
});

test("a search finds a creator by a former handle", () => {
  const entry = handle("new_name", { aliases: ["old_name"] });
  assert.equal(handleMatches(entry, "@OLD"), true);
  assert.equal(handleMatches(entry, "new"), true);
  assert.equal(handleMatches(entry, "other"), false);
  assert.equal(handleMatches(entry, "  "), true);
});

test("handles are listed under their group, ungrouped last, empty groups hidden", () => {
  const groups = groupHandles(
    [
      handle("zed", { group: "group d" }),
      handle("amy", { group: "group d", pending_count: 2 }),
      handle("loose"),
      handle("bob", { group: "Group c" }),
    ],
    "",
    "name"
  );
  assert.deepEqual(
    groups.map((group) => [group.group, group.handles.map((entry) => entry.handle), group.pending]),
    [
      ["Group c", ["bob"], 0],
      ["group d", ["amy", "zed"], 1],
      ["", ["loose"], 0],
    ]
  );
  assert.equal(groupHandles([handle("amy", { group: "g" })], "nobody", "name").length, 0);
});

test("a creator with folders in two groups is listed in both", () => {
  const both = handle("amy", {
    group: "group a",
    folders: [{ group: "group a" }, { group: "group d" }],
  });
  const groups = groupHandles([both, handle("zed", { group: "group d" })], "", "name");
  assert.deepEqual(
    groups.map((group) => [group.group, group.handles.map((entry) => entry.handle)]),
    [
      ["group a", ["amy"]],
      ["group d", ["amy", "zed"]],
    ]
  );
});

test("sorting by last check puts never-checked handles first", () => {
  const sorted = sortHandles(
    [
      handle("recent", { last_checked: "2026-11-12 10:00:00" }),
      handle("never"),
      handle("old", { last_checked: "2026-10-01 10:00:00" }),
    ],
    "checked"
  );
  assert.deepEqual(
    sorted.map((entry) => entry.handle),
    ["never", "old", "recent"]
  );
});

test("sorting by new videos and by library size", () => {
  const entries = [
    handle("a", { pending_count: 1, video_count: 5 }),
    handle("b", { pending_count: 4, video_count: 50 }),
    handle("c", { pending_count: 0, video_count: 9 }),
  ];
  assert.deepEqual(sortHandles(entries, "new").map((entry) => entry.handle), ["b", "a", "c"]);
  assert.deepEqual(sortHandles(entries, "videos").map((entry) => entry.handle), ["b", "c", "a"]);
});

test("a known handle's download is steered to the folder it already has", () => {
  const entries = [handle("New_Name", { aliases: ["old_name"], base_dir: "/lib/group d" })];
  // A profile batch: the host appends the handle's folder itself.
  assert.equal(folderForTarget(entries, "new_name", true).directory, "/lib/group d");
  // A single post, reached through the former handle.
  assert.equal(folderForTarget(entries, "OLD_NAME", false).directory, "/lib/group d/New_Name");
  assert.equal(folderForTarget(entries, "stranger", false), null);
  assert.equal(folderForTarget(entries, "", false), null);
});

import { formatBytes, formatDuration, scanSummary } from "../extension/grouping.js";

test("sizes and lengths read naturally", () => {
  assert.equal(formatBytes(900), "1 KB");
  assert.equal(formatBytes(0), "0 KB");
  assert.equal(formatBytes(5 * 1024 ** 2), "5.0 MB");
  assert.equal(formatBytes(3.25 * 1024 ** 3), "3.3 GB");
  assert.equal(formatDuration(75.4), "1:15");
  assert.equal(formatDuration(null), "0:00");
});

test("the scan line says what is happening or what the last scan found", () => {
  assert.equal(scanSummary({ state: "never" }), "The library has not been scanned yet.");
  assert.equal(
    scanSummary({ state: "running", stage: "Reading videos", done: 20, total: 300 }),
    "Reading videos 20 of 300…"
  );
  assert.equal(scanSummary({ state: "failed", error: "The share went away." }), "The share went away.");
  assert.equal(
    scanSummary({
      state: "done",
      finished_at: "2026-11-12 18:00:00",
      scanned: 100,
      broken_count: 2,
      group_count: 5,
      duplicate_bytes: 2 * 1024 ** 3,
    }),
    "100 videos scanned on 2026-11-12 18:00:00. Broken: 2. Duplicate sets: 5, taking 2.0 GB extra."
  );
});

import { autoStartReady, downloadPlan, groupDirectory, shortPath } from "../extension/grouping.js";

const R = "/srv/archive/media/twitter";
const alice = { handle: "alice", aliases: ["oldalice"], folders: [{ base_dir: `${R}/group a`, name: "alice", group: "group a" }] };
const bob = { handle: "bob", aliases: [], folders: [
  { base_dir: `${R}/group a`, name: "bob", group: "group a" }, { base_dir: `${R}/group b`, name: "Bob B", group: "group b" }] };
test("a known creator with one folder starts there", () => {
  assert.deepEqual(downloadPlan([alice], "Alice", false), { auto: { directory: `${R}/group a/alice`, group: "group a", handle: "alice" }, groups: ["group a"] });
  assert.equal(downloadPlan([alice], "alice", true).auto.directory, `${R}/group a`);
});
test("a former handle starts in the current folder", () => {
  assert.equal(downloadPlan([alice], "OldAlice", false).auto.directory, `${R}/group a/alice`);
});
test("a creator in two groups waits for a choice", () => {
  assert.deepEqual(downloadPlan([bob], "bob", false), { auto: null, groups: ["group a", "group b"] });
});
test("someone new has no plan", () => {
  assert.deepEqual(downloadPlan([alice], "carol", false), { auto: null, groups: [] });
  assert.deepEqual(downloadPlan([alice], "", false), { auto: null, groups: [] });
});
test("a group button files a post in the handle's folder for that group", () => {
  assert.equal(groupDirectory(R, "group b", "bob", [bob], false), `${R}/group b/Bob B`);
  assert.equal(groupDirectory(R, "group c", "carol", [bob], false), `${R}/group c/carol`);
  assert.equal(groupDirectory(R, "group c", "carol", [], true), `${R}/group c`);
  assert.equal(groupDirectory(R, "group c", "", [], false), `${R}/group c`);
});
test("a group outside the library root is an absolute folder and is used as-is", () => {
  const outside = { handle: "dave", aliases: [], folders: [{ base_dir: "/elsewhere/clips", name: "Dave D", group: "/elsewhere/clips" }] };
  assert.equal(groupDirectory(R, "/elsewhere/clips", "", [], true), "/elsewhere/clips");
  assert.equal(groupDirectory(R, "/elsewhere/clips", "dave", [outside], false), "/elsewhere/clips/Dave D");
  assert.equal(groupDirectory(R, "/elsewhere/clips/", "erin", [], false), "/elsewhere/clips/erin");
  assert.equal(groupDirectory(R, "/elsewhere/clips", "", [], false), "/elsewhere/clips");
});
test("two folders in one group still wait for a choice, one entry per folder", () => {
  const twins = { handle: "frank", aliases: [], folders: [
    { base_dir: `${R}/group a`, name: "frank", group: "group a" }, { base_dir: `${R}/group a`, name: "frank 2", group: "group a" }] };
  assert.deepEqual(downloadPlan([twins], "frank", false), { auto: null, groups: ["group a", "group a"] });
});
test("paths are shown from the library root's parent", () => {
  assert.equal(shortPath(`${R}/group a/alice`, R), "media/twitter/group a/alice");
  assert.equal(shortPath(`${R}/`, R), "media/twitter");
  assert.equal(shortPath("/home/u/Downloads", R, "/home/u"), "~/Downloads");
  assert.equal(shortPath("/other/place", R, "/home/u"), "/other/place");
});
test("auto-start waits for a profile scan to find videos", () => {
  const base = { auto: { directory: "d" }, isProfile: true, scanStatus: "scanning", urlCount: 0, folderEdited: false, started: false };
  assert.equal(autoStartReady(base), false);
  assert.equal(autoStartReady({ ...base, scanStatus: "done", urlCount: 3 }), true);
  assert.equal(autoStartReady({ ...base, scanStatus: "done", urlCount: 0 }), false);
  assert.equal(autoStartReady({ ...base, isProfile: false }), true);
  assert.equal(autoStartReady({ ...base, isProfile: false, folderEdited: true }), false);
  assert.equal(autoStartReady({ ...base, isProfile: false, started: true }), false);
});
