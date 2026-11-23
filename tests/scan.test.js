import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  RESERVED_PROFILE_USERNAMES,
  batchTargetForUrl,
  profileScanChunk,
  facebookPeopleUrlName,
  mergeScanPasses,
  twitterMediaUrl,
} from "../extension/providers.js";

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

test("every profile tab is the same batch target", () => {
  for (const path of ["alice", "alice/", "alice/media", "alice/Media/?s=20", "alice/with_replies",
                      "alice/highlights", "alice/articles", "alice/likes"]) {
    assert.deepEqual(batchTargetForUrl(`https://x.com/${path}`), { provider: "twitter", key: "alice" }, path);
  }
});

test("a post, an unknown tab or a reserved route is not a profile", () => {
  for (const path of ["alice/status/1001", "alice/followers", "search", "compose/post", "home/media", "i/lists",
                      "/alice", "alice//likes"]) {
    assert.equal(batchTargetForUrl(`https://x.com/${path}`), null, path);
  }
});

test("the host reserves the same Twitter routes as the extension", () => {
  const source = readFileSync(new URL("../native-host/yt_dlp_host.py", import.meta.url), "utf8");
  const hostSet = source.match(/TWITTER_RESERVED_USERNAMES = \{([^}]*)\}/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  assert.deepEqual([...hostSet].sort(), [...RESERVED_PROFILE_USERNAMES].sort());
});

test("twitterMediaUrl is the profile's media page", () => {
  assert.equal(twitterMediaUrl("alice"), "https://x.com/alice/media");
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
    batchTargetForUrl("https://www.facebook.com/profile.php?id=100000000000001&sk=reels_tab"),
    { provider: "facebook", key: "100000000000001" }
  );
  assert.deepEqual(batchTargetForUrl("https://www.facebook.com/somepage/reels"), {
    provider: "facebook",
    key: "somepage",
  });
  assert.equal(batchTargetForUrl("https://www.facebook.com/somepage/videos"), null);
});

// --- /people/<name>/<digits> profile reels URL form ---

test("batchTargetForUrl matches the /people/<name>/<digits> reels URL form, keyed on the numeric id", () => {
  assert.deepEqual(
    batchTargetForUrl(
      "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/100000000000001/?sk=reels_tab"
    ),
    { provider: "facebook", key: "100000000000001" }
  );
});

test("the same profile via profile.php?id=... and via /people/<name>/<id> produces the same key", () => {
  const viaProfilePhp = batchTargetForUrl(
    "https://www.facebook.com/profile.php?id=100000000000001&sk=reels_tab"
  );
  const viaPeople = batchTargetForUrl(
    "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/100000000000001/?sk=reels_tab"
  );
  assert.deepEqual(viaProfilePhp, viaPeople);
  assert.equal(viaPeople.key, "100000000000001");
});

test("/people/<name>/<digits> without sk=reels_tab does not match", () => {
  assert.equal(
    batchTargetForUrl("https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/100000000000001/"),
    null
  );
});

test("/people/reels (two segments) still does not match — the reserved rule is intact", () => {
  assert.equal(batchTargetForUrl("https://www.facebook.com/people/reels"), null);
});

test("a non-numeric third segment in a /people/ URL does not match", () => {
  assert.equal(
    batchTargetForUrl(
      "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/not-a-number/?sk=reels_tab"
    ),
    null
  );
});

test("facebookPeopleUrlName decodes the percent-encoded name segment", () => {
  assert.equal(
    facebookPeopleUrlName(
      "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/100000000000001/?sk=reels_tab"
    ),
    "山田"
  );
});

test("facebookPeopleUrlName returns null for non-/people/ URLs", () => {
  assert.equal(facebookPeopleUrlName("https://www.facebook.com/somepage/reels"), null);
});

