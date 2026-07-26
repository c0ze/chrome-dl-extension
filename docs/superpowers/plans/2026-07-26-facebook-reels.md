# Facebook Reels Profile Downloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Batch-download a Facebook profile's reels into a folder named after the profile's display name, reusing the existing Twitter profile-batch pipeline.

**Architecture:** Introduce a provider table in both the Python native host and the extension. Only four things vary per site (hosts, batch-URL matching, item-URL shape, folder-name source); the scan orchestration, queue, watchdog and duplicate handling stay shared. The extension's duplicated host/reserved lists collapse into one shared ES module, which also makes the page scanner directly unit-testable.

**Tech Stack:** Python 3.11+ stdlib only (native host), plain ES2022 (extension, no build step), `unittest` for Python tests, `node --test` + jsdom for JS tests.

**Spec:** `docs/superpowers/specs/2026-07-26-facebook-reels-design.md`

## Global Constraints

- `native-host/yt_dlp_host.py` MUST remain a single self-contained file. `scripts/install_native_host.py` copies exactly that one file to `~/.local/share/yt-dlp-browser-host/`.
- Native host: Python 3.11+ **standard library only**. No third-party imports.
- Extension: plain ES2022. No bundler, no transpiler, no framework. The extension itself must never require a build step to load in Chrome.
- jsdom is a **devDependency only**. `npm install` is required to run tests, never to use the extension.
- Never introduce `innerHTML` or `insertAdjacentHTML`. All DOM built with `createElement` / `textContent`.
- `profileScanChunk` MUST stay closure-free: `chrome.scripting.executeScript` serialises its source, so it may reference nothing outside its own `options` parameter — not even module-level imports.
- Verify Python with `python3 -m py_compile native-host/yt_dlp_host.py`; verify JS with `node --check`.
- Delete any `native-host/__pycache__` created while testing.
- Both providers use output template `%(uploader_id,uploader|unknown-account)S-%(id)s.%(ext)s`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `native-host/yt_dlp_host.py` | modify | Provider table, Facebook matching, Unicode-safe sanitizer, `profile_name` handling |
| `native-host/test_yt_dlp_host.py` | create | Python unit tests for URL canonicalisation, batch matching, sanitizer |
| `extension/providers.js` | create | Shared ES module: host lists, batch matching, closure-free page scanner |
| `extension/background.js` | modify | Import from `providers.js`, pass provider name into the scan |
| `extension/download.js` | modify | Import batch matching from `providers.js` |
| `extension/manifest.json` | modify | `"type": "module"` service worker, version bump |
| `extension/download.html` | modify | `<script type="module">` |
| `tests/scan.test.js` | create | jsdom fixtures for both collectors |
| `package.json` | create | jsdom devDependency, `npm test` script |
| `.gitignore` | modify | Ignore `node_modules/` |
| `README.md` | modify | Document Facebook reels support |

---

### Task 1: Python regression net for current Twitter behaviour

Pins the behaviour that must survive the provider refactor. Written and committed **before** any refactor.

Do NOT pin `safe_path_part`'s non-ASCII handling — Task 4 deliberately changes it. Pin only its traversal safety, which must never regress.

**Files:**
- Create: `native-host/test_yt_dlp_host.py`

**Interfaces:**
- Consumes: existing `yt_dlp_host` module functions `normalize_url`, `twitter_profile_media_username`, `twitter_status_username`, `safe_path_part`
- Produces: `native-host/test_yt_dlp_host.py`, runnable via `python3 -m unittest discover -s native-host -p 'test_*.py'`

- [ ] **Step 1: Write the failing test**

Create `native-host/test_yt_dlp_host.py`:

