# Facebook Reels profile downloads

Date: 2026-07-26
Status: approved, not yet implemented

## Goal

Support batch-downloading a Facebook profile's reels the same way the extension
already batches an X/Twitter profile's media. Given a profile reels URL, scan
the loaded page for reel permalinks, queue them one at a time, and save them
into a folder named after the profile's display name.

## Motivating example

```text
https://www.facebook.com/profile.php?id=61590939736806&sk=reels_tab
```

## Why scraping is required

`yt-dlp` 2026.07.04 resolves a single reel through the `facebook:reel`
extractor (`facebook.com/reel/<digits>`), but no extractor matches a profile
reels tab — `profile.php?id=...&sk=reels_tab` and `/<page>/reels` both fall
through to the generic extractor. Verified with `gen_extractors()`:

```text
facebook.com/profile.php?id=...&sk=reels_tab -> no extractor
facebook.com/somepage/reels                  -> no extractor
facebook.com/reel/1234567890                 -> facebook:reel
```

So the extension must enumerate reel permalinks from the rendered page and hand
individual reel URLs to the host, exactly as the Twitter flow does.

## Approach: a small provider table

Only four things differ per site. Everything else in the batch pipeline is
already site-agnostic and does not move: chunked scanning, the scan watchdog,
session-storage progress records, scroll restore, partial-scan consent,
duplicate filtering, per-batch folders, and the download queue.

| Concern | Twitter | Facebook |
|---|---|---|
| Hosts | `x.com`, `www.x.com`, `twitter.com`, `www.twitter.com`, `mobile.twitter.com` | `facebook.com`, `www.facebook.com`, `m.facebook.com`, `web.facebook.com` |
| Batch URL to key | `/<user>/media` -> handle | `profile.php?id=<digits>` with `sk=reels_tab` -> id; `/<page>/reels` -> page |
| Item URL | `/<user>/status/<digits>` | `/reel/<digits>` |
| Folder name source | the handle, present in the URL | display name scraped from the page |

Rejected alternatives:

- **Parallel Facebook path.** Duplicates the whole scan pipeline, grows the host
  from 1866 to roughly 2200 lines, and invites the drift already observed this
  week, where the reserved-username list existed in the host but not in the
  three JavaScript validators.
- **Splitting the host into modules.** `scripts/install_native_host.py` copies
  exactly one file, so this changes the install story. Worth doing, but not
  bundled with a feature.

## Host changes (`native-host/yt_dlp_host.py`)

Introduce a module-level provider table. Each entry declares its hosts, its
canonical host, a batch-target matcher, an item-URL validator and canonicaliser,
and an output template.

Three existing Twitter-specific pieces become provider lookups:

- `is_twitter_url()`, used only to choose the output template, becomes
  `provider_for_url()`; the template comes from the provider entry.
- `normalize_url()` keeps its generic work (scheme check, fragment strip,
  trailing-slash strip) and delegates site canonicalisation to the provider.
- `twitter_profile_media_username()` becomes `batch_target_for_url()`, returning
  the provider name plus a key, or `None`.

Facebook canonicalisation reduces an item URL to
`https://www.facebook.com/reel/<digits>`, dropping **all** query parameters.
Facebook appends tracking parameters such as `?fs=e&s=TIeo`; without stripping
them, duplicate detection silently fails and the same reel downloads repeatedly.

Reserved first-path segments that must never be treated as a vanity page:
`reel`, `reels`, `watch`, `groups`, `marketplace`, `events`, `pages`,
`profile.php`, `story.php`, `photo`, `share`, `people`, `login`, `settings`,
`messages`, `notifications`.

Both providers use the existing short output template
`%(uploader_id,uploader|unknown-account)S-%(id)s.%(ext)s`, because reel captions
run long for the same reason tweet text does.

### Ownership verification is not available for Facebook

A Twitter status URL contains the account (`x.com/alice/status/123`), so the host
independently rejects a scraped URL belonging to someone else. That is how the
quoted-post leak was fixed.

A Facebook reel URL is only `facebook.com/reel/1234567890` — the uploader does
not appear. The host therefore validates *shape* only, and cannot confirm a
scraped reel belongs to the scanned profile.

Accepted mitigation: scope the scraper tightly (below) and accept the residual
risk. The blast radius is a misfiled video in a personal download folder, not a
disclosure. Post-hoc verification against yt-dlp's reported `uploader_id` is
explicitly out of scope until a stray file is actually observed.

## Extension changes (`extension/`)

The provider supplies only the per-page link collector and the display-name
extractor. The scan orchestration is unchanged.

The injected scanner must remain a **single closure-free function**, because
`chrome.scripting.executeScript` serialises it. Both collectors live inside that
one function and switch on a provider name passed through `args`.

### Facebook collector, tightly scoped

