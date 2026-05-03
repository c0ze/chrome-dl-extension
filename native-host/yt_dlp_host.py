#!/usr/bin/env python3
from __future__ import annotations

import base64
import fcntl
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

HOST_NAME = "dev.arda.ytdlp_host"
APP_DIR = Path.home() / ".local" / "share" / "yt-dlp-browser-host"
STATE_DIR = Path.home() / ".local" / "state" / "yt-dlp-browser-host"
CONFIG_PATH = APP_DIR / "config.json"
LOG_PATH = STATE_DIR / "host.log"
JOBS_PATH = STATE_DIR / "downloads.json"
JOBS_LOCK_PATH = STATE_DIR / "downloads.lock"
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
MAX_REMEMBERED_JOBS = 40
PROGRESS_RE = re.compile(r"\[download\]\s+(?P<percent>\d+(?:\.\d+)?)%")
SPEED_RE = re.compile(r"\sat\s+(?P<speed>\S+/s)")
ETA_RE = re.compile(r"\sETA\s+(?P<eta>\S+)")
FRAGMENT_RE = re.compile(r"\(frag\s+(?P<fragment>\d+/\d+)\)")
DESTINATION_PREFIX = "[download] Destination: "
MERGE_PREFIX = "[Merger] Merging formats into "
FIXUP_PREFIX = "[Fixup"


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


def timestamp() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def default_jobs_state() -> dict[str, Any]:
    return {"jobs": []}