```python
"""Unit tests for the yt-dlp native messaging host."""
from __future__ import annotations

import unittest

import yt_dlp_host as host


class NormalizeUrlTwitterTests(unittest.TestCase):
    def test_canonicalises_status_variants_to_one_key(self) -> None:
        variants = [
            "https://x.com/foo/status/123",
            "https://x.com/foo/status/123/",
            "https://twitter.com/foo/status/123",
            "https://mobile.twitter.com/foo/status/123",
            "https://x.com/foo/status/123/photo/1",
            "https://x.com/foo/status/123?s=20",
        ]
        results = {host.normalize_url(url) for url in variants}
        self.assertEqual(results, {"https://x.com/foo/status/123"})

    def test_rejects_non_http_schemes(self) -> None:
        for url in ["ftp://x.com/a", "file:///etc/passwd", "javascript:alert(1)"]:
            with self.assertRaises(ValueError):
                host.normalize_url(url)

    def test_preserves_query_for_non_twitter_hosts(self) -> None:
        self.assertEqual(
            host.normalize_url("https://example.com/watch?v=abc"),
            "https://example.com/watch?v=abc",
        )


class TwitterBatchMatchingTests(unittest.TestCase):
    def test_matches_profile_media_url(self) -> None:
        self.assertEqual(
            host.twitter_profile_media_username("https://x.com/alice/media"),
            "alice",
        )

    def test_rejects_reserved_usernames(self) -> None:
        for name in ["home", "explore", "notifications", "messages", "i", "settings"]:
            with self.subTest(name=name):
                self.assertIsNone(
                    host.twitter_profile_media_username(f"https://x.com/{name}/media")
                )

    def test_rejects_non_media_paths(self) -> None:
        self.assertIsNone(host.twitter_profile_media_username("https://x.com/alice"))
        self.assertIsNone(
            host.twitter_profile_media_username("https://x.com/alice/status/1")
        )

    def test_status_username_extracts_owner(self) -> None:
        self.assertEqual(
            host.twitter_status_username("https://x.com/alice/status/123"),
            "alice",
        )


class SafePathPartTraversalTests(unittest.TestCase):
    """Traversal safety must never regress, whatever else changes."""

    def test_never_escapes_the_base_directory(self) -> None:
        for hostile in [
            "../../etc/passwd",
            "..",
            "../",
            "/etc/passwd",
            "a/b/c",
            "a\\b",
        ]:
            with self.subTest(hostile=hostile):
                result = host.safe_path_part(hostile)
                self.assertNotIn("/", result)
                self.assertNotIn("\\", result)
                self.assertNotEqual(result, "..")
                self.assertFalse(result.startswith("."))

    def test_never_returns_empty(self) -> None:
        for value in ["", "...", "___", "///"]:
            with self.subTest(value=value):
                self.assertTrue(host.safe_path_part(value))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they pass against current code**

Run: `cd native-host && python3 -m unittest test_yt_dlp_host -v`

Expected: all tests PASS. These pin existing behaviour, so a failure here means the current code differs from what the plan assumes — stop and investigate rather than editing the test to match.

- [ ] **Step 3: Commit**

```bash
rm -rf native-host/__pycache__
git add native-host/test_yt_dlp_host.py
git commit -m "Add regression tests for Twitter URL handling"
```

---

### Task 2: JS test harness and shared provider module

Extracts the scanner so it can be tested, and collapses the three duplicated host lists into one. No behaviour change.

**Files:**
- Create: `package.json`, `tests/scan.test.js`, `extension/providers.js`
- Modify: `.gitignore`, `extension/background.js`, `extension/download.js`, `extension/manifest.json`, `extension/download.html`

**Interfaces:**
- Produces: `extension/providers.js` exporting `TWITTER_HOSTS`, `FACEBOOK_HOSTS`, `RESERVED_PROFILE_USERNAMES`, `batchTargetForUrl(rawUrl) -> {provider, key} | null`, and `profileScanChunk(options)`.
- `batchTargetForUrl` returns `{provider: "twitter", key: "<handle>"}` for now; Task 7 adds the `"facebook"` case.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "chrome-dl-plugin-tests",
  "private": true,
  "type": "module",
  "description": "Test-only tooling. The extension itself requires no build step.",
  "scripts": {
    "test": "node --test tests/"
  },
  "devDependencies": {
    "jsdom": "^29.1.1"
  }
}
```

- [ ] **Step 2: Ignore node_modules**

Append to `.gitignore`:

```text
node_modules/
```

- [ ] **Step 3: Install and verify**

Run: `npm install && node -e "import('jsdom').then(() => console.log('jsdom OK'))"`
Expected: `jsdom OK`

- [ ] **Step 4: Create the shared provider module**

Create `extension/providers.js`.

Move these three blocks out of `background.js` **byte-for-byte**, adding only the `export` keyword. Do not retype them — cut and paste, so no transcription error can change scanner behaviour in a task that is supposed to have none:

| Block | Current location in `background.js` |
|---|---|
| `TWITTER_HOSTS` | lines 8-14 |
| `RESERVED_PROFILE_USERNAMES` | lines 17-24 |
| `profileScanChunk` (including its doc comment) | lines 90-319 |

After the move, confirm the function body is unchanged:

```bash
git show HEAD:extension/background.js | sed -n '97,319p' > /tmp/before.js
sed -n '/^export async function profileScanChunk/,/^}$/p' extension/providers.js \
  | sed '1s/^export //' > /tmp/after.js
diff /tmp/before.js /tmp/after.js && echo "verbatim move confirmed"
```

Expected: `verbatim move confirmed` (the only diff should be the stripped `export`, which the `sed` removes).

