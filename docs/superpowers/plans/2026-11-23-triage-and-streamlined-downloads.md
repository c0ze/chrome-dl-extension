# Triage Player and Streamlined Downloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-start downloads for known creators, add group buttons and short paths, scan both Posts and Media from any profile tab, play videos inline for triage, and add Check and favorites shortcuts.

**Architecture:** Pure decision logic goes in `extension/grouping.js` and `extension/providers.js` with node tests. Chrome-API orchestration stays in `background.js`. New UI lives in new modules: `player.js` (overlay player) and `picker.js` (group buttons). The host change is one rule in `remember_downloaded_post`.

**Tech Stack:** Chrome MV3 ES modules (no build), `node --test` + jsdom, Python 3 `unittest`.

**Spec:** `docs/superpowers/specs/2026-11-23-triage-and-streamlined-downloads-design.md`

## Global Constraints

- Public repo: no real group, handle, library path, post id or file name in code, tests, docs or commit messages. Use `group a`, `group b`, `alice`, `bob`, `/srv/archive/media/twitter`, ids like `1001`. Check `git diff --cached` before every commit.
- Group buttons and auto-start are X/Twitter only; Facebook keeps today's picker.
- Auto-start never bypasses the duplicate prompt, the removed-video refusal or missing-folder handling: it always goes through `startDownload`.
- The extension's `RESERVED_PROFILE_USERNAMES` and the host's `TWITTER_RESERVED_USERNAMES` hold the same names.
- The batch target URL for a Twitter profile is always `https://x.com/<handle>/media`, so host validation is unchanged.
- Every video starts muted; player controls are Chrome's own (`<video controls>`).
- Tests: `npm test` (repo root) and `cd native-host && python3 -m unittest` must pass after every task.
- Each user-visible change updates `README.md` in the same task.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push to `origin` after each commit.

## Review Focus

1. File names with spaces, `#`, `?`, `%` and Japanese characters must still play: `fileUrl` test in Task 6.
2. A creator reached through a former handle (alias) must auto-start into their current folder: `downloadPlan` alias test in Task 4.
3. The Media pass failing after the Posts pass succeeded must still yield the Posts videos, marked partial: `mergeScanPasses` test in Task 3.
4. Removing the last video in the player closes it, and removing a middle one shows the next: player tests in Task 6.
5. Profile URLs with a trailing slash, a query string or an upper-case tab name (`/alice/Media/?s=20`) are still profiles: Task 1 test.

---

### Task 1: Recognise every profile tab; profile links are not batch targets

**Files:**
- Modify: `extension/providers.js` (`RESERVED_PROFILE_USERNAMES`, `twitterProfileMediaUsername`, `batchTargetForUrl`)
- Modify: `extension/background.js` (`openDownloadPicker`, context menu handler)
- Modify: `native-host/yt_dlp_host.py:79` (`TWITTER_RESERVED_USERNAMES`)
- Test: `tests/scan.test.js`

**Interfaces:**
- Produces: `twitterProfileUsername(rawUrl: string): string | null` replaces `twitterProfileMediaUsername` (update every caller). It accepts `/<h>`, `/<h>/media`, `/<h>/with_replies`, `/<h>/highlights`, `/<h>/articles`, `/<h>/likes` (tab name case-insensitive, trailing slash and query ignored).
- Produces: `twitterMediaUrl(handle: string): string` → `https://x.com/<handle>/media`.
- Produces: `batchTargetForUrl(rawUrl)` keeps its shape `{ provider, key }`, now with the wider Twitter matching.
- Reserved list (both sides): `home, explore, notifications, messages, i, settings, search, compose, jobs, lists, bookmarks, communities, premium, tos, privacy, login, signup, logout, account, intent, share, hashtag, topics, verified-choose, download`.

- [ ] **Step 1: Write the failing tests**

