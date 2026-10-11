import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  batchTargetForUrl,
  profileScanChunk,
  facebookPeopleUrlName,
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

// --- /people/<name>/<digits> profile reels URL form ---

test("batchTargetForUrl matches the /people/<name>/<digits> reels URL form, keyed on the numeric id", () => {
  assert.deepEqual(
    batchTargetForUrl(
      "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/61590939736806/?sk=reels_tab"
    ),
    { provider: "facebook", key: "61590939736806" }
  );
});

test("the same profile via profile.php?id=... and via /people/<name>/<id> produces the same key", () => {
  const viaProfilePhp = batchTargetForUrl(
    "https://www.facebook.com/profile.php?id=61590939736806&sk=reels_tab"
  );
  const viaPeople = batchTargetForUrl(
    "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/61590939736806/?sk=reels_tab"
  );
  assert.deepEqual(viaProfilePhp, viaPeople);
  assert.equal(viaPeople.key, "61590939736806");
});

test("/people/<name>/<digits> without sk=reels_tab does not match", () => {
  assert.equal(
    batchTargetForUrl("https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/61590939736806/"),
    null
  );
});

test("/people/reels (two segments) still does not match — the reserved rule is intact", () => {
  assert.equal(batchTargetForUrl("https://www.facebook.com/people/reels"), null);
});

test("a non-numeric third segment in a /people/ URL does not match", () => {
  assert.equal(
    batchTargetForUrl(
      "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/not-a-number/?sk=reels_tab"
    ),
    null
  );
});

test("facebookPeopleUrlName decodes the percent-encoded name segment", () => {
  assert.equal(
    facebookPeopleUrlName(
      "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/61590939736806/?sk=reels_tab"
    ),
    "小妮"
  );
});

test("facebookPeopleUrlName returns null for non-/people/ URLs", () => {
  assert.equal(facebookPeopleUrlName("https://www.facebook.com/somepage/reels"), null);
});

test("the inline collector in profileScanChunk accepts a /people/<name>/<id> reels page", async () => {
  withPage(
    `<div role="main"><a href="/reel/1001">own reel</a></div>`,
    "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/61590939736806/?sk=reels_tab"
  );

  const result = await profileScanChunk({
    provider: "facebook",
    hosts: ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"],
    expectedUsername: "61590939736806",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });

  assert.notEqual(result.error, "Open a Facebook profile reels page first.");
  assert.equal(result.ok, true);
  assert.equal(result.username, "61590939736806");
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
    "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/61590939736806/?sk=reels_tab"
  );
  const result = await profileScanChunk({
    provider: "facebook",
    hosts: ["www.facebook.com"],
    expectedUsername: "61590939736806",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });
  assert.equal(result.profileName, "小妮");
});

test("a scraped page name still wins over the decoded /people/ URL segment", async () => {
  withPage(
    `<html><head>
       <meta property="og:title" content="Real Scraped Name">
     </head><body><div role="main"><a href="/reel/1">x</a></div></body></html>`,
    "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/61590939736806/?sk=reels_tab"
  );
  const result = await profileScanChunk({
    provider: "facebook",
    hosts: ["www.facebook.com"],
    expectedUsername: "61590939736806",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });
  assert.equal(result.profileName, "Real Scraped Name");
});

// --- Trailing tab-name-token stripping (Facebook appends the active tab's
// name to og:title, e.g. og:title "月瑶 Reels" on a reels page for a profile
// actually named "月瑶") ---

test("og:title of '月瑶 Reels' on a reels page yields profile name '月瑶'", async () => {
  withPage(
    `<html><head>
       <meta property="og:title" content="月瑶 Reels">
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
  assert.equal(result.profileName, "月瑶");
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

test("the /people/<name>/<id> case: URL name '小妮', scraped '小妮 Reels' yields '小妮'", async () => {
  withPage(
    `<html><head>
       <meta property="og:title" content="小妮 Reels">
     </head><body><div role="main"><a href="/reel/1">x</a></div></body></html>`,
    "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/61590939736806/?sk=reels_tab"
  );
  const result = await profileScanChunk({
    provider: "facebook",
    hosts: ["www.facebook.com"],
    expectedUsername: "61590939736806",
    budgetMs: 50,
    maxPasses: 1,
    progress: {},
  });
  assert.equal(result.profileName, "小妮");
});

test("a scraped name unrelated to the URL name still wins over the URL name", async () => {
  withPage(
    `<html><head>
       <meta property="og:title" content="Totally Different Name">
     </head><body><div role="main"><a href="/reel/1">x</a></div></body></html>`,
    "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/61590939736806/?sk=reels_tab"
  );
  const result = await profileScanChunk({
    provider: "facebook",
    hosts: ["www.facebook.com"],
    expectedUsername: "61590939736806",
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
