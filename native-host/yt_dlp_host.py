#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import os
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

HOST_NAME = "dev.arda.ytdlp_host"
APP_DIR = Path.home() / ".local" / "share" / "yt-dlp-browser-host"
STATE_DIR = Path.home() / ".local" / "state" / "yt-dlp-browser-host"
CONFIG_PATH = APP_DIR / "config.json"
LOG_PATH = STATE_DIR / "host.log"
DEFAULT_CONFIG = {
    "browser": "chrome",
    "profile": "",
    "download_dir": "~/Downloads",
    "yt_dlp_path": "yt-dlp",
    "extra_args": [],
}
VALID_BROWSERS = {"chrome", "chromium", "brave", "edge", "firefox"}
TWITTER_HOSTS = {
    "twitter.com",
    "www.twitter.com",
    "mobile.twitter.com",
    "x.com",
    "www.x.com",
}
TWITTER_OUTPUT_TEMPLATE = "%(uploader_id,uploader|unknown-account)S-%(id)s.%(ext)s"


def ensure_state() -> None:
    try:
        APP_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass


def log_line(message: str) -> None:
    ensure_state()
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(f"[{timestamp}] {message}\n")
    except OSError:
        pass


def read_message() -> dict[str, Any] | None:
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    if len(raw_length) != 4:
        raise RuntimeError("Incomplete native message length header.")

    message_length = struct.unpack("<I", raw_length)[0]
    payload = sys.stdin.buffer.read(message_length)
    if len(payload) != message_length:
        raise RuntimeError("Incomplete native message body.")

    return json.loads(payload.decode("utf-8"))