```js
test("every profile tab is the same batch target", () => {
  for (const path of ["alice", "alice/", "alice/media", "alice/Media/?s=20", "alice/with_replies",
                      "alice/highlights", "alice/articles", "alice/likes"]) {
    assert.deepEqual(batchTargetForUrl(`https://x.com/${path}`), { provider: "twitter", key: "alice" }, path);
  }
});
test("a post, an unknown tab or a reserved route is not a profile", () => {
  for (const path of ["alice/status/1001", "alice/followers", "search", "compose/post", "home/media", "i/lists"]) {
    assert.equal(batchTargetForUrl(`https://x.com/${path}`), null, path);
  }
});
test("the host reserves the same Twitter routes as the extension", () => {
  const source = readFileSync(new URL("../native-host/yt_dlp_host.py", import.meta.url), "utf8");
  const hostSet = source.match(/TWITTER_RESERVED_USERNAMES = \{([^}]*)\}/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  assert.deepEqual([...hostSet].sort(), [...RESERVED_PROFILE_USERNAMES].sort());
});
```

The `followers` case: tab list is exactly the six forms above.

- [ ] **Step 2: Run** `npm test` and check that the three new tests fail.
- [ ] **Step 3: Implement the providers.js changes.** Update the reserved list, then `twitterProfileUsername` and `twitterMediaUrl`. Make the host set the same list.
- [ ] **Step 4: Change background.js.**
  - In `openDownloadPicker(url, source, tab, { fromLink = false } = {})`, a Twitter target's picker URL param is `twitterMediaUrl(target.key)`.
  - A scan is started only when `!fromLink`.
  - The context-menu handler passes `fromLink: Boolean(info.linkUrl)`.
  - The picker already shows "Open the X/Twitter profile … use the toolbar button there" for a batch URL without a scan key. Reword that text to "Open the profile in a tab and use the toolbar button there."
- [ ] **Step 5: Run** `npm test` and `cd native-host && python3 -m unittest`. Expected: all pass.
- [ ] **Step 6: Update README.** In Usage, the scan starts from any profile tab, and a right-clicked profile link does not scan. Then commit: `Scan a profile from any of its tabs`.

### Task 2: Media grid cells track position and the stop point

**Files:**
- Modify: `extension/providers.js` (`collectVisibleLinks`, grid branch)
- Test: `tests/scan.test.js`

**Interfaces:**
- Produces: on a Media page, `profileScanChunk` returns `newestId` and `reachedStop` the same way it does on Posts.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run** `npm test` and check that it fails: `newestId` is null.
- [ ] **Step 3: Implement.** In the grid branch, call the position tracking for every cell owned by the profile, before the video filter. `notePostPosition` takes an article for the social-context check, so add `notePostId(id)` and have `notePostPosition` call it.
- [ ] **Step 4: Run** `npm test`. Expected: all pass, including the existing Posts check tests.
- [ ] **Step 5: Commit** `Track position on the Media grid so checks can stop there`.

### Task 3: Scan Posts, then Media, for the toolbar and for checks

**Files:**
- Modify: `extension/providers.js` (new pure `mergeScanPasses`)
- Modify: `extension/background.js` (`scanProfileTab`, `runProfileScan`, `checkHandle`, `restartProfileScan`)
- Test: `tests/scan.test.js`

**Interfaces:**
- Produces: `mergeScanPasses(posts: Pass, media: Pass | null): Merged`.
  - `Pass` = `{ ok: boolean, gone?: boolean, error?: string, urls: string[], partial: boolean, complete: boolean, newestId: string | null }`.
  - `Merged` = `{ ok, gone, error, urls, partial, complete, newestId }`.
  - `urls` is deduplicated and keeps order (posts first). `newestId` is the larger of the two (compare with BigInt). `complete` holds only when both passes are ok and complete. `partial` holds when either pass is partial or media is missing or failed (`media === null` or `!media.ok`).
  - When the posts pass is not ok, the result is the posts pass (gone or error). When media is gone, the result is `ok: false, gone: true`.
- Produces in background.js: `scanPass(tabId, provider, username, key, { maxRounds, stopAtId, carryUrls }): Promise<Pass & { profileName, originalScrollY }>`. It writes only `status: "scanning"` records, with `found = carryUrls.length + current`. `runProfileScan` becomes `scanPass` plus the final record write, used for Facebook.

- [ ] **Step 1: Write the failing tests**

```js
const pass = (o) => ({ ok: true, urls: [], partial: false, complete: true, newestId: null, ...o });
test("both passes merge without duplicates and keep the newer position", () => {
  const m = mergeScanPasses(pass({ urls: ["u1", "u2"], newestId: "900" }), pass({ urls: ["u2", "u3"], newestId: "1000" }));
  assert.deepEqual(m.urls, ["u1", "u2", "u3"]);
  assert.equal(m.newestId, "1000");
  assert.equal(m.complete, true);
  assert.equal(m.partial, false);
});
test("a failed Media pass keeps the Posts videos and marks the scan partial", () => {
  const m = mergeScanPasses(pass({ urls: ["u1"], newestId: "9" }), { ok: false, error: "x", urls: [] });
  assert.equal(m.ok, true); assert.deepEqual(m.urls, ["u1"]);
  assert.equal(m.partial, true); assert.equal(m.complete, false);
});
test("a gone profile stops the scan", () => {
  assert.equal(mergeScanPasses({ ok: false, gone: true, urls: [] }, null).gone, true);
});
test("one incomplete pass makes the check incomplete", () => {
  assert.equal(mergeScanPasses(pass({}), pass({ complete: false })).complete, false);
});
```

- [ ] **Step 2: Run** `npm test` and check that the tests fail (`mergeScanPasses` is not exported).
- [ ] **Step 3: Implement `mergeScanPasses`** in providers.js.
- [ ] **Step 4: Restructure background.js.**
  - `scanProfileTab(tabId, provider, username, key, returnUrl = null)` holds the `activeScans` guard. For Twitter it runs: `showTwitterPosts`, then a posts `scanPass`, then `chrome.tabs.update` to `twitterMediaUrl` and `waitForTabLoad`, then a media `scanPass` with `carryUrls` = posts urls. After that it calls `mergeScanPasses`, writes the final `done`/`error` record (`partial` from the merge, `gone` passed through) and navigates the tab back:
    - If `returnUrl` differs from the current URL, update the tab to `returnUrl` and wait for it to load.
    - If `returnUrl` is the Posts or Media URL, scroll to that pass's `originalScrollY`.
  - The media pass runs only when the posts pass is ok.
  - `openDownloadPicker` passes the tab's original `tab.url` as `returnUrl`. `restartProfileScan` passes none.
  - `checkHandle` runs the same two passes in its background tab, each with the same `stopAtId`. It returns `{ ok, gone, error, urls, newestId, complete }` from the merge.
- [ ] **Step 5: Run** `npm test`. Expected: pass.
- [ ] **Step 6: Manual check** (Chrome, real profile, nothing committed from it). Reload the unpacked extension and press the toolbar button on a profile's Replies tab. Check that the picker shows progress, the count grows through both passes, and the tab ends back on Replies. Then use Check on one handle and check that it finishes and records `last_checked`.
- [ ] **Step 7: Update README** (scan and check read Posts and Media; a check takes up to twice as long). Commit `Read the Media tab after the Posts tab in scans and checks`.

### Task 4: Download plan, group folders, short paths (pure helpers)

**Files:**
- Modify: `extension/grouping.js`
- Test: `tests/grouping.test.js`

**Interfaces:**
- Consumes: handle entries from `get_handles` (`{ handle, aliases, folders: [{ base_dir, name, group }] }`).
- Produces:
  - `downloadPlan(entries, handle: string, isProfile: boolean): { auto: { directory, group, handle } | null, groups: string[] }`.
    - Match the handle case-insensitively, by handle or alias.
    - Exactly one folder: `auto` is set (`directory` is `base_dir` for a profile, otherwise `base_dir/name`), and `groups` is that folder's group.
    - Several folders: `auto` is null and `groups` lists them all.
    - Unknown handle or empty handle: `{ auto: null, groups: [] }`.
  - `groupDirectory(root: string, group: string, handle: string, entries, isProfile: boolean): string`.
    - Profile: `root/group`.
    - Post with a handle: `root/group/<folder name>`. The folder name is the handle's recorded `name` in that group if it has a folder there, otherwise the handle.
    - Post without a handle: `root/group`.
  - `shortPath(path: string, root: string, home = ""): string`.
    - A path under the root's grandparent is shown relative to it.
    - Otherwise a path under `home` is shown as `~/…`.
    - Otherwise the full path.
    - A trailing slash is ignored.
  - `autoStartReady({ auto, isProfile, scanStatus, urlCount, folderEdited, started }): boolean`.
    - It requires `auto` set, `!folderEdited` and `!started`.
    - For a profile, it also requires `scanStatus === "done"` and `urlCount > 0`.

- [ ] **Step 1: Write the failing tests** (`R = "/srv/archive/media/twitter"`):

```js
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
```

- [ ] **Step 2: Run** `npm test`. Expected: the new tests fail (not exported).
- [ ] **Step 3: Implement the four functions** in `grouping.js`. `folderForTarget` stays until Task 5 removes its last caller; delete it then.
- [ ] **Step 4: Run** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `Download plan, group folders and short paths`.

### Task 5: Host files a post saved in a handle-named folder under its parent

**Files:**
- Modify: `native-host/yt_dlp_host.py` (`remember_downloaded_post`)
- Test: `native-host/test_yt_dlp_host.py` (new class `RememberDownloadedPostTests(HandleStateCase)`)

**Interfaces:**
- Produces: `remember_downloaded_post(url, download_dir)`.
  - When the download folder's last segment equals the author's handle (case-insensitive), or equals a folder name the handle already has in that parent, the host calls `remember_handle(username, [url], base_dir=<parent>, name=<last segment>, replace_folder=True)`.
  - Otherwise it behaves as today.

- [ ] **Step 1: Write the failing tests** (under `self.library`):
  - `test_a_post_in_a_handle_folder_is_filed_under_the_group`: download to `<lib>/group a/alice`; `only_handle()["folders"]` equals `[{"base_dir": "<lib>/group a", "name": "alice", "group": "group a"}]`.
  - `test_a_known_handle_gains_the_new_group`: `remember_handle("alice", [], base_dir="<lib>/group a")`, then a post to `<lib>/group b/alice` → groups `["group a", "group b"]`.
  - `test_a_custom_folder_name_is_kept`: handle `bob` with folder `{base_dir: <lib>/group b, name: "Bob B"}`, then a post to `<lib>/group b/Bob B` → still one folder, name `Bob B`.
  - `test_a_post_in_another_folder_is_recorded_as_before`: a post to `<lib>/misc` for a new handle → `base_dir` `<lib>/misc` (today's behaviour).
- [ ] **Step 2: Run** `cd native-host && python3 -m unittest test_yt_dlp_host.RememberDownloadedPostTests -v`. Expected: the first three fail.
- [ ] **Step 3: Implement** in `remember_downloaded_post`. Use `find_handle(read_handles(), username)` to read the existing folder names, and treat read errors as "no folders".
- [ ] **Step 4: Run** the full `python3 -m unittest`. Expected: pass.
- [ ] **Step 5: Reinstall the host** locally: `./scripts/install_native_host.py --browser chrome`.
- [ ] **Step 6: Commit** `File a post saved in a handle folder under that folder's group`.