```javascript
export const TWITTER_HOSTS = [
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "x.com",
  "www.x.com",
];

export const FACEBOOK_HOSTS = [
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "web.facebook.com",
];

export const RESERVED_PROFILE_USERNAMES = [
  "home",
  "explore",
  "notifications",
  "messages",
  "i",
  "settings",
];

export function twitterProfileMediaUsername(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!TWITTER_HOSTS.includes(url.hostname)) {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || parts[1].toLowerCase() !== "media") {
      return null;
    }
    const candidate = parts[0];
    if (!/^[A-Za-z0-9_]{1,15}$/.test(candidate)) {
      return null;
    }
    return RESERVED_PROFILE_USERNAMES.includes(candidate.toLowerCase()) ? null : candidate;
  } catch (_error) {
    return null;
  }
}

export function batchTargetForUrl(rawUrl) {
  const twitterKey = twitterProfileMediaUsername(rawUrl);
  if (twitterKey) {
    return { provider: "twitter", key: twitterKey };
  }
  return null;
}

/**
 * Runs in the scanned page. Must stay closure-free: everything it needs arrives
 * through `options` because chrome.scripting serialises the function source.
 * It may NOT reference anything else exported from this module.
 */
export async function profileScanChunk(options) {
  // MOVE the existing body verbatim from background.js here.
}
```

- [ ] **Step 5: Convert consumers to modules**

In `extension/manifest.json`, change the background entry and bump the version:

```json
"version": "0.3.0",
"background": {
  "service_worker": "background.js",
  "type": "module"
}
```

In `extension/download.html` line 91:

```html
<script type="module" src="download.js"></script>
```

At the top of `extension/background.js`, replace the removed constants and function with:

```javascript
import {
  TWITTER_HOSTS,
  RESERVED_PROFILE_USERNAMES,
  batchTargetForUrl,
  profileScanChunk,
} from "./providers.js";
```

At the top of `extension/download.js`, replace its duplicated `TWITTER_HOSTS`, `RESERVED_PROFILE_USERNAMES` and `twitterProfileMediaUsername` with:

```javascript
import { batchTargetForUrl, twitterProfileMediaUsername } from "./providers.js";
```

Update `isTwitterProfileMediaUrl` in `download.js` to delegate:

```javascript
function isTwitterProfileMediaUrl(rawUrl) {
  return batchTargetForUrl(rawUrl)?.provider === "twitter";
}
```

- [ ] **Step 6: Write the Twitter scraper regression test**

Create `tests/scan.test.js`:

```javascript
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

  const urls = (result.urls || []).sort();
  assert.deepEqual(urls, [
    "https://x.com/alice/status/1001",
    "https://x.com/alice/status/1003",
  ]);
  assert.ok(!urls.some((u) => u.includes("bob")), "quoted post must not leak");
  assert.ok(!urls.some((u) => u.includes("1002")), "views text is not video evidence");
});
```

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: all tests PASS. If the scanner's `options` field names differ from those used above, correct the **test** to match the real signature — the scanner body was moved verbatim and is the source of truth.

- [ ] **Step 8: Verify the extension still parses**

Run: `node --check extension/background.js && node --check extension/download.js && node --check extension/providers.js && python3 -c "import json;json.load(open('extension/manifest.json'))"`
Expected: no output, exit 0.

- [ ] **Step 9: Load the extension in Chrome and confirm a Twitter profile scan still works**

This is a manual gate. Module service workers fail silently in ways `node --check` cannot catch. Load unpacked at `chrome://extensions`, open an X profile `/media` page, click the toolbar button, confirm the scan still finds videos. Check the service worker console for import errors.

- [ ] **Step 10: Commit**

```bash
git add package.json .gitignore tests/ extension/
git commit -m "Extract shared provider module and add scraper tests"
```

---

### Task 3: Host provider table (Twitter only)

Refactor with no behaviour change. Task 1's tests are the net.

**Files:**
- Modify: `native-host/yt_dlp_host.py:742-805` (the `canonical_twitter_path` through `twitter_status_username` block), `native-host/yt_dlp_host.py:904-905` (template selection)

**Interfaces:**
- Produces: `PROVIDERS` tuple; `provider_for_url(raw_url) -> dict | None`; `batch_target_for_url(raw_url) -> dict | None` returning `{"provider": str, "key": str}`; `PROFILE_OUTPUT_TEMPLATE` constant replacing `TWITTER_OUTPUT_TEMPLATE`.

- [ ] **Step 1: Add the provider table**

Add near the other module constants:

```python
PROFILE_OUTPUT_TEMPLATE = "%(uploader_id,uploader|unknown-account)S-%(id)s.%(ext)s"

PROVIDERS = (
    {
        "name": "twitter",
        "hosts": TWITTER_HOSTS,
        "canonical_host": "x.com",
        "batch_key": lambda url: twitter_profile_media_username(url),
        "canonical_path": lambda path: canonical_twitter_path(path),
        "strip_query": True,
        "template": PROFILE_OUTPUT_TEMPLATE,
    },
)


def provider_for_url(raw_url: str) -> dict[str, Any] | None:
    hostname = (urlparse(raw_url).hostname or "").lower()
    for provider in PROVIDERS:
        if hostname in provider["hosts"]:
            return provider
    return None


def batch_target_for_url(raw_url: str) -> dict[str, Any] | None:
    provider = provider_for_url(raw_url)
    if not provider:
        return None
    key = provider["batch_key"](raw_url)
    return {"provider": provider["name"], "key": key} if key else None
```

