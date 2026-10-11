#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import stat
from pathlib import Path

HOST_NAME = "dev.arda.ytdlp_host"
INSTALL_DIR = Path.home() / ".local" / "share" / "yt-dlp-browser-host"
CONFIG_PATH = INSTALL_DIR / "config.json"
HOST_SCRIPT_PATH = INSTALL_DIR / "yt_dlp_host.py"
DEFAULT_CONFIG = {
    "browser": "chrome",
    "profile": "",
    "download_dir": "~/Downloads",
    "yt_dlp_path": "yt-dlp",
    "extra_args": [],
}
NATIVE_HOST_DIRS = {
    "chrome": Path.home() / ".config" / "google-chrome" / "NativeMessagingHosts",
    "chromium": Path.home() / ".config" / "chromium" / "NativeMessagingHosts",
    "brave": Path.home() / ".config" / "BraveSoftware" / "Brave-Browser" / "NativeMessagingHosts",
    "edge": Path.home() / ".config" / "microsoft-edge" / "NativeMessagingHosts",
}


def compute_extension_id(manifest_path: Path) -> str:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    key = manifest.get("key")
    if not key:
        raise RuntimeError("extension/manifest.json is missing its key field.")

    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(char, 16)) for char in digest)


def merge_config(existing: dict | None, args: argparse.Namespace) -> dict:
    config = DEFAULT_CONFIG.copy()
    if existing:
        config.update(existing)

    if args.download_dir is not None:
        config["download_dir"] = args.download_dir
    if args.cookies_browser is not None:
        config["browser"] = args.cookies_browser
    if args.cookies_profile is not None:
        config["profile"] = args.cookies_profile
    if args.yt_dlp_path is not None:
        config["yt_dlp_path"] = args.yt_dlp_path
    if args.extra_arg is not None:
        config["extra_args"] = args.extra_arg

    return config


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def ensure_install_dir() -> None:
    # The config can hold credentials in extra_args, so match the host's
    # private modes: 0700 for the directory and 0600 for the config.
    INSTALL_DIR.mkdir(parents=True, exist_ok=True)
    INSTALL_DIR.chmod(0o700)


def write_private_json(path: Path, payload: dict) -> None:
    ensure_install_dir()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, indent=2) + "\n")


def install_host_script(source_path: Path) -> None:
    ensure_install_dir()
    shutil.copy2(source_path, HOST_SCRIPT_PATH)
    current_mode = HOST_SCRIPT_PATH.stat().st_mode
    HOST_SCRIPT_PATH.chmod(current_mode | stat.S_IXUSR)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Install the native messaging host for the yt-dlp Chrome bridge."
    )
    parser.add_argument(
        "--browser",
        default="chrome",
        choices=sorted(NATIVE_HOST_DIRS),
        help="Browser whose NativeMessagingHosts directory should be configured.",
    )
    parser.add_argument("--download-dir", help="Default yt-dlp destination directory.")
    parser.add_argument(
        "--cookies-browser",
        choices=["chrome", "chromium", "brave", "edge", "firefox"],
        help="Browser to pass to --cookies-from-browser.",
    )
    parser.add_argument("--cookies-profile", help="Profile name for --cookies-from-browser.")
    parser.add_argument("--yt-dlp-path", help="Executable path for yt-dlp.")
    parser.add_argument(
        "--extra-arg",
        action="append",
        help="Extra yt-dlp argument. Repeat for multiple values.",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    manifest_path = repo_root / "extension" / "manifest.json"
    source_host_path = repo_root / "native-host" / "yt_dlp_host.py"
    extension_id = compute_extension_id(manifest_path)

    install_host_script(source_host_path)

    existing_config = None
    if CONFIG_PATH.exists():
        existing_config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))

    config = merge_config(existing_config, args)
    write_private_json(CONFIG_PATH, config)

    native_host_dir = NATIVE_HOST_DIRS[args.browser]
    native_host_manifest_path = native_host_dir / f"{HOST_NAME}.json"
    native_host_manifest = {
        "name": HOST_NAME,
        "description": "Native host for the yt-dlp Chrome bridge",
        "path": str(HOST_SCRIPT_PATH),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }
    write_json(native_host_manifest_path, native_host_manifest)

    print(f"Browser: {args.browser}")
    print(f"Extension ID: {extension_id}")
    print(f"Load this folder in Chrome: {repo_root / 'extension'}")
    print(f"Native host manifest: {native_host_manifest_path}")
    print(f"Installed host script: {HOST_SCRIPT_PATH}")
    print(f"Host config: {CONFIG_PATH}")
    print()
    print("Next steps:")
    print("  1. Load the extension from chrome://extensions")
    print("  2. Open the extension options page if you want to tweak config")
    print("  3. Click the toolbar button or right-click a page/link and choose Download with yt-dlp")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