test("the inline collector in profileScanChunk accepts a /people/<name>/<id> reels page", async () => {
  withPage(
    `<div role="main"><a href="/reel/1001">own reel</a></div>`,
    "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/100000000000001/?sk=reels_tab"
  );

  const result = await profileScanChunk({
    provider: "facebook",
    hosts: ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"],
    expectedUsername: "100000000000001",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });

  assert.notEqual(result.error, "Open a Facebook profile reels page first.");
  assert.equal(result.ok, true);
  assert.equal(result.username, "100000000000001");
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

test("Facebook display name falls back to the decoded /people/ URL segment when the page scrape yields nothing", async () => {
  withPage(
    `<html><head><title>Facebook</title></head>
     <body><div role="main"><a href="/reel/1">x</a></div></body></html>`,
    "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/100000000000001/?sk=reels_tab"
  );
  const result = await profileScanChunk({
    provider: "facebook",
    hosts: ["www.facebook.com"],
    expectedUsername: "100000000000001",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });
  assert.equal(result.profileName, "山田");
});

test("a scraped page name still wins over the decoded /people/ URL segment", async () => {
  withPage(
    `<html><head>
       <meta property="og:title" content="Real Scraped Name">
     </head><body><div role="main"><a href="/reel/1">x</a></div></body></html>`,
    "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/100000000000001/?sk=reels_tab"
  );
  const result = await profileScanChunk({
    provider: "facebook",
    hosts: ["www.facebook.com"],
    expectedUsername: "100000000000001",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });
  assert.equal(result.profileName, "Real Scraped Name");
});

// --- Trailing tab-name-token stripping (Facebook appends the active tab's
// name to og:title, e.g. og:title "鈴木 Reels" on a reels page for a profile
// actually named "鈴木") ---

test("og:title of '鈴木 Reels' on a reels page yields profile name '鈴木'", async () => {
  withPage(
    `<html><head>
       <meta property="og:title" content="鈴木 Reels">
     </head><body><div role="main"><a href="/reel/1">x</a></div></body></html>`,
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
  assert.equal(result.profileName, "鈴木");
});

test("og:title of 'Some Creator Videos' yields 'Some Creator'", async () => {
  withPage(
    `<html><head>
       <meta property="og:title" content="Some Creator Videos">
     </head><body><div role="main"><a href="/reel/1">x</a></div></body></html>`,
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

test("a page legitimately named exactly 'Reels' is not reduced to an empty name", async () => {
  withPage(
    `<html><head>
       <meta property="og:title" content="Reels">
     </head><body><div role="main"><a href="/reel/1">x</a></div></body></html>`,
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
  assert.equal(result.profileName, "Reels");
});

test("a name ending in a word that merely contains a tab token (e.g. 'Prereels') is not mangled", async () => {
  withPage(
    `<html><head>
       <meta property="og:title" content="Prereels">
     </head><body><div role="main"><a href="/reel/1">x</a></div></body></html>`,
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
  assert.equal(result.profileName, "Prereels");
});

test("og:title of 'Some Creator | Facebook' yields 'Some Creator'", async () => {
  withPage(
    `<html><head>
       <meta property="og:title" content="Some Creator | Facebook">
     </head><body><div role="main"><a href="/reel/1">x</a></div></body></html>`,
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

test("the /people/<name>/<id> case: URL name '山田', scraped '山田 Reels' yields '山田'", async () => {
  withPage(
    `<html><head>
       <meta property="og:title" content="山田 Reels">
     </head><body><div role="main"><a href="/reel/1">x</a></div></body></html>`,
    "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/100000000000001/?sk=reels_tab"
  );
  const result = await profileScanChunk({
    provider: "facebook",
    hosts: ["www.facebook.com"],
    expectedUsername: "100000000000001",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });
  assert.equal(result.profileName, "山田");
});

test("a scraped name unrelated to the URL name still wins over the URL name", async () => {
  withPage(
    `<html><head>
       <meta property="og:title" content="Totally Different Name">
     </head><body><div role="main"><a href="/reel/1">x</a></div></body></html>`,
    "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/100000000000001/?sk=reels_tab"
  );
  const result = await profileScanChunk({
    provider: "facebook",
    hosts: ["www.facebook.com"],
    expectedUsername: "100000000000001",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });
  assert.equal(result.profileName, "Totally Different Name");
});

async function scanFacebookFixture(html, url) {
  withPage(html, url);
  return profileScanChunk({
    provider: "facebook",
    hosts: ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"],
    expectedUsername: "somepage",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });
}

test("Facebook scan excludes a suggestion heading in a sibling sub-container", async () => {
  const result = await scanFacebookFixture(
    `<div role="main">
       <a href="/reel/1001">own reel</a>
       <section>
         <div class="heading-slot"><h2>Reels for you</h2></div>
         <div class="items-slot"><a href="/reel/8001">suggested</a></div>
       </section>
     </div>`,
    "https://www.facebook.com/somepage/reels"
  );
  assert.deepEqual(result.urls.sort(), ["https://www.facebook.com/reel/1001"]);
});

test("Facebook scan excludes a suggestion region labelled via aria-label with no heading", async () => {
  const result = await scanFacebookFixture(
    `<div role="main">
       <a href="/reel/1001">own reel</a>
       <div role="region" aria-label="Reels for you">
         <a href="/reel/8001">suggested</a>
       </div>
     </div>`,
    "https://www.facebook.com/somepage/reels"
  );
  assert.deepEqual(result.urls.sort(), ["https://www.facebook.com/reel/1001"]);
});

test("Facebook scan excludes a suggestion heading localised to Japanese", async () => {
  const result = await scanFacebookFixture(
    `<div role="main">
       <a href="/reel/1001">own reel</a>
       <section>
         <h2>あなたへのおすすめ</h2>
         <a href="/reel/8001">suggested</a>
       </section>
     </div>`,
    "https://www.facebook.com/somepage/reels"
  );
  assert.deepEqual(result.urls.sort(), ["https://www.facebook.com/reel/1001"]);
});

test("Facebook scan excludes a reel inside an embedded/shared-post wrapper", async () => {
  const result = await scanFacebookFixture(
    `<div role="main">
       <a href="/reel/1001">own reel</a>
       <div data-testid="story-attachment">
         <a href="/reel/8001">embedded</a>
       </div>
       <div data-testid="quoted-post-container">
         <a href="/reel/8002">quoted</a>
       </div>
     </div>`,
    "https://www.facebook.com/somepage/reels"
  );
  assert.deepEqual(result.urls.sort(), ["https://www.facebook.com/reel/1001"]);
});

test("Facebook scan excludes a suggestion heading wrapped an extra div deeper", async () => {
  const result = await scanFacebookFixture(
    `<div role="main">
       <a href="/reel/1001">own reel</a>
       <section>
         <div><div><h2>Reels for you</h2></div></div>
         <a href="/reel/8001">suggested</a>
       </section>
     </div>`,
    "https://www.facebook.com/somepage/reels"
  );
  assert.deepEqual(result.urls.sort(), ["https://www.facebook.com/reel/1001"]);
});

test("Facebook scan still collects a reel anchor directly under role=main with no section wrapper", async () => {
  const result = await scanFacebookFixture(
    `<div role="main">
       <a href="/reel/1001">own reel</a>
       <a href="/reel/1002">another own reel</a>
     </div>`,
    "https://www.facebook.com/somepage/reels"
  );
  assert.deepEqual(result.urls.sort(), [
    "https://www.facebook.com/reel/1001",
    "https://www.facebook.com/reel/1002",
  ]);
});

test("result.urls is a non-empty array for both Twitter and Facebook fixtures", async () => {
  withPage(
    `<div role="main">
       <article>
         <video></video>
         <a href="/alice/status/1001"><time></time></a>
       </article>
     </div>`,
    "https://x.com/alice/media"
  );
  const twitterResult = await profileScanChunk({
    provider: "twitter",
    hosts: ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"],
    reserved: ["home", "explore", "notifications", "messages", "i", "settings"],
    expectedUsername: "alice",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });
  assert.ok(Array.isArray(twitterResult.urls), "Twitter result.urls must be an array");
  assert.ok(twitterResult.urls.length > 0, "Twitter result.urls must be non-empty");
  assert.deepEqual(twitterResult.urls, ["https://x.com/alice/status/1001"]);

  const facebookResult = await scanFacebookFixture(
    `<div role="main"><a href="/reel/1001">own reel</a></div>`,
    "https://www.facebook.com/somepage/reels"
  );
  assert.ok(Array.isArray(facebookResult.urls), "Facebook result.urls must be an array");
  assert.ok(facebookResult.urls.length > 0, "Facebook result.urls must be non-empty");
});

test("Facebook display name is empty (not the literal 'Facebook') when the title has no derivable name", async () => {
  withPage(
    `<html><head><title>Facebook</title></head>
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
  assert.equal(result.profileName, "");
});

test("Facebook display name normalises internal whitespace from a nested-markup h1", async () => {
  withPage(
    `<html><head><title>Facebook</title></head>
     <body><div role="main"><h1>Some  <b>Creator</b></h1><a href="/reel/1">x</a></div></body></html>`,
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

// --- Finding 1 regression: page-identity check on the Facebook collector ---

test("Facebook scan run against a non-Facebook page returns ok:false and collects nothing (finding-1 exploit fixture)", async () => {
  withPage(
    `<html><head>
       <meta property="og:title" content="../../../../etc">
     </head><body>
       <div role="main">
         <a href="/reel/999888">local-looking reel</a>
         <a href="https://attacker.example/reel/777">cross-host reel</a>
       </div>
     </body></html>`,
    "https://evil.example/somepage/reels"
  );

  const result = await profileScanChunk({
    provider: "facebook",
    hosts: ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"],
    expectedUsername: "somepage",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });

  assert.equal(result.ok, false);
  assert.ok(!("urls" in result) || result.urls === undefined, "no urls must be surfaced on failure");
});

test("a cross-host anchor inside a legitimate Facebook page is not collected", async () => {
  const result = await scanFacebookFixture(
    `<div role="main">
       <a href="/reel/1001">own reel</a>
       <a href="https://attacker.example/reel/777">cross-host reel</a>
     </div>`,
    "https://www.facebook.com/somepage/reels"
  );
  assert.deepEqual(result.urls.sort(), ["https://www.facebook.com/reel/1001"]);
  assert.ok(!result.urls.some((u) => u.includes("777")), "cross-host reel must not leak");
});

test("a Facebook page whose derived key does not match expectedUsername is rejected", async () => {
  withPage(
    `<div role="main"><a href="/reel/1001">own reel</a></div>`,
    "https://www.facebook.com/somepage/reels"
  );

  const result = await profileScanChunk({
    provider: "facebook",
    hosts: ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"],
    expectedUsername: "someoneelse",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });

  assert.equal(result.ok, false);
});

// --- Finding 3 regression: Facebook scan shares the scroll/round loop ---

// Mirrors background.js's runProfileScan: repeatedly invokes profileScanChunk,
// threading `progress` from one call into the next, until either the chunk
// reports `done` or the round budget (PROFILE_SCAN_MAX_ROUNDS in production)
// is exhausted — at which point the caller, not profileScanChunk itself, is
// responsible for declaring the result partial.
async function runRoundedFacebookScan(options, maxRounds) {
  let progress;
  let lastResult = null;
  for (let round = 0; round < maxRounds; round += 1) {
    lastResult = await profileScanChunk({ ...options, progress });
    if (!lastResult.ok) {
      return lastResult;
    }
    progress = lastResult.progress;
    if (lastResult.done) {
      return lastResult;
    }
  }
  return { ...lastResult, partial: true };
}

test("a multi-round Facebook scan accumulates across rounds and reports partial when it hits the round limit", async () => {
  withPage(
    `<div role="main">
       <a href="/reel/1001">round one reel</a>
     </div>`,
    "https://www.facebook.com/somepage/reels"
  );

  const scanOptions = {
    provider: "facebook",
    hosts: ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"],
    expectedUsername: "somepage",
    // A budget shorter than one scroll-sleep cycle (~900ms) guarantees each
    // chunk call returns after exactly one collection pass, so the loop must
    // span multiple profileScanChunk invocations to make further progress —
    // exactly like production's ~4s PROFILE_SCAN_CHUNK_MS chunking, scaled down.
    budgetMs: 50,
    maxPasses: 36,
  };

  // Round one: collects what's already in the DOM, then the budget expires
  // before the stability/pass ceiling, so the scan is not "done" yet.
  const roundOne = await profileScanChunk({ ...scanOptions, progress: {} });
  assert.equal(roundOne.ok, true);
  assert.equal(roundOne.done, false);
  assert.deepEqual(roundOne.urls, ["https://www.facebook.com/reel/1001"]);
  assert.ok(roundOne.progress, "progress must be returned for threading into round two");

  // Simulate new content having loaded (as continued scrolling would surface)
  // before round two, and thread progress through exactly as background.js's
  // runProfileScan does via its `progress` argument.
  document.querySelector("[role='main']").innerHTML +=
    '<a href="/reel/1002">round two reel</a>';

  const roundTwo = await profileScanChunk({ ...scanOptions, progress: roundOne.progress });
  assert.equal(roundTwo.ok, true);
  assert.deepEqual(roundTwo.urls.sort(), [
    "https://www.facebook.com/reel/1001",
    "https://www.facebook.com/reel/1002",
  ]);
  assert.ok(
    roundTwo.urls.includes("https://www.facebook.com/reel/1001"),
    "round one's finds must survive into round two's accumulated result"
  );

  // Drive the same loop background.js runs, capped at a small round budget so
  // it never reaches the stability/pass ceiling — demonstrating the caller's
  // own partial-reporting responsibility independent of whether
  // profileScanChunk itself would eventually stabilise. Both reels found
  // above (round/reel 1001 and 1002) are still present in the DOM, so a
  // fresh rounded scan must still accumulate both.
  const rounded = await runRoundedFacebookScan(scanOptions, 3);
  assert.equal(rounded.ok, true);
  assert.equal(rounded.partial, true, "hitting the round limit must be reported as partial");
  assert.deepEqual(rounded.urls.sort(), [
    "https://www.facebook.com/reel/1001",
    "https://www.facebook.com/reel/1002",
  ]);
});

const TWITTER_SCAN_OPTIONS = {
  provider: "twitter",
  hosts: ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"],
  reserved: ["home", "explore", "notifications", "messages", "i", "settings"],
  expectedUsername: "alice",
  budgetMs: 50,
  maxPasses: 36,
};

const FACEBOOK_SCAN_OPTIONS = {
  provider: "facebook",
  hosts: ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"],
  expectedUsername: "somepage",
  budgetMs: 50,
  maxPasses: 36,
};

for (const [name, options, url] of [
  ["Twitter", TWITTER_SCAN_OPTIONS, "https://x.com/alice/media"],
  ["Facebook", FACEBOOK_SCAN_OPTIONS, "https://www.facebook.com/somepage/reels"],
]) {
  test(`a ${name} scan that hits the pass cap while the page still grows is reported as capped`, async () => {
    withPage(`<div role="main"></div>`, url);
    const result = await profileScanChunk({
      ...options,
      progress: { passes: 36, stablePasses: 0 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.done, true);
    assert.equal(result.capped, true);
  });

  test(`a ${name} scan that settles is done and not capped`, async () => {
    withPage(`<div role="main"></div>`, url);
    const result = await profileScanChunk({
      ...options,
      progress: { passes: 36, stablePasses: 4 },
    });
    assert.equal(result.done, true);
    assert.equal(result.capped, false);
  });
}

test("a Facebook scan skips a reel link whose href cannot be parsed", async () => {
  withPage(
    `<div role="main">
       <a href="/reel/1001">good reel</a>
       <a href="http://[bad/reel/2">broken reel</a>
     </div>`,
    "https://www.facebook.com/somepage/reels"
  );
  const result = await profileScanChunk({ ...FACEBOOK_SCAN_OPTIONS, progress: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.urls, ["https://www.facebook.com/reel/1001"]);
});

// A profile scan runs for many seconds; the tab can move to another profile
// meanwhile, and its videos must not be queued under the first profile's name.
async function scanWhileNavigating(provider, hosts, html, fromUrl, toUrl, expectedUsername) {
  const dom = withPage(html, fromUrl);
  const scan = profileScanChunk({
    provider,
    hosts,
    reserved: [],
    expectedUsername,
    budgetMs: 1500,
    maxPasses: 5,
    progress: {},
  });
  dom.reconfigure({ url: toUrl });
  return scan;
}

test("a Facebook scan stops when the tab navigates to another profile mid-scan", async () => {
  const result = await scanWhileNavigating(
    "facebook",
    ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"],
    `<div role="main"><a href="/reel/2002">another profile's reel</a></div>`,
    "https://www.facebook.com/somepage/reels",
    "https://www.facebook.com/otherpage/reels",
    "somepage"
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /changed/);
});

test("a Twitter scan stops when the tab navigates to another profile mid-scan", async () => {
  const result = await scanWhileNavigating(
    "twitter",
    ["x.com", "twitter.com"],
    `<a href="/alice/status/1/video/1">clip</a>`,
    "https://x.com/alice/media",
    "https://x.com/bob/media",
    "alice"
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /changed/);
});

test("a Twitter scan on the Posts tab finds the posts X's Videos tab leaves out", async () => {
  // The Videos tab only lists posts holding exactly one video; posts with two
  // videos, or a video and photos, are only on the Posts tab.
  withPage(
    `<div role="main">
       <article>
         <div data-testid="tweetPhoto"><img></div>
         <div data-testid="videoPlayer"><video></video></div>
         <a href="/alice/status/2001"><time></time></a>
       </article>
       <article>
         <div data-testid="videoPlayer"><video></video></div>
         <div data-testid="videoPlayer"><video></video></div>
         <a href="/alice/status/2002"><time></time></a>
       </article>
       <article>
         <div data-testid="socialContext">alice reposted</div>
         <div data-testid="videoPlayer"><video></video></div>
         <a href="/bob/status/9002"><time></time></a>
       </article>
       <article>
         <div data-testid="tweetPhoto"><img></div>
         <a href="/alice/status/2003"><time></time></a>
       </article>
     </div>`,
    "https://x.com/alice"
  );

  const result = await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, maxPasses: 1 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.progress.urls.sort(), [
    "https://x.com/alice/status/2001",
    "https://x.com/alice/status/2002",
  ]);
});

test("a Twitter scan refuses pages that are not the profile", async () => {
  for (const url of ["https://x.com/alice/likes", "https://x.com/home", "https://x.com/alice/status/1"]) {
    withPage("<div role='main'></div>", url);
    const result = await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, maxPasses: 1 });
    assert.equal(result.ok, false, url);
  }
});

test("the Posts tab of a profile is its bare handle URL", async () => {
  const { twitterPostsUrl } = await import("../extension/providers.js");
  assert.equal(twitterPostsUrl("SomeHandle"), "https://x.com/SomeHandle");
});

test("a Twitter scan of an account that is gone says so instead of finding nothing", async () => {
  withPage(
    `<div role="main"><div data-testid="emptyState"><span data-testid="empty_state_header_text">gone</span></div></div>`,
    "https://x.com/alice"
  );
  const result = await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, maxPasses: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.gone, true);
});

test("a profile with no posts yet is not taken for a gone account", async () => {
  withPage(
    `<div role="main"><div data-testid="UserName">Alice</div><div data-testid="emptyState">no posts</div></div>`,
    "https://x.com/alice"
  );
  const result = await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, maxPasses: 1 });
  assert.equal(result.ok, true);
});

test("a check stops at the newest post the previous check saw, ignoring the pinned post", async () => {
  // The pinned post is old but sits on top; stopping there would skip everything new.
  withPage(
    `<div role="main">
       <article><div data-testid="socialContext">Pinned</div><video></video><a href="/alice/status/100"><time></time></a></article>
       <article><video></video><a href="/alice/status/505"><time></time></a></article>
       <article><a href="/alice/status/500"><time></time></a></article>
       <article><video></video><a href="/alice/status/400"><time></time></a></article>
     </div>`,
    "https://x.com/alice"
  );

  const result = await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, stopAtId: "500" });

  assert.equal(result.ok, true);
  assert.equal(result.done, true);
  assert.equal(result.reachedStop, true);
  assert.equal(result.newestId, "505");
  assert.ok(result.urls.includes("https://x.com/alice/status/505"));
});

test("without a marker a check reads on and reports the newest post it saw", async () => {
  withPage(
    `<div role="main">
       <article><div data-testid="socialContext">alice reposted</div><video></video><a href="/alice/status/900"><time></time></a></article>
       <article><video></video><a href="/alice/status/505"><time></time></a></article>
     </div>`,
    "https://x.com/alice"
  );

  const result = await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, maxPasses: 1 });

  assert.equal(result.reachedStop, false);
  // A repost of an old post is not where the timeline is.
  assert.equal(result.newestId, "505");
});

test("a status link outside a post on the Posts tab does not stop a check", async () => {
  // A sidebar or "who to follow" link is not a position in the timeline.
  withPage(
    `<div role="main">
       <article><video></video><a href="/alice/status/600"><time></time></a></article>
       <a href="/alice/status/400"></a>
     </div>`,
    "https://x.com/alice"
  );

  const result = await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, stopAtId: "500", maxPasses: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.reachedStop, false);
  assert.equal(result.newestId, "600");
});