- [ ] **Step 2: Route normalize_url through the table**

Replace the Twitter branch in `normalize_url`:

```python
def normalize_url(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Only http(s) URLs are supported.")

    parsed = parsed._replace(fragment="")
    provider = provider_for_url(raw_url)
    if provider:
        parsed = parsed._replace(
            netloc=provider["canonical_host"],
            query="" if provider["strip_query"] else parsed.query,
            path=provider["canonical_path"](parsed.path),
        )
    else:
        parsed = parsed._replace(path=parsed.path.rstrip("/"))

    return urlunparse(parsed)
```

- [ ] **Step 3: Route the output template through the table**

Replace lines 904-905 in `build_command`:

```python
    provider = provider_for_url(url)
    if provider:
        command.extend(["-o", provider["template"]])
```

- [ ] **Step 4: Run the regression tests**

Run: `cd native-host && python3 -m unittest test_yt_dlp_host -v && python3 -m py_compile yt_dlp_host.py`
Expected: all PASS. Any failure means the refactor changed behaviour — fix the code, not the test.

- [ ] **Step 5: Commit**

```bash
rm -rf native-host/__pycache__
git add native-host/yt_dlp_host.py
git commit -m "Route URL handling through a provider table"
```

---

### Task 4: Unicode-safe folder sanitizer

**Files:**
- Modify: `native-host/yt_dlp_host.py:806` (`safe_path_part`)
- Modify: `native-host/test_yt_dlp_host.py`

**Interfaces:**
- Produces: `safe_path_part(value: str, fallback: str = "download") -> str`. The `fallback` parameter replaces the hardcoded `"twitter-profile"` string; callers pass the batch key.

- [ ] **Step 1: Write the failing tests**

Add to `native-host/test_yt_dlp_host.py`:

```python
class SafePathPartUnicodeTests(unittest.TestCase):
    def test_preserves_japanese(self) -> None:
        self.assertEqual(host.safe_path_part("ネコ動画"), "ネコ動画")

    def test_preserves_mixed_scripts(self) -> None:
        self.assertEqual(host.safe_path_part("Neko 動画"), "Neko 動画")

    def test_strips_filesystem_hostile_characters(self) -> None:
        result = host.safe_path_part('a/b\\c:d*e?f"g<h>i|j')
        for bad in '/\\:*?"<>|':
            self.assertNotIn(bad, result)

    def test_caps_at_255_utf8_bytes_on_a_character_boundary(self) -> None:
        result = host.safe_path_part("動" * 200)
        self.assertLessEqual(len(result.encode("utf-8")), 255)
        # Must not have split a multi-byte sequence.
        result.encode("utf-8").decode("utf-8")

    def test_uses_supplied_fallback_when_empty(self) -> None:
        self.assertEqual(host.safe_path_part("///", fallback="61590939736806"), "61590939736806")

    def test_strips_control_characters(self) -> None:
        self.assertNotIn("\x00", host.safe_path_part("a\x00b"))
        self.assertNotIn("\n", host.safe_path_part("a\nb"))
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd native-host && python3 -m unittest test_yt_dlp_host.SafePathPartUnicodeTests -v`
Expected: FAIL — `safe_path_part('ネコ動画')` currently returns `'twitter-profile'`.

- [ ] **Step 3: Implement**

Add `import unicodedata` to the imports, then replace `safe_path_part`:

```python
FORBIDDEN_PATH_CHARS = set('/\\:*?"<>|')
MAX_PATH_PART_BYTES = 255


def safe_path_part(value: str, fallback: str = "download") -> str:
    normalized = unicodedata.normalize("NFC", str(value or ""))
    cleaned = "".join(
        "_" if character in FORBIDDEN_PATH_CHARS or ord(character) < 32 else character
        for character in normalized
    )
    cleaned = re.sub(r"_{2,}", "_", cleaned).strip(" ._")

    while len(cleaned.encode("utf-8")) > MAX_PATH_PART_BYTES:
        cleaned = cleaned[:-1]
    cleaned = cleaned.strip(" ._")

    if not cleaned or cleaned in {".", ".."}:
        return safe_path_part(fallback) if fallback and fallback != value else "download"
    return cleaned
```

- [ ] **Step 4: Update the existing caller**

In `start_profile_download_jobs`, pass the batch key as the fallback:

```python
    profile_dir = Path(os.path.expanduser(base_download_dir)) / safe_path_part(
        username, fallback=username
    )
```

- [ ] **Step 5: Run all Python tests**

Run: `cd native-host && python3 -m unittest test_yt_dlp_host -v && python3 -m py_compile yt_dlp_host.py`
Expected: all PASS, including the Task 1 traversal tests.