Facebook's markup is obfuscated with randomised class names, so there is no
equivalent of Twitter's `data-testid` anchors. The most stable available signals
are the ARIA landmark and the href shape:

1. Root the search at `[role="main"]`.
2. Exclude anchors under `[role="complementary"]`.
3. Exclude anchors whose nearest ancestor `section`, `[role="region"]` or
   heading-bearing container — searched upwards, stopping at `[role="main"]` —
   has heading text matching suggestion wording ("Suggested", "People also
   watched", "Reels for you"). Matching is case-insensitive. If no such ancestor
   exists before reaching `[role="main"]`, the anchor is kept.
4. Accept an anchor only when its pathname matches `^/reel/(\d+)/?$`.
5. Deduplicate by reel id.

This is more fragile than the Twitter collector and will need adjustment when
Facebook reshuffles their DOM. The failure mode is under-collection, which is
the safe direction.

### Display name extraction

In order, first match wins:

1. `meta[property="og:title"]` content
2. `[role="main"] h1` text
3. `document.title`, stripping a leading `(N+) ` notification count and a
   trailing ` | Facebook`
4. fall back to the batch key (numeric id or vanity name)

## Message contract change

The `download` message gains an optional `profile_name` string. The host
resolves the batch folder as:

```text
base_download_dir / safe_path_part(profile_name or batch_key)
```

Twitter continues to pass no `profile_name`, so its folder remains the handle.

## The sanitizer becomes a trust boundary

Today the folder name derives from a URL path segment already validated against
`[A-Za-z0-9_]{1,15}`. After this change it derives from **scraped page content**,
which a hostile page controls. `safe_path_part` is therefore security-relevant,
not cosmetic.

Requirements:

- NFC-normalise the input.
- Preserve Unicode letters and digits, so Japanese and other non-ASCII names
  survive. The current sanitizer strips every non-ASCII character, leaving an
  empty string, and then applies a hardcoded fallback. Verified against the
  current code:

  ```text
  safe_path_part('ネコ動画')        -> 'twitter-profile'
  safe_path_part('../../etc/passwd') -> 'etc_passwd'
  ```

  So a Japanese-named Facebook page would land in a folder called
  `twitter-profile`. The Twitter-specific fallback string is itself a reason the
  provider refactor is needed: the fallback must become the batch key. The
  traversal case is already safe and must stay that way.
- Strip path separators, `..`, NUL, and control characters. A name must never
  escape the base download directory.
- Strip characters that are illegal or hostile on common filesystems:
  `/ \ : * ? " < > |`.
- Strip leading dots and trailing dots, spaces and underscores.
- Cap at 255 **UTF-8 bytes**, not characters. ext4's limit is in bytes and
  Japanese characters occupy three bytes each, so a character cap would allow an
  over-long name. Truncation must fall on a character boundary and must not
  split a multi-byte sequence.
- Fall back to the batch key when the result is empty.

The batch key is the bare identifier — the numeric id for the `profile.php`
form, the vanity segment for the `/<page>/reels` form — with no provider prefix.
The provider name is tracked separately and disambiguates keys across sites.

## Error handling

Reuses existing paths unless noted:

| Condition | Behaviour |
|---|---|
| No reels found | Existing empty-scan message |
| Scan hit its round limit | Existing partial-scan consent prompt |
| Display name not found | Silent fallback to the batch key |
| Scraped URL is not a reel | Rejected host-side, counted in `rejected_count` |
| Reel already queued/running/complete | Existing duplicate prompt |
| Logged out of Facebook | Facebook serves a login wall and the scan finds nothing. Message must say the profile may require signing in, rather than the generic "no video links found". |

## Testing

The repository currently has no committed tests. This work adds them, and the
order matters.

**Twitter regression tests are written and committed first**, against current
behaviour, so the provider refactor has a net before it touches anything.

Python (`python3 -m unittest`):

- Per-provider URL canonicalisation, including the Facebook tracking-parameter
  strip and the existing Twitter `/`, `/photo/N`, `?s=` cases.
- Batch matching for both providers, including reserved segments and the two
  Facebook URL forms.
- Item validation, including Twitter's username-match rejection.
- `safe_path_part`: Japanese, emoji, the 255-byte cap, empty-result fallback,
  and traversal attempts such as `../../etc/passwd`.

JavaScript (`node --test`, jsdom):

- Both collectors against fixtures. The Facebook fixture deliberately includes a
  suggested-reels sidebar and a `[role="complementary"]` block to prove the tight
  scoping excludes them.
- Existing Twitter scraper fixtures, to prove no regression.

## Out of scope

- The Facebook videos tab (`/<page>/videos`, `sk=videos`), which mixes long-form
  uploads, live replays and cross-posts.
- Post-hoc uploader verification for Facebook reels.
- Migrating native messaging to a persistent `connectNative` port.
- Splitting the host into modules.
