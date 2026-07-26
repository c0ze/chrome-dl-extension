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

test("batchTargetForUrl matches both Facebook reels URL forms", () => {
  assert.deepEqual(
    batchTargetForUrl("https://www.facebook.com/profile.php?id=61590939736806&sk=reels_tab"),
    { provider: "facebook", key: "61590939736806" }
  );
  assert.deepEqual(batchTargetForUrl("https://www.facebook.com/somepage/reels"), {
    provider: "facebook",
    key: "somepage",
  });
  assert.equal(batchTargetForUrl("https://www.facebook.com/somepage/videos"), null);
});

test("Facebook scan collects grid reels and excludes suggestions", async () => {
  withPage(
    `<html><head>
       <meta property="og:title" content="ネコ動画">
     </head><body>
       <div role="main">
         <a href="/reel/1001">a</a>
         <a href="/reel/1002/">b</a>
         <a href="/somepage/posts/5">not a reel</a>
         <section>
           <h2>Reels for you</h2>
           <a href="/reel/8001">suggested</a>
         </section>
       </div>
       <div role="complementary">
         <a href="/reel/9001">sidebar</a>
       </div>
     </body></html>`,
    "https://www.facebook.com/somepage/reels"
  );

  const result = await profileScanChunk({
    provider: "facebook",
    hosts: ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"],
    expectedUsername: "somepage",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });

  assert.deepEqual((result.urls || []).sort(), [
    "https://www.facebook.com/reel/1001",
    "https://www.facebook.com/reel/1002",
  ]);
  assert.equal(result.profileName, "ネコ動画");
});

test("Facebook display name falls back through og:title, h1, then title", async () => {
  withPage(
    `<html><head><title>(12+) Some Creator | Facebook</title></head>
     <body><div role="main"><a href="/reel/1">x</a></div></body></html>`,
    "https://www.facebook.com/somepage/reels"
  );
  const result = await profileScanChunk({
    provider: "facebook",
    hosts: ["www.facebook.com"],
    expectedUsername: "somepage",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });
  assert.equal(result.profileName, "Some Creator");
});
