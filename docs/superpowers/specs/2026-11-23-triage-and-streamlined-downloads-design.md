# Triage player and streamlined downloads

Date: 2026-11-23
Status: approved, not yet implemented

## Why

The extension feeds a library of creators' videos sorted into groups
(`<library>/<group>/<handle>/`). Day to day, the work is: download a creator's
new posts, watch them, and decide which are worth keeping. Today that loop
has friction at each step:

- A download from a creator who is already in the library still stops at the
  folder picker, and the picker shows long NAS paths that are hard to read.
- A profile scan reads only the Posts tab, and some videos that the Media tab
  shows never get found.
- The download button only scans a profile from its Media tab.
- Watching a video means opening Haruna, then going back to the dashboard to
  favorite or remove it.
- Checking a creator for new posts and finding a group's favorites both mean
  digging through the handle list, whose groups start collapsed.

## Goals

1. Known creator: the download starts by itself in that creator's folder.
2. New creator: one click on a group button files them under that group.
3. Folder paths are shown short, from the library root's parent folder (for example `media/twitter/…`).
4. Profile scans and handle checks read both the Posts tab and the Media tab.
5. The toolbar button scans a profile from any of its tabs, with identical
   results.
6. Finished downloads and favorites play inside the downloads screen, with
   Favorite, Remove, Prev and Next next to the video.
7. A Check button on each handle in the downloads pane.
8. A favorites shortcut per group at the top of the handle pane.

## Non-goals

- No changes to Facebook reel scanning or Facebook's picker flow, beyond
  what shared code needs. Group buttons and auto-start are X/Twitter only.
- No change to how yt-dlp downloads, the queue, or the archive.
- Haruna stays: the external player remains one click away.
- No transcoding; the player plays what Chrome can play (the H.264/AAC mp4s
  X and Facebook serve).

## Anti-goals

- A download must never start in the wrong place. When the right folder is
  ambiguous, nothing starts and the user chooses.
- Auto-start must not bypass the duplicate prompt or the "you removed this"
  refusal.
- The repo is public: no real group, handle, path or post id in code, tests,
  docs or commits (see `CLAUDE.local.md`). Use `group a`, `alice`, `bob`.

## Approaches considered (player file access)

The one real "how" choice was how the extension page gets the video bytes.

- **A. `file://` URLs from the extension page** (chosen). Tested on
  2026-11-23 in headless Chrome with a throwaway extension: a `<video>` in a
  `chrome-extension://` page plays a local `file://` mp4, including a path
  with spaces and non-ASCII characters, and seeking works. It needs two
  things: `file:///*` in the manifest's `host_permissions` (without it Chrome
  logs "Not allowed to load local resource"), and the extension's
  "Allow access to file URLs" switch on (on by default for the unpacked
  extension in the test; the page must check it, see below). The page must
  be UTF-8 (`download.html` already declares it).
- **B. The host serves files on localhost** with a token and Range support.
  Also tested working. Rejected because A works: B adds a server, a port and
  ~150 lines for no gain.
- **C. Stream bytes over native messaging.** Rejected: host messages are
  capped at 1 MB and seeking would be poor.

Arda picked A, falling back to B only if A failed; it did not.

## Design

### 1. Downloads from a known creator start by themselves

Today `applyKnownHandleFolder` (`extension/download.js`) fills the folder
field for a handle that is in the library and shows "already in your
library", then waits for Start.

New behaviour, decided once the handle list has loaded:

- **Single post from a known handle with exactly one folder:** call
  `startDownload(known.directory)` immediately. The message says where:
  "Downloading into group a / alice".
- **Profile from a known handle with exactly one folder:** remember the
  decision; when the scan reaches `done` with URLs, start the download into
  the handle's base folder (the host adds the handle folder, as today). A
  scan that hit its round limit (`partial`) is queued anyway, without the
  confirm dialog, and the partial warning is shown afterwards.
- **Known handle with more than one folder** (filed under several groups):
  no auto-start. Its groups' buttons are highlighted and the user picks one.
- **Unknown handle, or a non-Twitter URL:** no auto-start; the picker works
  as today plus the group buttons.
- Typing in the folder field before the auto-start fires cancels it
  (`folderEdited`, which exists today).
- The duplicate prompt, the removed-video refusal and the missing-folder
  handling all still run, since auto-start goes through `startDownload`.

### 2. Group buttons