- [ ] **Step 6: Commit**

```bash
rm -rf native-host/__pycache__
git add native-host/yt_dlp_host.py native-host/test_yt_dlp_host.py
git commit -m "Preserve Unicode in folder names with a byte-capped sanitizer"
```

---

### Task 5: Facebook provider in the host

**Files:**
- Modify: `native-host/yt_dlp_host.py` (constants block and provider table)
- Modify: `native-host/test_yt_dlp_host.py`

**Interfaces:**
- Produces: `FACEBOOK_HOSTS`, `FACEBOOK_RESERVED_SEGMENTS`, `facebook_profile_reels_key(raw_url) -> str | None`, `canonical_facebook_path(path) -> str`, `facebook_reel_id(raw_url) -> str | None`. `batch_target_for_url` gains the `"facebook"` case.

- [ ] **Step 1: Write the failing tests**

Add to `native-host/test_yt_dlp_host.py`:

```python
class FacebookBatchMatchingTests(unittest.TestCase):
    def test_matches_profile_php_reels_tab(self) -> None:
        target = host.batch_target_for_url(
            "https://www.facebook.com/profile.php?id=61590939736806&sk=reels_tab"
        )
        self.assertEqual(target, {"provider": "facebook", "key": "61590939736806"})

    def test_matches_vanity_reels_path(self) -> None:
        target = host.batch_target_for_url("https://www.facebook.com/somepage/reels")
        self.assertEqual(target, {"provider": "facebook", "key": "somepage"})

    def test_matches_mobile_subdomain(self) -> None:
        self.assertEqual(
            host.batch_target_for_url("https://m.facebook.com/somepage/reels")["key"],
            "somepage",
        )

    def test_rejects_profile_php_without_reels_tab(self) -> None:
        self.assertIsNone(
            host.batch_target_for_url("https://www.facebook.com/profile.php?id=123")
        )

    def test_rejects_videos_tab(self) -> None:
        self.assertIsNone(host.batch_target_for_url("https://www.facebook.com/somepage/videos"))

    def test_rejects_reserved_segments(self) -> None:
        for segment in ["reel", "watch", "groups", "marketplace", "profile.php", "login"]:
            with self.subTest(segment=segment):
                self.assertIsNone(
                    host.batch_target_for_url(f"https://www.facebook.com/{segment}/reels")
                )

    def test_single_reel_is_not_a_batch(self) -> None:
        self.assertIsNone(host.batch_target_for_url("https://www.facebook.com/reel/123"))


class FacebookUrlCanonicalisationTests(unittest.TestCase):
    def test_strips_tracking_parameters_so_duplicates_collapse(self) -> None:
        variants = [
            "https://www.facebook.com/reel/1234567890",
            "https://www.facebook.com/reel/1234567890/",
            "https://m.facebook.com/reel/1234567890?fs=e&s=TIeo",
            "https://web.facebook.com/reel/1234567890?mibextid=abc",
        ]
        results = {host.normalize_url(url) for url in variants}
        self.assertEqual(results, {"https://www.facebook.com/reel/1234567890"})

    def test_reel_id_extraction(self) -> None:
        self.assertEqual(
            host.facebook_reel_id("https://www.facebook.com/reel/1234567890"), "1234567890"
        )
        self.assertIsNone(host.facebook_reel_id("https://www.facebook.com/somepage/reels"))
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd native-host && python3 -m unittest test_yt_dlp_host.FacebookBatchMatchingTests -v`
Expected: FAIL with `AttributeError` / `None` mismatches.

- [ ] **Step 3: Implement the Facebook provider**

Add constants near `TWITTER_HOSTS`:

```python
FACEBOOK_HOSTS = {
    "facebook.com",
    "www.facebook.com",
    "m.facebook.com",
    "web.facebook.com",
}
FACEBOOK_RESERVED_SEGMENTS = {
    "reel", "reels", "watch", "groups", "marketplace", "events", "pages",
    "profile.php", "story.php", "photo", "share", "people", "login",
    "settings", "messages", "notifications",
}
FACEBOOK_REEL_ID_RE = re.compile(r"^/reel/(\d+)/?$")
FACEBOOK_VANITY_RE = re.compile(r"^[A-Za-z0-9.\-]{1,60}$")
```

Add the functions:

```python
def facebook_reel_id(raw_url: str) -> str | None:
    parsed = urlparse(raw_url)
    if (parsed.hostname or "").lower() not in FACEBOOK_HOSTS:
        return None
    match = FACEBOOK_REEL_ID_RE.match(parsed.path)
    return match.group(1) if match else None


def canonical_facebook_path(path: str) -> str:
    match = FACEBOOK_REEL_ID_RE.match(path)
    return f"/reel/{match.group(1)}" if match else path.rstrip("/")


def facebook_profile_reels_key(raw_url: str) -> str | None:
    parsed = urlparse(raw_url)
    if (parsed.hostname or "").lower() not in FACEBOOK_HOSTS:
        return None

    parts = [part for part in parsed.path.split("/") if part]

    if parts == ["profile.php"]:
        query = parse_qs(parsed.query)
        if "reels_tab" not in query.get("sk", []):
            return None
        candidate = (query.get("id") or [""])[0]
        return candidate if candidate.isdigit() else None

    if len(parts) == 2 and parts[1].lower() == "reels":
        candidate = parts[0]
        if candidate.lower() in FACEBOOK_RESERVED_SEGMENTS:
            return None
        return candidate if FACEBOOK_VANITY_RE.match(candidate) else None

    return None
```

Add `parse_qs` to the existing `urllib.parse` import, and add the provider entry to `PROVIDERS`:

```python
    {
        "name": "facebook",
        "hosts": FACEBOOK_HOSTS,
        "canonical_host": "www.facebook.com",
        "batch_key": lambda url: facebook_profile_reels_key(url),
        "canonical_path": lambda path: canonical_facebook_path(path),
        "strip_query": True,
        "template": PROFILE_OUTPUT_TEMPLATE,
    },
```

- [ ] **Step 4: Run all Python tests**

Run: `cd native-host && python3 -m unittest test_yt_dlp_host -v && python3 -m py_compile yt_dlp_host.py`
Expected: all PASS, Twitter tests included.

- [ ] **Step 5: Commit**

```bash
rm -rf native-host/__pycache__
git add native-host/yt_dlp_host.py native-host/test_yt_dlp_host.py
git commit -m "Add Facebook reels provider to the native host"
```

---

### Task 6: Accept `profile_name` and validate Facebook batch items

**Files:**
- Modify: `native-host/yt_dlp_host.py` — `handle_message` (~line 1761), `start_profile_download_jobs` (~line 1622)
- Modify: `native-host/test_yt_dlp_host.py`

**Interfaces:**
- Consumes: `batch_target_for_url`, `facebook_reel_id`, `safe_path_part(value, fallback)`
- Produces: `start_profile_download_jobs(...)` gains a `profile_name: str | None = None` parameter. The `download` message accepts an optional `profile_name` string.

- [ ] **Step 1: Write the failing tests**

Add to `native-host/test_yt_dlp_host.py`:

```python
class ProfileItemValidationTests(unittest.TestCase):
    def test_facebook_batch_accepts_only_reel_urls(self) -> None:
        target = {"provider": "facebook", "key": "61590939736806"}
        self.assertTrue(host.valid_batch_item("https://www.facebook.com/reel/123", target))
        self.assertFalse(
            host.valid_batch_item("https://www.facebook.com/somepage/posts/9", target)
        )
        self.assertFalse(host.valid_batch_item("https://x.com/alice/status/1", target))

    def test_twitter_batch_still_enforces_ownership(self) -> None:
        target = {"provider": "twitter", "key": "alice"}
        self.assertTrue(host.valid_batch_item("https://x.com/alice/status/1", target))
        self.assertFalse(host.valid_batch_item("https://x.com/bob/status/1", target))
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd native-host && python3 -m unittest test_yt_dlp_host.ProfileItemValidationTests -v`
Expected: FAIL with `AttributeError: module has no attribute 'valid_batch_item'`.

- [ ] **Step 3: Implement item validation**

```python
def valid_batch_item(raw_url: str, target: dict[str, Any]) -> bool:
    if target["provider"] == "facebook":
        return facebook_reel_id(raw_url) is not None
    if target["provider"] == "twitter":
        owner = twitter_status_username(raw_url)
        return bool(owner) and owner.lower() == str(target["key"]).lower()
    return False
```

Replace the Twitter-specific validation loop inside `start_profile_download_jobs` with a call to `valid_batch_item(url, target)`, keeping the existing `rejected_count` bookkeeping unchanged.

- [ ] **Step 4: Thread `profile_name` through**

In `start_profile_download_jobs` (line 1622), add the parameter and replace the Twitter-only key derivation. The current first two lines of the body are:

```python
    normalized_profile_url = normalize_url(raw_url)
    username = twitter_profile_media_username(normalized_profile_url)
    if not username:
        raise ValueError("Profile media downloads require a Twitter/X /media URL.")
```

Replace with:

```python
def start_profile_download_jobs(
    raw_url: str,
    source: str,
    download_dir_override: str | None,
    profile_video_urls: list[str],
    allow_duplicate: bool = False,
    profile_name: str | None = None,
) -> dict[str, Any]:
    normalized_profile_url = normalize_url(raw_url)
    target = batch_target_for_url(normalized_profile_url)
    if not target:
        raise ValueError(
            "Profile downloads require an X/Twitter /media URL or a Facebook reels URL."
        )
```

