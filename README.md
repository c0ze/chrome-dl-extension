# Twitter Video Downloader Bridge

This project contains a Chrome extension plus a Linux native messaging host
that sends X/Twitter and Facebook reel URLs to `yt-dlp` on your machine.

The extension does not download anything by itself. It forwards a URL to a
local Python host, and that host runs:

```text
yt-dlp --cookies-from-browser chrome <url>
```

The default download directory is `~/Downloads`.

## What is included

- `extension/`: unpacked Chrome extension (Manifest V3)
- `native-host/yt_dlp_host.py`: native messaging host launched by Chrome
- `scripts/install_native_host.py`: installer for the native host manifest and
  default config

## Setup

1. Make sure `yt-dlp` is installed and available in your `PATH`.
   Install `zenity` or `kdialog` if you want the download page's folder
   picker button to open a native directory chooser.
2. Run the installer:

```bash
./scripts/install_native_host.py --browser chrome
```

3. Open `chrome://extensions`.
4. Turn on Developer mode.
5. Click Load unpacked and select the `extension/` folder in this repo.
6. Optional: open the extension's Options page to adjust the download
   directory, cookie browser, profile, or extra `yt-dlp` args.

The extension uses a fixed development ID:

```text
ojidoilcncppmdfdnkocofenaleogbpf
```

That lets the installer register the native host before or after the extension
is loaded.

## Usage

- Open an X/Twitter post and click the extension button to send the current tab
  URL to a small folder picker, then start `yt-dlp`.
- Open an X/Twitter profile media URL, such as `https://x.com/username/media`,
  and click the extension button to scan the loaded page for video post links.
  The picker window opens immediately and reports scan progress while it runs;
  the page is scrolled automatically and returned to its original position when
  the scan ends. The host queues those videos one by one and downloads them into
  a `username/` folder inside the selected target folder.
- A scan that hits its round limit is reported as partial, and starting a
  partial download asks for confirmation first. Scroll the media page further
  and use `Scan Again` to pick up older posts.
- Reserved X/Twitter routes are never treated as profile batches, by either the
  extension or the host: `home`, `explore`, `notifications`, `messages`, `i`,
  and `settings`. A URL such as `https://x.com/home/media` is queued as a single
  ordinary download instead.
- Open a Facebook profile's reels tab and click the extension button to scan
  it the same way. Two URL forms are recognised, across the `www`, `m`, and
  `web` subdomains: `facebook.com/profile.php?id=<digits>&sk=reels_tab` and
  `facebook.com/<pagename>/reels`. The profile's videos tab is not supported,
  since it mixes long-form uploads, live replays, and cross-posts that do not
  belong in a reel-only batch.
- A Facebook batch folder is named after the profile's display name, scraped
  from the page rather than the URL, since a vanity page name or numeric id is
  not the profile's real name. Japanese and other non-ASCII names are
  preserved. When no usable name can be scraped, the folder falls back to the
  numeric profile id or the vanity page name instead.
- Facebook only shows profile reels to signed-in users. If you are signed out,
  the scan finds nothing and the picker says so specifically, rather than
  reporting the generic "no video links found" message.
- Or right-click a page or link and choose `Download with yt-dlp`, then pick a
  folder.
- The download page shows a dashboard with queued, running, completed, failed,
  and cancelled downloads. Downloads are processed one at a time. When the list
  is longer than the dashboard shows, it reports how many items exist in total.
- Use `Start` or `Retry` on a dashboard item to force it to the front of the
  queue when no other download is running. Failed and cancelled items can both
  be retried.
- Use `Cancel` on a running download to stop it. The host terminates `yt-dlp`
  and starts the next queued download.
- Use `Folder` on a dashboard item to open the containing folder. Completed
  downloads use the final filename reported by `yt-dlp`; otherwise the selected
  download folder is opened.
- Use `Remove` or `Remove All` to clear finished items from the dashboard.
  Running downloads are kept.
- If a download is interrupted because its worker process died, for example on
  reboot or if the process was killed, the host detects this on the next
  dashboard refresh, marks the job `Interrupted`, and resumes the queue.
- If a URL is already queued, running, or completed in the dashboard, the
  extension asks before queueing a duplicate. Profile media scans use the same
  duplicate check for every discovered video URL. Cancelled downloads do not
  count as duplicates, so a cancelled URL can be queued again without a prompt.
- The native host uses `notify-send` to show start and finish notifications.
- The picker remembers your last 10 folder paths in Chrome extension storage for
  quick reuse.

## Config

The installer writes the host config to:

```text
~/.local/share/yt-dlp-browser-host/config.json
```

Default config:

```json
{
  "browser": "chrome",
  "keyring": "",
  "profile": "",
  "download_dir": "~/Downloads",
  "yt_dlp_path": "yt-dlp",
  "extra_args": []
}
```