test("a check on the Media tab stops at the previous check's post", async () => {
  withPage(`<div role="main">
      <a href="/alice/status/600/video/1"></a>
      <a href="/alice/status/550/photo/1"></a>
      <a href="/alice/status/500/video/1"></a>
    </div>`, "https://x.com/alice/media");
  const result = await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, stopAtId: "500" });
  assert.equal(result.done, true);
  assert.equal(result.reachedStop, true);
  assert.equal(result.newestId, "600");
  assert.deepEqual(result.urls.sort(), ["https://x.com/alice/status/500", "https://x.com/alice/status/600"]);
});

test("a link in a sidebar next to newer grid cells does not stop a Media check", async () => {
  // An old post suggested in a sidebar is not a place in the timeline.
  withPage(`<div class="layout">
      <main><a href="/alice/status/600/video/1"></a><a href="/alice/status/550/video/1"></a></main>
      <aside><a href="/alice/status/400/photo/1"></a></aside>
    </div>`, "https://x.com/alice/media");
  const result = await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, stopAtId: "500", maxPasses: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.reachedStop, false);
  assert.equal(result.newestId, "600");
});

test("X's sidebar column inside main is not the timeline: an old link there neither stops nor hides the grid", async () => {
  withPage(`<main>
      <div data-testid="primaryColumn">
        <a href="/alice/status/600/video/1"></a>
        <a href="/alice/status/550/video/1"></a>
      </div>
      <div data-testid="sidebarColumn"><a href="/alice/status/400/photo/1"></a></div>
    </main>`, "https://x.com/alice/media");
  const result = await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, stopAtId: "500", maxPasses: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.reachedStop, false);
  assert.equal(result.newestId, "600");
  assert.deepEqual(result.urls.sort(), ["https://x.com/alice/status/550", "https://x.com/alice/status/600"]);
});