`target` is now in scope for the rest of the function. Every remaining reference to the old `username` local becomes `target["key"]`, including the existing response payload field `"username"`, which keeps its name for the extension's benefit:

```python
    folder_name = safe_path_part(profile_name or target["key"], fallback=target["key"])
    profile_dir = Path(os.path.expanduser(base_download_dir)) / folder_name
```

and in the success response:

```python
        "username": target["key"],
```

In `handle_message`, read and forward it:

```python
        profile_name = message.get("profile_name")
        if profile_name is not None and not isinstance(profile_name, str):
            raise ValueError("profile_name must be a string when provided.")
```

Pass `profile_name` as the final argument to `start_profile_download_jobs`, and change the batch branch from `twitter_profile_media_username(url)` to `batch_target_for_url(url)`.

- [ ] **Step 5: Run all Python tests**

Run: `cd native-host && python3 -m unittest test_yt_dlp_host -v && python3 -m py_compile yt_dlp_host.py`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
rm -rf native-host/__pycache__
git add native-host/yt_dlp_host.py native-host/test_yt_dlp_host.py
git commit -m "Accept a scraped profile name and validate batch items per provider"
```

---

### Task 7: Facebook collector and display-name extraction

**Files:**
- Modify: `extension/providers.js`
- Modify: `tests/scan.test.js`

**Interfaces:**
- Consumes: `profileScanChunk(options)` where `options.provider` is `"twitter"` or `"facebook"`
- Produces: `profileScanChunk` returns `{ok, urls, profileName?, done?}`; `batchTargetForUrl` gains the `"facebook"` case.

- [ ] **Step 1: Write the failing tests**

Add to `tests/scan.test.js`:

```javascript
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL — the Facebook branch does not exist.

- [ ] **Step 3: Implement**

Add the Facebook case to `batchTargetForUrl`:

```javascript
export const FACEBOOK_RESERVED_SEGMENTS = [
  "reel", "reels", "watch", "groups", "marketplace", "events", "pages",
  "profile.php", "story.php", "photo", "share", "people", "login",
  "settings", "messages", "notifications",
];

export function facebookProfileReelsKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!FACEBOOK_HOSTS.includes(url.hostname)) {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length === 1 && parts[0] === "profile.php") {
      if (url.searchParams.get("sk") !== "reels_tab") {
        return null;
      }
      const id = url.searchParams.get("id") || "";
      return /^\d+$/.test(id) ? id : null;
    }

    if (parts.length === 2 && parts[1].toLowerCase() === "reels") {
      const candidate = parts[0];
      if (FACEBOOK_RESERVED_SEGMENTS.includes(candidate.toLowerCase())) {
        return null;
      }
      return /^[A-Za-z0-9.\-]{1,60}$/.test(candidate) ? candidate : null;
    }

    return null;
  } catch (_error) {
    return null;
  }
}
```

Then replace `batchTargetForUrl` (added in Task 2) so it checks Facebook after Twitter:

```javascript
export function batchTargetForUrl(rawUrl) {
  const twitterKey = twitterProfileMediaUsername(rawUrl);
  if (twitterKey) {
    return { provider: "twitter", key: twitterKey };
  }

  const facebookKey = facebookProfileReelsKey(rawUrl);
  if (facebookKey) {
    return { provider: "facebook", key: facebookKey };
  }

  return null;
}
```

Inside `profileScanChunk`, branch on `options.provider`. The Facebook collector, kept closure-free:

```javascript
  function collectFacebookReels() {
    const root = document.querySelector("[role='main']");
    if (!root) {
      return [];
    }
    const suggestionWords = ["suggested", "people also watched", "reels for you"];
    const found = [];
    root.querySelectorAll("a[href*='/reel/']").forEach((anchor) => {
      if (anchor.closest("[role='complementary']")) {
        return;
      }
      let node = anchor.parentElement;
      while (node && node !== root) {
        const heading = node.querySelector(":scope > h1, :scope > h2, :scope > h3");
        const text = (heading?.textContent || "").toLowerCase();
        if (text && suggestionWords.some((word) => text.includes(word))) {
          return;
        }
        node = node.parentElement;
      }
      const match = /^\/reel\/(\d+)\/?$/.exec(new URL(anchor.href, window.location.href).pathname);
      if (match) {
        found.push(`https://www.facebook.com/reel/${match[1]}`);
      }
    });
    return found;
  }

  function facebookProfileName() {
    const og = document.querySelector("meta[property='og:title']");
    if (og?.content?.trim()) {
      return og.content.trim();
    }
    const heading = document.querySelector("[role='main'] h1");
    if (heading?.textContent?.trim()) {
      return heading.textContent.trim();
    }
    const title = (document.title || "")
      .replace(/^\(\d+\+?\)\s*/, "")
      .replace(/\s*\|\s*Facebook\s*$/i, "")
      .trim();
    return title || "";
  }