### Task 6: Inline player

**Files:**
- Create: `extension/player.js`
- Modify: `extension/download.html` (overlay container `#player` inside `.column-downloads`), `extension/download.css` (overlay styles)
- Modify: `extension/manifest.json` (`"host_permissions": ["file:///*"]`, version `0.11.0`)
- Test: `tests/player.test.js`

**Interfaces:**
- Produces: `fileUrl(path: string): string` → `"file://" + path.split("/").map(encodeURIComponent).join("/")`.
- Produces: `createPlayer({ root: HTMLElement, playerName: string }): { open(items, index, handlers), close() }`.
  - `items` = `[{ path, title, favorite }]`.
  - `handlers` = `{ toggleFavorite(item): Promise<boolean>, remove(item): Promise<boolean>, external(item): void }`. `toggleFavorite` resolves to the new favorite state. `remove` resolves to true when the item was deleted (false when the user declined the confirm).
- Behaviour:
  - Header `@title · n of m` (`title` comes from the caller).
  - `<video controls autoplay muted>` with `src = fileUrl(path)`. `muted` is set on every open and every step.
  - Prev and Next are disabled at the ends.
  - After a successful remove, the item is dropped and the player shows the item now at that index, or the previous one at the end, or closes when none are left.
  - Esc and ✕ close. Closing pauses, removes `src` and calls `load()`.
  - An `error` event on the video shows "Could not play this file." plus the external button.
  - Before the first `open`, check `chrome.extension.isAllowedFileSchemeAccess`. If false, the overlay shows "Turn on “Allow access to file URLs” for this extension in chrome://extensions." and the external button. In tests `chrome` is undefined: treat that as allowed.