def normalize_job(job: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(job)
    normalized.setdefault("id", "")
    normalized.setdefault("url", "")
    normalized.setdefault("source", "extension")
    normalized.setdefault("download_dir", "")
    normalized.setdefault("status", "queued")
    normalized.setdefault("status_detail", "Queued")
    normalized.setdefault("progress", None)
    normalized.setdefault("speed", None)
    normalized.setdefault("eta", None)
    normalized.setdefault("fragment", None)
    normalized.setdefault("filename", None)
    normalized.setdefault("error", None)
    normalized.setdefault("exit_code", None)
    normalized.setdefault("pid", None)
    normalized.setdefault("started_at", None)
    normalized.setdefault("queued_at", normalized.get("started_at"))
    normalized.setdefault("run_started_at", None)
    normalized.setdefault("updated_at", None)
    normalized.setdefault("finished_at", None)
    normalized.setdefault("force_requested_at", None)
    return normalized


def read_jobs_unlocked() -> dict[str, Any]:
    try:
        with JOBS_PATH.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return default_jobs_state()

    jobs = data.get("jobs", [])
    if not isinstance(jobs, list):
        return default_jobs_state()

    return {"jobs": [normalize_job(job) for job in jobs if isinstance(job, dict)]}


def write_jobs_unlocked(state: dict[str, Any]) -> None:
    jobs = [normalize_job(job) for job in state.get("jobs", []) if isinstance(job, dict)]
    jobs.sort(key=lambda job: job.get("started_at") or "", reverse=True)
    trimmed = jobs[:MAX_REMEMBERED_JOBS]
    temp_path = JOBS_PATH.with_suffix(".json.tmp")
    with temp_path.open("w", encoding="utf-8") as handle:
        json.dump({"jobs": trimmed}, handle, indent=2)
        handle.write("\n")
    temp_path.replace(JOBS_PATH)


def mutate_jobs(mutator: Any) -> dict[str, Any]:
    ensure_state()
    with JOBS_LOCK_PATH.open("w", encoding="utf-8") as lock_handle:
        fcntl.flock(lock_handle, fcntl.LOCK_EX)
        state = read_jobs_unlocked()
        result = mutator(state)
        write_jobs_unlocked(state)
        fcntl.flock(lock_handle, fcntl.LOCK_UN)
    return result if isinstance(result, dict) else state


def upsert_job(job: dict[str, Any]) -> None:
    def mutator(state: dict[str, Any]) -> None:
        jobs = state["jobs"]
        jobs[:] = [existing for existing in jobs if existing.get("id") != job["id"]]
        jobs.insert(0, normalize_job(job))

    mutate_jobs(mutator)


def update_job(job_id: str, updates: dict[str, Any]) -> None:
    def mutator(state: dict[str, Any]) -> None:
        for job in state["jobs"]:
            if job.get("id") == job_id:
                job.update(updates)
                job["updated_at"] = timestamp()
                return

    mutate_jobs(mutator)


def get_jobs() -> dict[str, Any]:
    ensure_state()
    with JOBS_LOCK_PATH.open("w", encoding="utf-8") as lock_handle:
        fcntl.flock(lock_handle, fcntl.LOCK_SH)
        state = read_jobs_unlocked()
        fcntl.flock(lock_handle, fcntl.LOCK_UN)

    active_count = sum(1 for job in state["jobs"] if job.get("status") == "running")
    queued_count = sum(1 for job in state["jobs"] if job.get("status") == "queued")
    return {
        "ok": True,
        "jobs": state["jobs"],
        "active_count": active_count,
        "queued_count": queued_count,
    }


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


def choose_download_dir(initial_dir: str | None = None) -> dict[str, Any]:
    initial_path = os.path.expanduser((initial_dir or "").strip())
    commands = []

    if shutil.which("zenity"):
        command = ["zenity", "--file-selection", "--directory", "--title", "Choose Download Folder"]
        if initial_path:
            command.extend(["--filename", initial_path])
        commands.append(command)

    if shutil.which("kdialog"):
        command = ["kdialog", "--title", "Choose Download Folder", "--getexistingdirectory"]
        if initial_path:
            command.append(initial_path)
        commands.append(command)

    if not commands:
        raise RuntimeError("No folder picker found. Install zenity or kdialog.")

    last_error = None
    for command in commands:
        try:
            result = subprocess.run(
                command,
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        except OSError as error:
            last_error = error
            continue

        error_output = result.stderr.strip()
        if result.returncode == 0:
            path = result.stdout.strip()
            if path:
                return {"ok": True, "path": path}
            return {"ok": True, "path": None}

        if result.returncode == 1 and not error_output:
            return {"ok": True, "path": None}

        last_error = error_output or f"{command[0]} exited with {result.returncode}"

    raise RuntimeError(f"Could not open folder picker: {last_error}")


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
        "--newline",
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


def parse_progress_line(line: str) -> dict[str, Any] | None:
    stripped = line.strip()
    if stripped.startswith(DESTINATION_PREFIX):
        return {"filename": stripped.removeprefix(DESTINATION_PREFIX).strip()}

    if stripped.startswith(MERGE_PREFIX):
        return {
            "status_detail": "Merging formats",
            "filename": stripped.removeprefix(MERGE_PREFIX).strip().strip('"'),
        }

    if stripped.startswith(FIXUP_PREFIX):
        return {"status_detail": "Finalizing file"}

    if stripped.startswith("ERROR:"):
        return {"error": stripped, "status_detail": "Error"}

    match = PROGRESS_RE.search(stripped)
    if not match:
        return None

    updates: dict[str, Any] = {"status_detail": "Downloading"}
    try:
        updates["progress"] = float(match.group("percent"))
    except (TypeError, ValueError):
        pass

    for key, pattern in (
        ("speed", SPEED_RE),
        ("eta", ETA_RE),
        ("fragment", FRAGMENT_RE),
    ):
        detail_match = pattern.search(stripped)
        if detail_match:
            updates[key] = detail_match.group(key)

    return updates


def encode_worker_payload(job: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(
        json.dumps(
            {
                "job_id": job["id"],
                "download_dir": job.get("download_dir"),
                "url": job["url"],
                "source": job.get("source", "extension"),
            }
        ).encode("utf-8")
    ).decode("ascii")


def reserve_next_job(preferred_job_id: str | None = None) -> dict[str, Any] | None:
    now = timestamp()

    def mutator(state: dict[str, Any]) -> dict[str, Any]:
        if any(job.get("status") == "running" for job in state["jobs"]):
            return {"job": None}

        queued_jobs = [job for job in state["jobs"] if job.get("status") == "queued"]
        if preferred_job_id:
            selected = next(
                (job for job in queued_jobs if job.get("id") == preferred_job_id),
                None,
            )
        else:
            selected = None

        if selected is None and queued_jobs:
            forced_jobs = [job for job in queued_jobs if job.get("force_requested_at")]
            if forced_jobs:
                selected = max(forced_jobs, key=lambda job: job.get("force_requested_at") or "")
            else:
                selected = min(
                    queued_jobs,
                    key=lambda job: job.get("queued_at") or job.get("started_at") or "",
                )

        if selected is None:
            return {"job": None}

        selected.update(
            {
                "status": "running",
                "status_detail": "Starting",
                "progress": selected.get("progress") or 0,
                "speed": None,
                "eta": None,
                "fragment": None,
                "error": None,
                "exit_code": None,
                "pid": None,
                "run_started_at": now,
                "updated_at": now,
                "finished_at": None,
            }
        )
        return {"job": normalize_job(selected)}

    return mutate_jobs(mutator).get("job")


def launch_reserved_job(job: dict[str, Any]) -> bool:
    try:
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--worker", encode_worker_payload(job)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as error:
        update_job(
            job["id"],
            {
                "status": "failed",
                "status_detail": "Launch error",
                "error": str(error),
                "exit_code": 1,
                "finished_at": timestamp(),
            },
        )
        return False

    update_job(job["id"], {"pid": process.pid})
    return True


def launch_next_queued_job(preferred_job_id: str | None = None) -> dict[str, Any]:
    job = reserve_next_job(preferred_job_id)
    if not job:
        return {"started": False}

    return {"started": launch_reserved_job(job), "job_id": job["id"]}


def force_download_job(job_id: str) -> dict[str, Any]:
    now = timestamp()

    def mutator(state: dict[str, Any]) -> dict[str, Any]:
        for job in state["jobs"]:
            if job.get("id") != job_id:
                continue

            if job.get("status") == "running":
                return {"ok": True, "status": "running", "job_id": job_id}

            if job.get("status") not in {"queued", "failed"}:
                return {
                    "ok": False,
                    "error": "Only queued or failed downloads can be started from the dashboard.",
                }

            job.update(
                {
                    "status": "queued",
                    "status_detail": "Queued next",
                    "progress": 0 if job.get("status") == "failed" else job.get("progress"),
                    "speed": None,
                    "eta": None,
                    "fragment": None,
                    "error": None,
                    "exit_code": None,
                    "force_requested_at": now,
                    "updated_at": now,
                    "finished_at": None,
                }
            )
            return {"ok": True, "status": "queued", "job_id": job_id}

        return {"ok": False, "error": "Download job not found."}

    response = mutate_jobs(mutator)
    if not response.get("ok"):
        return response

    launch_result = launch_next_queued_job(job_id)
    return {
        "ok": True,
        "status": "started" if launch_result.get("started") else response["status"],
        "job_id": job_id,
    }


def run_download_worker(encoded_payload: str) -> int:
    try:
        payload = json.loads(
            base64.urlsafe_b64decode(encoded_payload.encode("ascii")).decode("utf-8")
        )
        url = payload["url"]
        job_id = payload["job_id"]
        source = payload.get("source", "extension")
        download_dir_override = payload.get("download_dir")
        config = load_config()
        command = build_command(url, config, download_dir_override)
        download_dir = os.path.expanduser(str(download_dir_override or config["download_dir"]).strip())

        notify("yt-dlp download started", url)
        log_line(f"Starting download for {url} from {source}")
        log_line("Command: " + " ".join(command))
        update_job(
            job_id,
            {
                "download_dir": download_dir,
                "pid": os.getpid(),
                "status": "running",
                "status_detail": "Starting",
            },
        )

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
                    handle.write("\n")
                    handle.write(f"=== Download started at {timestamp()} ===\n")
                    process = subprocess.Popen(
                        command,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        bufsize=1,
                    )
                    update_job(job_id, {"pid": process.pid})

                    assert process.stdout is not None
                    for line in process.stdout:
                        handle.write(line)
                        handle.flush()
                        updates = parse_progress_line(line)
                        if updates:
                            update_job(job_id, updates)

                    return_code = process.wait()
                    result = subprocess.CompletedProcess(command, return_code)

                    handle.write(f"=== Download finished with exit code {result.returncode} ===\n")

            if result.returncode == 0:
                notify("yt-dlp download complete", url)
                log_line(f"Download complete for {url}")
                update_job(
                    job_id,
                    {
                        "status": "complete",
                        "status_detail": "Complete",
                        "progress": 100,
                        "exit_code": result.returncode,
                        "finished_at": timestamp(),
                    },
                )
                launch_next_queued_job()
            else:
                notify("yt-dlp download failed", f"{url}\nSee {LOG_PATH}")
                log_line(f"Download failed for {url} with exit code {result.returncode}")
                update_job(
                    job_id,
                    {
                        "status": "failed",
                        "status_detail": "Failed",
                        "exit_code": result.returncode,
                        "finished_at": timestamp(),
                    },
                )
                launch_next_queued_job()

            return result.returncode
        except (OSError, subprocess.SubprocessError) as e:
            log_line(f"Subprocess error: {e}")
            notify("yt-dlp subprocess error", f"{e}\nSee {LOG_PATH}")
            update_job(
                job_id,
                {
                    "status": "failed",
                    "status_detail": "Subprocess error",
                    "error": str(e),
                    "exit_code": 1,
                    "finished_at": timestamp(),
                },
            )
            launch_next_queued_job()
            return 1
    except Exception as error:  # noqa: BLE001
        log_line(f"Worker error: {error}")
        notify("yt-dlp worker error", f"{error}\nSee {LOG_PATH}")
        try:
            job_id = json.loads(
                base64.urlsafe_b64decode(encoded_payload.encode("ascii")).decode("utf-8")
            ).get("job_id")
            if job_id:
                update_job(
                    str(job_id),
                    {
                        "status": "failed",
                        "status_detail": "Worker error",
                        "error": str(error),
                        "exit_code": 1,
                        "finished_at": timestamp(),
                    },
                )
        except Exception:  # noqa: BLE001
            pass
        launch_next_queued_job()
        return 1


def start_download_job(
    raw_url: str,
    source: str,
    download_dir_override: str | None = None,
) -> dict[str, Any]:
    normalized_url = normalize_url(raw_url)
    job_id = uuid.uuid4().hex
    normalized_download_dir = None
    if download_dir_override is not None:
        normalized_download_dir = str(download_dir_override).strip()
        if not normalized_download_dir:
            raise ValueError("download_dir must be a non-empty string when provided.")

    started_at = timestamp()
    upsert_job(
        {
            "id": job_id,
            "url": normalized_url,
            "source": source,
            "download_dir": normalized_download_dir,
            "status": "queued",
            "status_detail": "Queued",
            "progress": 0,
            "started_at": started_at,
            "queued_at": started_at,
            "updated_at": started_at,
        }
    )

    launch_result = launch_next_queued_job(job_id)

    return {
        "ok": True,
        "status": "started" if launch_result.get("started") else "queued",
        "job_id": job_id,
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

    if message_type == "get_downloads":
        return get_jobs()

    if message_type == "start_download_job":
        job_id = str(message.get("job_id", "")).strip()
        if not job_id:
            raise ValueError("Missing job_id field.")
        return force_download_job(job_id)

    if message_type == "choose_download_dir":
        initial_dir = message.get("initial_dir")
        if initial_dir is not None and not isinstance(initial_dir, str):
            raise ValueError("initial_dir must be a string when provided.")
        return choose_download_dir(initial_dir)

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