test("a link inside the sidebar column is never a position, even with no primary column", async () => {
  withPage(`<main>
      <a href="/alice/status/600/video/1"></a>
      <div data-testid="sidebarColumn"><a href="/alice/status/400/photo/1"></a></div>
    </main>`, "https://x.com/alice/media");
  const result = await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, stopAtId: "500", maxPasses: 1 });
  assert.equal(result.reachedStop, false);
  assert.equal(result.newestId, "600");
});

test("with a primary column, a link in main outside it is not a position either", async () => {
  withPage(`<main>
      <div data-testid="primaryColumn"><a href="/alice/status/600/video/1"></a></div>
      <div class="rail"><a href="/alice/status/400/photo/1"></a></div>
    </main>`, "https://x.com/alice/media");
  const result = await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, stopAtId: "500", maxPasses: 1 });
  assert.equal(result.reachedStop, false);
  assert.equal(result.newestId, "600");
});

test("the primary column counts as the timeline too, and a photo cell can be the stop", async () => {
  withPage(`<div data-testid="primaryColumn">
      <a href="/alice/status/600/video/1"></a>
      <a href="/alice/status/500/photo/1"></a>
    </div>
    <div data-testid="sidebarColumn"><a href="/alice/status/100/video/1"></a></div>`, "https://x.com/alice/media");
  const result = await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, stopAtId: "500" });
  assert.equal(result.reachedStop, true);
  assert.equal(result.newestId, "600");
});