- [ ] **Step 1: Write the failing tests** (jsdom; stub `HTMLMediaElement.prototype.pause/load` as no-ops):
  - `fileUrl encodes each segment`: `fileUrl("/srv/a b/#1 ?.mp4")` → `"file:///srv/a%20b/%231%20%3F.mp4"`; `fileUrl("/srv/山田/x%.mp4")` → `"file:///srv/%E5%B1%B1%E7%94%B0/x%25.mp4"`.
  - `the player starts muted on the chosen item`: open 3 items at index 1. The video is `muted`, its `src` ends with the second path, and the header contains `2 of 3`.
  - `next and prev step through and stop at the ends`: from index 0, Prev is disabled; Next → `2 of 3`.
  - `removing a middle video shows the next one; removing the last closes`: with a `remove` stub resolving true, remove at index 1 of 3 shows `2 of 2` with the third path. With 1 item, remove → the overlay is hidden.
  - `a declined remove keeps the video`: `remove` resolves false → still `2 of 3`.
  - `favorite reflects the handler's answer`: the button shows `★` after `toggleFavorite` resolves true.
- [ ] **Step 2: Run** `npm test`. Expected: the new tests fail (no module).
- [ ] **Step 3: Implement `player.js`, the overlay markup and the styles.** Use the overlay sketch in the spec. The buttons are `‹ Prev`, `☆`/`★ Favorite`, `Remove`, `<playerName>` (the external player) and `Next ›`.
- [ ] **Step 4: Run** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `Inline player module`.

