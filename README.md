# Twitter Video Downloader Bridge

This project contains a Chrome extension plus a Linux native messaging host
that sends X/Twitter URLs to `yt-dlp` on your machine.

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
- Or right-click a page or link and choose `Download with yt-dlp`, then pick a
  folder.
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
  "profile": "",
  "download_dir": "~/Downloads",
  "yt_dlp_path": "yt-dlp",
  "extra_args": []
}
```

You can edit that file manually or use the extension options page.

## Native Host Locations

- Installed host script:
  `~/.local/share/yt-dlp-browser-host/yt_dlp_host.py`
- Installed native messaging manifest for Chrome:
  `~/.config/google-chrome/NativeMessagingHosts/dev.arda.ytdlp_host.json`
- Log file:
  `~/.local/state/yt-dlp-browser-host/host.log`

## Notes

- The host only accepts `http://` and `https://` URLs.
- For X/Twitter URLs it strips query strings and fragments before calling
  `yt-dlp`.
- X/Twitter downloads use the filename template
  `%(uploader_id,uploader|unknown-account)S-%(id)s.%(ext)s` to avoid very long
  filenames from tweet text.
- Cookie access depends on `yt-dlp` being able to read your chosen browser
  profile on Linux.