test("a scan page is the profile's Posts or Media tab, whatever the query", async () => {
  const { isScanPageUrl } = await import("../extension/providers.js");
  for (const url of ["https://x.com/alice", "https://x.com/alice/", "https://x.com/Alice/media", "https://twitter.com/alice/media/?s=20", "https://x.com/alice?s=20#top"]) {
    assert.equal(isScanPageUrl(url, "alice"), true, url);
  }
  for (const url of ["https://x.com/alice/with_replies", "https://x.com/alice/likes", "https://x.com/bob", "https://x.com/home",
                     "https://x.com/alice/status/1001", "https://example.com/alice", "chrome://newtab/", "", null]) {
    assert.equal(isScanPageUrl(url, "alice"), false, String(url));
  }
  assert.equal(isScanPageUrl("https://x.com/alice", ""), false);
});

const pass = (o) => ({ ok: true, urls: [], partial: false, complete: true, newestId: null, ...o });

test("a merged scan says which tab is only part read", () => {
  assert.deepEqual(mergeScanPasses(pass({}), pass({})).partialTabs, []);
  assert.deepEqual(mergeScanPasses(pass({ partial: true }), pass({})).partialTabs, ["posts"]);
  assert.deepEqual(mergeScanPasses(pass({}), pass({ partial: true })).partialTabs, ["media"]);
  assert.deepEqual(mergeScanPasses(pass({}), { ok: false, error: "x", urls: [] }).partialTabs, ["media"], "an unopened Media tab");
  assert.deepEqual(mergeScanPasses(pass({}), null).partialTabs, ["media"]);
  assert.deepEqual(mergeScanPasses(pass({ partial: true }), pass({ partial: true })).partialTabs, ["posts", "media"]);
});