### Task 7: Wire the player into downloads and favorites

**Files:**
- Modify: `extension/download.js` (`makeJobActions`, `makeDownloadTile`, `makeDownloadGroup`, `removeDashboardJob`, `favoriteDashboardJob`)
- Modify: `extension/library-views.js` (favorites `makeTile`, `removeFavorite`, `unfavorite`)

**Interfaces:**
- Consumes: `createPlayer`, `fileUrl` from Task 6. `get_config().config.player` gives the player name: the first word of the command, base name only (for example `haruna`).
- Produces: `removeDashboardJob(job, deletes): Promise<boolean>` and `removeFavorite(item): Promise<boolean>` (true when deleted). `favoriteDashboardJob(job): Promise<boolean>` (new state).

- [ ] **Step 1: Downloads pane.**
  - Clicking a completed job's tile picture, or its Play button, opens the player. The item list is that handle group's jobs with `status === "complete" && filename`, in display order, mapped to `{ path: job.filename, title: group.handle || "Other downloads", favorite: job.favorite, job }`.
  - The old Play action becomes a button labelled with the player name that calls `playDashboardJob`.
  - The handlers call `favoriteDashboardJob`, `removeDashboardJob(job, true)` and `playDashboardJob`.
- [ ] **Step 2: Favorites view.**
  - Clicking a tile picture, or the view's Play button, opens the player over that group's existing items (`exists` only). Items are `{ path: item.path, title: item.handle, favorite: true, item }`.
  - The handlers call `unfavorite` (resolves `false`), `removeFavorite` and `fileAction("play_library_file", …)`.
  - The view reloads when the player closes.