You can edit that file manually or use the extension options page.

### Cookie decryption failures on Linux

If the log says `cannot decrypt v11 cookies: no key found`, yt-dlp can lose your
signed-in session even though Chrome is signed in. X may then return
`No video could be found in this tweet`. Failed downloads retain cookie
diagnostics in the dashboard alongside the final extractor error.

Set **Cookie keyring** in Options to the store Chrome actually uses. For
Hyprland with GNOME Keyring this is `gnomekeyring`; automatic desktop detection
can incorrectly choose `basictext`. The default empty `keyring` value retains
yt-dlp's automatic detection. Explicit alternatives are `basictext`,
`gnomekeyring`, `kwallet`, `kwallet5`, and `kwallet6`. Firefox ignores this field.
The host passes it as `chrome+gnomekeyring:Profile 1` when a profile is selected.

GNOME Keyring also requires `SecretStorage` in the **same Python environment as
yt-dlp**, not merely the Python running the native host. Install the corresponding
distribution package, or use a dedicated environment (with `uv` installed):

```bash
uv venv ~/.local/share/yt-dlp-browser-host/venv
uv pip install --python ~/.local/share/yt-dlp-browser-host/venv/bin/python 'yt-dlp[default]' SecretStorage
```

Then set **yt-dlp path** in Options to the full absolute path of
`~/.local/share/yt-dlp-browser-host/venv/bin/yt-dlp` (expand `~` to your home
directory), select the correct keyring and profile, and retry the failed job.
See [yt-dlp's cookie options and dependencies](https://github.com/yt-dlp/yt-dlp).

## Native Host Locations

- Installed host script:
  `~/.local/share/yt-dlp-browser-host/yt_dlp_host.py`
- Installed native messaging manifest for Chrome:
  `~/.config/google-chrome/NativeMessagingHosts/dev.arda.ytdlp_host.json`
- Dashboard queue/history:
  `~/.local/state/yt-dlp-browser-host/downloads.json`
- Queue lock file:
  `~/.local/state/yt-dlp-browser-host/downloads.lock`
- Log file:
  `~/.local/state/yt-dlp-browser-host/host.log`
- Rotated previous log:
  `~/.local/state/yt-dlp-browser-host/host.log.1`

Queued and running jobs are retained up to a cap of 1000 queued jobs; beyond
that new downloads are rejected until the queue drains. Finished dashboard
history is capped at 40 jobs. A single profile scan queues at most 500 videos.
The log is rotated when it reaches 5 MB, keeping one previous backup, so regular
use should stay around 10 MB of native-host logs. The extension also stores only
the last 10 folder paths in Chrome local extension storage.

Config, state, and log files are created with mode 0600, and their directories
with 0700.

## Notes

- The host only accepts `http://` and `https://` URLs.
- For X/Twitter URLs it strips query strings and fragments before calling
  `yt-dlp`, and reduces a status URL to `/<user>/status/<id>` so that trailing
  slashes and `/photo/N` or `/video/N` suffixes are recognised as the same
  video rather than downloaded twice.
- Video links discovered by a profile scan are re-validated by the host: each
  one must be a status URL belonging to the profile being scanned, so a quoted
  post from another account is not queued.
- Facebook reel URLs are canonicalised to `https://www.facebook.com/reel/<id>`
  before being queued, with any query string dropped, so tracking parameters
  such as `?fs=e&s=...` do not defeat duplicate detection and the same reel is
  not downloaded twice. This differs from an ordinary Facebook video URL that
  carries its id in the query string, such as `/watch/?v=<id>`: that query
  string is kept, since it is the only place the id appears.
- The host validates that every scraped Facebook URL has the shape of a reel
  permalink, but it cannot confirm a reel belongs to the profile that was
  scanned, unlike Twitter: a Facebook reel URL is just
  `facebook.com/reel/<id>`, with no uploader in it. The only defence against
  collecting a reel that isn't the profile's own is the collector's DOM
  scoping in the scanned page, which is heuristic and biased toward collecting
  too few reels rather than too many. A Facebook markup change can make the
  scan under-collect, and in principle a stray reel from elsewhere on the page
  could still slip through.
- Credentials are redacted from the log and from desktop notifications. URLs
  themselves are logged, since the log records what was downloaded.
- X/Twitter and Facebook downloads use the filename template
  `%(uploader_id,uploader|unknown-account)S-%(id)s.%(ext)s` to avoid very long
  filenames from tweet text or reel captions.
- Cookie access depends on `yt-dlp` being able to read your chosen browser
  profile on Linux.

## Development

Tests need Node and a one-time `npm install` (jsdom is a test-only dependency;
the extension itself requires no build step).

```bash
npm install
npm test                                    # extension scraper tests
cd native-host && python3 -m unittest       # native host tests
```