def send_message(payload: dict[str, Any]) -> None:
    encoded = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def notify(summary: str, body: str) -> None:
    try:
        subprocess.run(
            ["notify-send", summary, body],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        return


def normalize_url(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Only http(s) URLs are supported.")

    hostname = (parsed.hostname or "").lower()
    parsed = parsed._replace(fragment="")
    if hostname in TWITTER_HOSTS:
        parsed = parsed._replace(query="")

    return urlunparse(parsed)


def is_twitter_url(raw_url: str) -> bool:
    parsed = urlparse(raw_url)
    return (parsed.hostname or "").lower() in TWITTER_HOSTS


def config_for_response(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "browser": config["browser"],
        "profile": config["profile"],
        "download_dir": config["download_dir"],
        "yt_dlp_path": config["yt_dlp_path"],
        "extra_args": list(config["extra_args"]),
    }


def normalize_config(candidate: dict[str, Any]) -> dict[str, Any]:
    config = DEFAULT_CONFIG.copy()
    config.update(candidate)

    browser = str(config["browser"]).strip().lower()
    if browser not in VALID_BROWSERS:
        raise ValueError(f"Unsupported browser '{browser}'.")

    download_dir = str(config["download_dir"]).strip() or "~/Downloads"
    yt_dlp_path = str(config["yt_dlp_path"]).strip() or "yt-dlp"
    profile = str(config["profile"]).strip()

    raw_extra_args = config.get("extra_args", [])
    if not isinstance(raw_extra_args, list):
        raise ValueError("extra_args must be a list of strings.")

    extra_args = []
    for value in raw_extra_args:
        arg = str(value).strip()
        if arg:
            extra_args.append(arg)

    return {
        "browser": browser,
        "profile": profile,
        "download_dir": download_dir,
        "yt_dlp_path": yt_dlp_path,
        "extra_args": extra_args,
    }


def load_config() -> dict[str, Any]:
    ensure_state()
    try:
        config_exists = CONFIG_PATH.exists()
    except OSError:
        config_exists = False

    if not config_exists:
        try:
            save_config(DEFAULT_CONFIG)
        except OSError:
            return DEFAULT_CONFIG.copy()

    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return DEFAULT_CONFIG.copy()

    return normalize_config(data)


def save_config(candidate: dict[str, Any]) -> dict[str, Any]:
    config = normalize_config(candidate)
    ensure_state()
    with CONFIG_PATH.open("w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)
        handle.write("\n")
    return config


def browser_spec(config: dict[str, Any]) -> str:
    profile = config.get("profile", "")
    return f"{config['browser']}:{profile}" if profile else config["browser"]


def build_command(
    url: str,
    config: dict[str, Any],
    download_dir_override: str | None = None,
) -> list[str]:
    download_dir_value = str(download_dir_override or config["download_dir"]).strip()
    download_dir = os.path.expanduser(download_dir_value)

    command = [
        config["yt_dlp_path"],
        "--cookies-from-browser",
        browser_spec(config),
        "-P",
        str(download_dir),
    ]
    if is_twitter_url(url):
        command.extend(["-o", TWITTER_OUTPUT_TEMPLATE])
    command.extend(config["extra_args"])
    command.append(url)
    return command


def run_download_worker(encoded_payload: str) -> int:
    try:
        payload = json.loads(
            base64.urlsafe_b64decode(encoded_payload.encode("ascii")).decode("utf-8")
        )
        url = payload["url"]
        source = payload.get("source", "extension")
        download_dir_override = payload.get("download_dir")
        config = load_config()
        command = build_command(url, config, download_dir_override)

        notify("yt-dlp download started", url)
        log_line(f"Starting download for {url} from {source}")
        log_line("Command: " + " ".join(command))

        try:
            try:
                handle = LOG_PATH.open("a", encoding="utf-8")
            except OSError:
                handle = None

            if handle is None:
                result = subprocess.run(
                    command,
                    check=False,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            else:
                with handle:
                    output_target = handle
                    handle.write("\n")
                    handle.write(f"=== Download started at {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")

                    result = subprocess.run(
                        command,
                        check=False,
                        stdin=subprocess.DEVNULL,
                        stdout=output_target,
                        stderr=subprocess.STDOUT,
                    )

                    handle.write(f"=== Download finished with exit code {result.returncode} ===\n")

            if result.returncode == 0:
                notify("yt-dlp download complete", url)
                log_line(f"Download complete for {url}")
            else:
                notify("yt-dlp download failed", f"{url}\nSee {LOG_PATH}")
                log_line(f"Download failed for {url} with exit code {result.returncode}")

            return result.returncode
        except (OSError, subprocess.SubprocessError) as e:
            log_line(f"Subprocess error: {e}")
            notify("yt-dlp subprocess error", f"{e}\nSee {LOG_PATH}")
            return 1
    except Exception as error:  # noqa: BLE001
        log_line(f"Worker error: {error}")
        notify("yt-dlp worker error", f"{error}\nSee {LOG_PATH}")
        return 1


def start_download_job(
    raw_url: str,
    source: str,
    download_dir_override: str | None = None,
) -> dict[str, Any]:
    normalized_url = normalize_url(raw_url)
    normalized_download_dir = None
    if download_dir_override is not None:
        normalized_download_dir = str(download_dir_override).strip()
        if not normalized_download_dir:
            raise ValueError("download_dir must be a non-empty string when provided.")

    payload = base64.urlsafe_b64encode(
        json.dumps(
            {
                "download_dir": normalized_download_dir,
                "url": normalized_url,
                "source": source,
            }
        ).encode("utf-8")
    ).decode("ascii")

    subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--worker", payload],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )

    return {
        "ok": True,
        "status": "started",
        "url": normalized_url,
        "log_path": str(LOG_PATH),
    }


def handle_message(message: dict[str, Any]) -> dict[str, Any]:
    message_type = message.get("type")

    if message_type == "download":
        url = str(message.get("url", "")).strip()
        if not url:
            raise ValueError("Missing url field.")
        source = str(message.get("source", "extension")).strip() or "extension"
        download_dir = message.get("download_dir")
        if download_dir is not None and not isinstance(download_dir, str):
            raise ValueError("download_dir must be a string when provided.")
        return start_download_job(url, source, download_dir)

    if message_type == "get_config":
        config = load_config()
        return {
            "ok": True,
            "config": config_for_response(config),
            "config_path": str(CONFIG_PATH),
            "log_path": str(LOG_PATH),
        }

    if message_type == "save_config":
        candidate = message.get("config")
        if not isinstance(candidate, dict):
            raise ValueError("save_config expects a config object.")
        config = save_config(candidate)
        return {
            "ok": True,
            "config": config_for_response(config),
            "config_path": str(CONFIG_PATH),
            "log_path": str(LOG_PATH),
        }

    raise ValueError(f"Unsupported message type: {message_type!r}")


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        return run_download_worker(sys.argv[2])

    try:
        message = read_message()
        if message is None:
            return 0
        response = handle_message(message)
    except Exception as error:  # noqa: BLE001
        log_line(f"Host error: {error}")
        response = {"ok": False, "error": str(error), "log_path": str(LOG_PATH)}

    send_message(response)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
