import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { batchTargetForUrl, profileScanChunk } from "../extension/providers.js";

function withPage(html, url) {
  const dom = new JSDOM(html, { url });
  global.window = dom.window;
  global.document = dom.window.document;
  global.URL = dom.window.URL;
  return dom;
}

test("batchTargetForUrl matches a Twitter profile media URL", () => {
  assert.deepEqual(batchTargetForUrl("https://x.com/alice/media"), {
    provider: "twitter",
    key: "alice",
  });
});

test("batchTargetForUrl rejects reserved Twitter routes", () => {
  assert.equal(batchTargetForUrl("https://x.com/home/media"), null);
});

test("Twitter scan collects only video-backed posts owned by the profile", async () => {
  withPage(
    `<div role="main">
       <article>
         <video></video>
         <a href="/alice/status/1001"><time></time></a>
       </article>
       <article>
         <a href="/alice/status/1002"><time></time></a>
         <div>12.3K views</div>
       </article>
       <article>
         <video></video>
         <a href="/alice/status/1003"><time></time></a>
         <div role="link"><a href="/bob/status/9001"><time></time></a></div>
       </article>
     </div>`,
    "https://x.com/alice/media"
  );

  const result = await profileScanChunk({
    provider: "twitter",
    hosts: ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"],
    reserved: ["home", "explore", "notifications", "messages", "i", "settings"],
    expectedUsername: "alice",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });

  const urls = (result.progress?.urls || []).sort();
  assert.deepEqual(urls, [
    "https://x.com/alice/status/1001",
    "https://x.com/alice/status/1003",
  ]);
  assert.ok(!urls.some((u) => u.includes("bob")), "quoted post must not leak");
  assert.ok(!urls.some((u) => u.includes("1002")), "views text is not video evidence");
});