A "Groups" panel in the picker column lists one button per group from
`get_handles().groups` (already returned by the host). The panel is shown
only for X/Twitter targets (a post or a profile): `library_root` is the
X/Twitter tree, and other sites keep their own folders next to it
(`<library_root>/../<site>/…`), so Facebook and other URLs keep today's
picker (folder field, Choose Folder, Recent Folders) unchanged. *(Builder
check; Claude's call.)* Clicking group `G`:

- **Twitter post:** downloads into `<library_root>/<G>/<folder>/`, where
  `folder` is the handle's recorded folder name in `G` if it has one there,
  otherwise the post's author (`jobHandle`). The handle is recorded under
  group `G`.
- **Twitter profile batch:** downloads with base folder `<library_root>/<G>`;
  the host adds the handle's folder, as today.

For a handle that is already in the library, a group click into a group it
is not filed under adds that group as an extra folder (the existing
multi-group behaviour of profile batches; single posts must do the same,
see the host change below). Such a handle then has several folders and
stops auto-starting, which is correct: its next download has two valid
places. Re-filing a creator elsewhere (moving, not adding) stays with Edit
in the handle list. *(Builder check; Claude's call.)*

A known handle with one folder auto-starts as soon as the handle list
loads, so the picker offers no chance to file that one post elsewhere. That
is intended: the request was "start automatically in the previously
selected group". *(Builder check; Claude's call.)*

`library_root` comes from `get_handles().library_root`.

Host change needed: `remember_downloaded_post` records a single post's
download folder as the handle's `base_dir`. For the new layout it must
record the **parent** as `base_dir` and the folder's name as `name` when the
folder's last segment equals the handle (case-insensitive) or one of the
handle's recorded folder names. Otherwise a new handle filed through a group
button would get the group `group a/alice`. In that case it also adds the
folder when the handle has none in that base yet (like a profile batch's
`replace_folder=True`), so a group click files a known handle there too.
Existing behaviour for folders that are not named after the handle stays.

Recent Folders stays below the group buttons.

### 3. Short paths

Every folder path the picker shows (Recent Folders, the auto-start message,
the success message) is displayed relative to the library root's
grandparent. With a root of `/srv/archive/media/twitter` (placeholder),
`/srv/archive/media/twitter/group a/alice` shows as `media/twitter/group a/alice`.
A path outside that prefix is shown with `~` for the home directory, or in
full. The full path stays in the button's tooltip and is what gets sent to
the host. One pure helper (`shortPath(path, root)`) in `grouping.js`, with
tests.

### 4. Posts and Media both

A Twitter scan reads the Posts tab (`/<handle>`), then the Media tab
(`/<handle>/media`), in the same tab, and merges the URLs (deduplicated by
canonical status URL). Reasons Media finds what Posts misses include the
creator's replies with video (not on Posts) and sensitive posts shown behind
a warning with no video element; the Media grid's cells are matched by the
existing plain-anchor branch of `collectVisibleLinks`.

- **Toolbar scan** (`scanProfileTab`/`runProfileScan` in `background.js`):
  run the scan on Posts, then navigate to Media and scan again, carrying the
  found URLs forward. Progress keeps reporting the combined count. When both
  passes end, the tab goes back to the URL it was on when the button was
  pressed, and its scroll position on that page is restored if it was Posts or
  Media. `partial` is true if either pass hit its limit.
- **Handle checks** (`checkHandle`): the background tab scans Posts with
  `stopAtId`, then Media with the same `stopAtId`. `newestId` is the larger
  of the two; `complete` is true only if both passes were complete. Each
  pass keeps its own round limit, so a check can take up to twice as long.
- A pass that fails because the profile is gone stops the whole scan with
  `gone`, as today. A Media pass that fails for another reason after Posts
  succeeded returns the Posts results with `partial: true`.
- `profileScanChunk` already accepts both `/<handle>` and `/<handle>/media`
  as the scanned page. But its Media-grid branch (plain anchors outside
  `article`) never calls `notePostPosition`, so a Media pass would never
  set `newestId` or `reachedStop`, never count as complete, and checks
  would never advance `checked_through`. The grid branch must track post
  ids and the stop point too, for every grid cell owned by the profile
  (video or not), since the Media tab is newest-first with no pinned posts
  or reposts. *(Builder check; Claude's call.)*

### 5. Any profile tab

`twitterProfileMediaUsername` (extension `providers.js`) and its host twin
`twitter_profile_media_username` (`yt_dlp_host.py`) only accept
`/<handle>/media`. Widen the extension side to accept a profile page in any
of these forms:

`/<handle>`, `/<handle>/media`, `/<handle>/with_replies`,
`/<handle>/highlights`, `/<handle>/articles`, `/<handle>/likes`

The batch target's canonical URL stays `https://x.com/<handle>/media`: the
picker gets that URL, so the host and its validation are unchanged. The
reserved-route list grows to cover X's own top-level pages that look like a
handle (`search`, `compose`, `explore`, `home`, `notifications`, `messages`,
`i`, `settings`, `jobs`, `lists`, `bookmarks`, `communities`, `premium`,
`tos`, `privacy`, `login`, `signup`, `logout`, …), in both the extension and
the host lists, which must stay identical. A status URL is never a profile.

Profile scans start only from the page itself: the toolbar button, or the
context menu on the page. A right-clicked **link** to a profile (an author
name in a timeline) is not a batch target, since a scan drives the current
tab and would navigate it away. In `openDownloadPicker`, a context-menu
`linkUrl` that is a profile URL opens the picker with an error ("Open the
profile and use the toolbar button there"), as the picker already does for
a batch URL with no scan. The wider profile matching therefore applies to
the page URL only; `batchTargetForUrl` takes that as a parameter or a
second function covers links. *(Builder check; Claude's call.)*

### 6. Inline player

New module `extension/player.js`; `download.js` and `library-views.js` call
it. It opens an overlay over the downloads column:

```
┌──────────── @alice · 3 of 12 ───────────── ✕ ┐
│                [ video, muted ]              │
│  ▶ ━━━━━━●──────── 0:14 / 0:42  🔇  ⛶        │
├──────────────────────────────────────────────┤
│  ‹ Prev   ☆ Favorite   Remove   Haruna   Next ›│
└──────────────────────────────────────────────┘
```

- `<video controls autoplay muted>`: Chrome's own play/pause, seek, volume,
  mute, fullscreen and picture-in-picture. Every video starts muted (each
  time, not remembered).
- Source: `file://` + the absolute path, each path segment encoded with
  `encodeURIComponent` (so `#`, `?` and `%` in file names survive). Jobs give
  `job.filename`; favorites give `item.path`.
- **Opening it:** clicking a finished download's tile or its Play button.
  The current Play-in-Haruna action becomes the **Haruna** button (labelled
  with the configured player's name) in the item actions and in the player.
- **List it steps through:** in the downloads pane, the finished downloads of
  that handle group, in display order; in the favorites view, that group's
  favorites in display order. Header shows `@handle · n of m`.
- **Favorite** toggles via `set_favorite` (by `job_id` or `relative`, as the
  callers do today). **Remove** uses the existing remove path (downloads:
  `remove_download`; favorites: the view's remove) with its existing
  confirmation, then moves to the next video, or closes if none is left.
- **Keys:** Esc closes; ← / → are left to the video element (seek); Prev
  and Next are buttons only. Closing pauses and unloads the video.
- **No file access:** before the first play, check
  `chrome.extension.isAllowedFileSchemeAccess()`. If false, the overlay
  shows: "Turn on 'Allow access to file URLs' for this extension in
  chrome://extensions", with the Haruna button still working. A video that
  fails to load (moved, deleted, unsupported codec) shows the error in the
  overlay with the Haruna button.
- Manifest: add `"host_permissions": ["file:///*"]`. The version bumps.

### 7. Check in the downloads pane

Each handle group header in the downloads pane (`makeDownloadGroup`) gets a
**Check** button when that handle is in the handle list and not stale. It
runs the same check as the handle list's Check (`checkOne` in `handles.js`,
exposed from `initHandles`). While running it shows "Checking…"; afterwards
the header shows `N new` with **Download** and **Seen** buttons (the handle
list's actions), or "Nothing new". The handle list refreshes as usual.

### 8. Favorites shortcut

A row of chips at the top of the handle pane, above the search box, one per
group that has favorites: `★ group a 12 · ★ group b 4`, from the counts
`get_favorites` already returns. Clicking a chip opens that group's
favorites view in the middle pane (`onOpenFavorites`). The row is hidden
when there are no favorites. The existing "★ Favorites" row inside each
group stays.

## Constraints

- Plain ES modules, no build step; tests with `npm test` (jsdom) and
  `python3 -m unittest` in `native-host/`.
- `download.js` is already ~1300 lines: new UI goes in its own modules
  (`player.js`, and the picker's group/auto-start code may move to
  `picker.js`); pure helpers go in `grouping.js` or `providers.js` with tests.
- The extension and host reserved-route lists must match (an existing test
  or a new one should compare them).
- README is updated for every user-visible change.

## Left to the builder

- Exact styling of the player overlay, group buttons and favorites chips,
  following `download.css`.
- How the Posts→Media sequence is structured inside `background.js`, as long
  as the behaviour above holds and the service worker keeps getting API
  responses during long scans (the existing chunking).
- Whether auto-start/group code lives in `download.js` or a new
  `picker.js`.
- Test coverage beyond: profile URL recognition for every tab form and the
  reserved routes, `shortPath`, the file URL encoder, the auto-start decision
  (known/one folder, known/several, unknown), the host's
  `remember_downloaded_post` parent rule, and the merged Posts+Media result.