test("a scan page says which of the two tabs it is", async () => {
  const { scanPageTab } = await import("../extension/providers.js");
  assert.equal(scanPageTab("https://x.com/alice", "alice"), "posts");
  assert.equal(scanPageTab("https://x.com/Alice/?s=20", "alice"), "posts");
  assert.equal(scanPageTab("https://x.com/alice/media", "alice"), "media");
  assert.equal(scanPageTab("https://x.com/alice/Media/#a", "alice"), "media");
  assert.equal(scanPageTab("https://x.com/alice/with_replies", "alice"), null);
  assert.equal(scanPageTab("https://x.com/bob/media", "alice"), null);
});

test("both passes merge without duplicates and keep the newer position", () => {
  const m = mergeScanPasses(pass({ urls: ["u1", "u2"], newestId: "900" }), pass({ urls: ["u2", "u3"], newestId: "1000" }));
  assert.deepEqual(m.urls, ["u1", "u2", "u3"]);
  assert.equal(m.newestId, "1000");
  assert.equal(m.complete, true);
  assert.equal(m.partial, false);
});

test("a failed Media pass keeps the Posts videos and marks the scan partial", () => {
  const m = mergeScanPasses(pass({ urls: ["u1"], newestId: "9" }), { ok: false, error: "x", urls: [] });
  assert.equal(m.ok, true);
  assert.deepEqual(m.urls, ["u1"]);
  assert.equal(m.partial, true);
  assert.equal(m.complete, false);
});

