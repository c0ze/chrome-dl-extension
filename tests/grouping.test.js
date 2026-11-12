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
      handle("zed", { group: "hard j" }),
      handle("amy", { group: "hard j", pending_count: 2 }),
      handle("loose"),
      handle("bob", { group: "Hard ch" }),
    ],
    "",
    "name"
  );
  assert.deepEqual(
    groups.map((group) => [group.group, group.handles.map((entry) => entry.handle), group.pending]),
    [
      ["Hard ch", ["bob"], 0],
      ["hard j", ["amy", "zed"], 1],
      ["", ["loose"], 0],
    ]
  );
  assert.equal(groupHandles([handle("amy", { group: "g" })], "nobody", "name").length, 0);
});

test("a creator with folders in two groups is listed in both", () => {
  const both = handle("amy", {
    group: "dildo j",
    folders: [{ group: "dildo j" }, { group: "hard j" }],
  });
  const groups = groupHandles([both, handle("zed", { group: "hard j" })], "", "name");
  assert.deepEqual(
    groups.map((group) => [group.group, group.handles.map((entry) => entry.handle)]),
    [
      ["dildo j", ["amy"]],
      ["hard j", ["amy", "zed"]],
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
  const entries = [handle("New_Name", { aliases: ["old_name"], base_dir: "/lib/hard j" })];
  // A profile batch: the host appends the handle's folder itself.
  assert.equal(folderForTarget(entries, "new_name", true).directory, "/lib/hard j");
  // A single post, reached through the former handle.
  assert.equal(folderForTarget(entries, "OLD_NAME", false).directory, "/lib/hard j/New_Name");
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