- [ ] **Step 3: Run** `npm test`. Expected: pass.
- [ ] **Step 4: Manual check** in Chrome: reload the extension and open the downloads screen.
  - Play a finished download: it starts muted, seeking works and fullscreen works.
  - Next steps through the group. Favorite toggles the tile's star after close.
  - Remove asks for confirmation, then moves to the next video.
  - The Haruna button opens Haruna.
  - The same works from a group's favorites view.
  - A file name with Japanese characters plays.
- [ ] **Step 5: Update README** (Play opens the inline player; the configured player is its own button; "Allow access to file URLs" must be on). Commit `Play downloads and favorites inside the downloads screen`.

### Task 8: Auto-start, group buttons and short paths in the picker

**Files:**
- Create: `extension/picker.js`
- Modify: `extension/download.js` (`applyKnownHandleFolder` → replaced, `applyScanRecord`, `startDownload`, `renderRecentDirectories`, success messages)
- Modify: `extension/download.html` (a "Groups" panel above Recent Folders: `<div id="group-buttons">`)

**Interfaces:**
- Consumes: `downloadPlan`, `groupDirectory`, `shortPath`, `autoStartReady` (Task 4); `get_handles().library_root` and `.groups`; `handlesPanel` `onLoaded(handles, groups, libraryRoot)`. Extend the `onLoaded` callback in `handles.js` to pass all three.
- Produces: `renderGroupButtons(container, { groups, highlight: string[], onPick(group) })` in `picker.js`. It renders nothing (hidden panel) when `groups` is empty.

- [ ] **Step 1: Picker state.** In `download.js`, keep `state.plan`, `state.libraryRoot` and `state.autoStarted`.
  - When the handle list loads, compute `target = batchTargetForUrl(state.targetUrl)`.
  - For an X/Twitter target (`target?.provider === "twitter"`, or a post URL where `jobHandle` gives a handle or a twitter host):
    - `state.plan = downloadPlan(handles, handle, Boolean(target))`;
    - render group buttons with `highlight = state.plan.groups`;
    - call `maybeAutoStart()`.
  - Other providers: hide the Groups panel.
- [ ] **Step 2: `maybeAutoStart()`.**
  - It is called from the handle-list load and from `applyScanRecord` after a `done` record is applied.
  - When `autoStartReady(...)` holds:
    - set `state.autoStarted = true`, `state.partialAcknowledged = true` and the folder field to `plan.auto.directory`;
    - show `Downloading into <group> / <handle>`;
    - call `startDownload(plan.auto.directory)`.
  - `startDownload` already shows the partial warning in its success message.
- [ ] **Step 3: Group button click** → `startDownload(groupDirectory(state.libraryRoot, group, handle, handles, isProfile))`.
- [ ] **Step 4: Short paths.**
  - Recent Folders buttons show `shortPath(dir, state.libraryRoot, home)`, with the full path in `title`. Re-render them when the root arrives.
  - The success messages use `shortPath` too.
  - `home` comes from the host if `get_config` returns it; otherwise skip the `~` rule.
  - Remove `folderForTarget` and its tests now that nothing calls it.