test("a failed Media pass after an empty Posts pass is an incomplete result, not an empty complete one", () => {
  const m = mergeScanPasses(pass({ urls: [], newestId: "9" }), { ok: false, error: "x", urls: [] });
  assert.equal(m.ok, true);
  assert.deepEqual(m.urls, []);
  assert.equal(m.complete, false);
  assert.equal(m.partial, true);
});

test("a gone profile stops the scan", () => {
  assert.equal(mergeScanPasses({ ok: false, gone: true, urls: [] }, null).gone, true);
});

test("one incomplete pass makes the check incomplete", () => {
  assert.equal(mergeScanPasses(pass({}), pass({ complete: false })).complete, false);
  assert.equal(mergeScanPasses(pass({ complete: false }), pass({})).complete, false);
});

test("a profile that disappears between the passes is gone", () => {
  const m = mergeScanPasses(pass({ urls: ["u1"] }), { ok: false, gone: true, error: "gone", urls: [] });
  assert.equal(m.ok, false);
  assert.equal(m.gone, true);
});

test("a Posts pass that fails is the result, whatever Media did", () => {
  const m = mergeScanPasses({ ok: false, error: "no page", urls: [] }, pass({ urls: ["u9"] }));
  assert.equal(m.ok, false);
  assert.equal(m.gone, false);
  assert.equal(m.error, "no page");
});