```

Return `profileName` alongside `urls` when the provider is `"facebook"`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all PASS, Twitter tests included.

- [ ] **Step 5: Commit**

```bash
git add extension/providers.js tests/scan.test.js
git commit -m "Add Facebook reels collector and display-name extraction"
```

---

### Task 8: Wire Facebook into the scan and the popup

**Files:**
- Modify: `extension/background.js`, `extension/download.js`

**Interfaces:**
- Consumes: `batchTargetForUrl`, `profileScanChunk` from `providers.js`

- [ ] **Step 1: Pass the provider into the scan**

In `background.js`, `prepareProfileBatch` currently gates on `twitterProfileMediaUsername(url)`. Replace that gate with the provider-agnostic lookup:

```javascript
async function prepareProfileBatch(tab, url) {
  const target = batchTargetForUrl(url);
  if (!target || typeof tab?.id !== "number") {
    return {};
  }
  // ...existing session-record creation, but store the provider and key:
  //   { provider: target.provider, key: target.key, status: "scanning", ... }
}
```

In `runProfileScan`, the `executeScript` `args` block currently hardcodes Twitter. Make the host list provider-dependent and pass the provider through:

```javascript
        args: [
          {
            provider,
            hosts: provider === "facebook" ? FACEBOOK_HOSTS : TWITTER_HOSTS,
            reserved: RESERVED_PROFILE_USERNAMES,
            expectedUsername,
            budgetMs: PROFILE_SCAN_CHUNK_MS,
            maxPasses: PROFILE_SCAN_MAX_PASSES,
            progress,
          },
        ],
```

Add `FACEBOOK_HOSTS` to the import from `./providers.js`, and thread `provider` into `runProfileScan`'s signature from the stored session record.

When a chunk returns, carry the scraped name onto the record so the popup can read it:

```javascript
      if (result.profileName) {
        progress.profileName = result.profileName;
      }
```

- [ ] **Step 2: Forward `profile_name` from the popup**

In `download.js`, read the name when the scan record is applied, next to where `state.profileUrls` is set:

```javascript
  state.profileName = record.profileName || "";
```

Add it to the `callHost` download payload in `startDownload`:

```javascript
      profile_name: state.profileName || undefined,
```

Replace the batch gate. `isTwitterProfileMediaUrl` is used to decide whether a URL takes the batch path; make it provider-agnostic:

```javascript
function isProfileBatchUrl(rawUrl) {
  return batchTargetForUrl(rawUrl) !== null;
}
```

Update every call site of `isTwitterProfileMediaUrl` to `isProfileBatchUrl` and delete the old function.

- [ ] **Step 3: Add the logged-out hint**

Where the popup reports an empty scan result, branch on the provider from the record:

```javascript
    const emptyScanMessage =
      batchTargetForUrl(state.targetUrl)?.provider === "facebook"
        ? "No reels were found. If you are signed out, Facebook hides profile reels — sign in, reload the page, and scan again."
        : "No video links were found. Scroll the profile media page to load videos, then try again.";
    showMessage("error", emptyScanMessage);
```

- [ ] **Step 4: Verify**

Run: `npm test && node --check extension/background.js && node --check extension/download.js && node --check extension/providers.js`
Expected: all PASS, exit 0.

- [ ] **Step 5: Manual gate — run it against the real URL**

Load unpacked in Chrome, open `https://www.facebook.com/profile.php?id=61590939736806&sk=reels_tab`, click the toolbar button. Confirm: the popup opens immediately in a scanning state, reels are found, the folder name matches the display name, and downloads queue one at a time. Then repeat on an X profile `/media` page to confirm no Twitter regression.

This gate cannot be automated — the Facebook collector depends on live DOM structure that no fixture can prove.

- [ ] **Step 6: Commit**

```bash
git add extension/
git commit -m "Wire Facebook reels into the profile scan and picker"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-07-26-facebook-reels-design.md`

- [ ] **Step 1: Update the README**

In Usage, document the Facebook reels flow, both accepted URL forms, and that the folder is named after the scraped display name. In Notes, record that reel URLs are canonicalised with tracking parameters stripped, and that the host validates scraped URLs as reel URLs but cannot verify reel ownership.

Add a Development section:

```markdown
## Development

Tests need Node and a one-time `npm install` (jsdom is a test-only dependency;
the extension itself requires no build step).

```bash
npm install
npm test                                    # extension scraper tests
cd native-host && python3 -m unittest       # native host tests
```
```

- [ ] **Step 2: Amend the spec**

Record that the JS tests use a `package.json` with a jsdom devDependency, resolving the spec's assumption that the repo stays dependency-free.

- [ ] **Step 3: Verify and commit**

Run: `npm test && cd native-host && python3 -m unittest && cd .. && rm -rf native-host/__pycache__`
Expected: all PASS.

```bash
git add README.md docs/
git commit -m "Document Facebook reels support and how to run the tests"
```