- [ ] **Step 5: Run** `npm test`. Expected: pass.
- [ ] **Step 6: Manual check** in Chrome:
  - A post by a handle with one folder queues at once into `<group>/<handle>`.
  - A profile of such a handle queues when the scan ends.
  - A handle in two groups waits, with both buttons highlighted.
  - A new handle → click `group a` → the file lands in `group a/<handle>/` and the handle list shows it under group a.
  - Typing in the folder field while a profile scan runs stops the auto-start.
  - Recent Folders show short paths.
  - A Facebook reels page shows no Groups panel.
- [ ] **Step 7: Update README** (auto-start, group buttons, short paths). Commit `Start known creators' downloads by themselves; group buttons`.

### Task 9: Check in the downloads pane, favorites chips

**Files:**
- Modify: `extension/handles.js` (return value of `initHandles`; render chips)
- Modify: `extension/download.js` (`makeDownloadGroup`)
- Modify: `extension/download.html` (`<div id="favorite-chips" class="favorite-chips"></div>` above `.handle-tools`), `extension/download.css`
- Test: `tests/grouping.test.js`

**Interfaces:**
- Produces: `initHandles(...)` returns:
  - `refresh()`;
  - `entryFor(handle): entry | null` (case-insensitive, aliases included);
  - `checkHandles(entries)` (existing);
  - `downloadPending(entry, group)` (existing);
  - `markSeen(entry)` (= `simpleAction("mark_handle_seen", entry)`);
  - `isChecking(handle): boolean`.
- Produces: `favoriteChips(counts: Record<string, number>): { group, count }[]` in `grouping.js`: zero counts dropped, sorted by group name case-insensitively.
- Consumes: `onChanged` from `initHandles` must trigger a dashboard re-render (add `onChanged` to `initHandles`' options and call it after `refresh`), so a header updates when a check finishes.

- [ ] **Step 1: Write the failing test**: `favoriteChips({ "group b": 4, "Group a": 12, other: 0 })` → `[{ group: "Group a", count: 12 }, { group: "group b", count: 4 }]`.
- [ ] **Step 2: Run** `npm test`. Expected: it fails.
- [ ] **Step 3: Implement `favoriteChips`** and render the chips in `handles.js` `render()`. Each chip is a button `★ <group> <count>` that calls `onOpenFavorites(group)`, and the container is hidden when the list is empty.
- [ ] **Step 4: Group header in the downloads pane.** In `makeDownloadGroup`, when `handlesPanel.entryFor(group.handle)` exists and is not stale, the summary gets:
  - while checking: a `Check` button (disabled with "Checking…");
  - when `entry.pending_count > 0`: `N new` with `Download` (`downloadPending(entry, entry.group)`) and `Seen` (`markSeen(entry)`);
  - after a check that found nothing: "Nothing new" until the next render cycle without a check result. Keep a `Set` of handles checked in this page session.
  - Buttons call `event.preventDefault()` so the `<details>` does not toggle.
- [ ] **Step 5: Run** `npm test`. Expected: pass.
- [ ] **Step 6: Manual check**:
  - Check on a downloads-pane header runs, then shows `N new` or "Nothing new".
  - Download queues the new videos.
  - The chips open each group's favorites, and the player works there.
- [ ] **Step 7: Update README** (Check in the downloads pane; favorites chips). Commit `Check from the downloads pane; favorites shortcuts per group`.

### Task 10: Final verification

- [ ] **Step 1:** `npm test` and `cd native-host && python3 -m unittest`: all pass.
- [ ] **Step 2:** `git log origin/main..` is empty (everything pushed).
- [ ] **Step 3: Leak check** across the branch's history:
  - `git log -p ccfe016..HEAD` holds no name from `~/.local/state/yt-dlp-browser-host/handles.json` and no library path segment. Script it the way the spec commit was checked: load the handle names and folder names, and grep the patch for them as whole words.
  - Report what the script printed.