test("a missing Media pass keeps the Posts videos and marks the scan partial", () => {
  const m = mergeScanPasses(pass({ urls: ["u1"] }), null);
  assert.equal(m.ok, true);
  assert.deepEqual(m.urls, ["u1"]);
  assert.equal(m.partial, true);
  assert.equal(m.complete, false);
});

test("a partial pass makes the scan partial", () => {
  assert.equal(mergeScanPasses(pass({ partial: true }), pass({})).partial, true);
  assert.equal(mergeScanPasses(pass({}), pass({ partial: true })).partial, true);
});

test("the newer position is compared as a number, not as text", () => {
  assert.equal(mergeScanPasses(pass({ newestId: "999" }), pass({ newestId: "1000" })).newestId, "1000");
  assert.equal(mergeScanPasses(pass({ newestId: "1000" }), pass({ newestId: "999" })).newestId, "1000");
  // Ids longer than a double holds exactly still compare right.
  assert.equal(
    mergeScanPasses(pass({ newestId: "1234567890123456789" }), pass({ newestId: "1234567890123456790" })).newestId,
    "1234567890123456790"
  );
});

test("a pass without a position leaves the other one's", () => {
  assert.equal(mergeScanPasses(pass({ newestId: null }), pass({ newestId: "7" })).newestId, "7");
  assert.equal(mergeScanPasses(pass({ newestId: "7" }), pass({ newestId: null })).newestId, "7");
  assert.equal(mergeScanPasses(pass({}), pass({})).newestId, null);
});

test("an article in X's sidebar column is not a position or a video of the timeline", async () => {
  withPage(`<main>
      <div data-testid="primaryColumn">
        <a href="/alice/status/600/video/1"></a>
        <article><video></video><a href="/alice/status/580"><time></time></a></article>
      </div>
      <div data-testid="sidebarColumn">
        <article><video></video><a href="/alice/status/400"><time></time></a></article>
      </div>
    </main>`, "https://x.com/alice/media");
  const result = await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, stopAtId: "500", maxPasses: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.reachedStop, false, "the sidebar article's old id did not stop the scan");
  assert.equal(result.newestId, "600");
  assert.deepEqual(result.urls.sort(), ["https://x.com/alice/status/580", "https://x.com/alice/status/600"]);
});

test("an article in the primary column still sets the position and the stop", async () => {
  withPage(`<main>
      <div data-testid="primaryColumn">
        <article><video></video><a href="/alice/status/600"><time></time></a></article>
        <article><video></video><a href="/alice/status/500"><time></time></a></article>
      </div>
      <div data-testid="sidebarColumn"><a href="/alice/status/900/video/1"></a></div>
    </main>`, "https://x.com/alice");
  const result = await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, stopAtId: "500" });
  assert.equal(result.reachedStop, true);
  assert.equal(result.newestId, "600");
});

test("a pass says which tab of the profile its page was, from the page itself", async () => {
  withPage(`<div role="main"><article><video></video><a href="/alice/status/600"><time></time></a></article></div>`, "https://x.com/alice/media");
  assert.equal((await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, maxPasses: 1 })).tab, "media");
  withPage(`<div role="main"><article><video></video><a href="/alice/status/600"><time></time></a></article></div>`, "https://x.com/alice");
  assert.equal((await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, maxPasses: 1 })).tab, "posts");
  withPage(`<div role="main"></div>`, "https://x.com/Alice/Media/");
  assert.equal((await profileScanChunk({ ...TWITTER_SCAN_OPTIONS, maxPasses: 1 })).tab, "media");
});
