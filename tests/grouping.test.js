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
