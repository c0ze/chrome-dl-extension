#!/usr/bin/env python3
from __future__ import annotations

import base64
import fcntl
import json
import os
import re
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Any, TextIO
from urllib.parse import parse_qsl, parse_qs, unquote, urlencode, urlparse, urlunparse

APP_DIR = Path.home() / ".local" / "share" / "yt-dlp-browser-host"
STATE_DIR = Path.home() / ".local" / "state" / "yt-dlp-browser-host"
CONFIG_PATH = APP_DIR / "config.json"
LOG_PATH = STATE_DIR / "host.log"
JOBS_PATH = STATE_DIR / "downloads.json"
JOBS_LOCK_PATH = STATE_DIR / "downloads.lock"
MAX_LOG_BYTES = 5 * 1024 * 1024
LOG_BACKUP_PATH = STATE_DIR / "host.log.1"
PRIVATE_FILE_MODE = 0o600
PRIVATE_DIR_MODE = 0o700
DEFAULT_CONFIG = {
    "browser": "chrome",
    "keyring": "",
    "profile": "",
    "download_dir": "~/Downloads",
    "yt_dlp_path": "yt-dlp",
    "extra_args": [],
}
VALID_BROWSERS = {"chrome", "chromium", "brave", "edge", "firefox"}
VALID_KEYRINGS = {"", "basictext", "gnomekeyring", "kwallet", "kwallet5", "kwallet6"}
# Linux user data directories, relative to $XDG_CONFIG_HOME, matching yt-dlp's.
CHROMIUM_CONFIG_DIRS = {
    "chrome": "google-chrome",
    "chromium": "chromium",
    "brave": "BraveSoftware/Brave-Browser",
    "edge": "microsoft-edge",
}
# Chrome passes the caller origin to the host; workers inherit it through this.
EXTENSION_ID_ENV = "YT_DLP_HOST_EXTENSION_ID"
EXTENSION_ORIGIN_RE = re.compile(r"chrome-extension://([a-p]{32})/?")
TWITTER_HOSTS = {
    "twitter.com",
    "www.twitter.com",
    "mobile.twitter.com",
    "x.com",
    "www.x.com",
}
TWITTER_STATUS_SEGMENTS = {"status", "statuses"}
TWITTER_USERNAME_RE = re.compile(r"[A-Za-z0-9_]{1,15}")
TWITTER_STATUS_ID_RE = re.compile(r"\d+")
TWITTER_RESERVED_USERNAMES = {"home", "explore", "notifications", "messages", "i", "settings"}
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
FACEBOOK_VANITY_RE = re.compile(r"^(?=[A-Za-z0-9.\-]{1,60}$)(?=.*[A-Za-z0-9])[A-Za-z0-9.\-]+$")
PROFILE_OUTPUT_TEMPLATE = "%(uploader_id,uploader|unknown-account)S-%(id)s.%(ext)s"

PROVIDERS = (
    {
        "name": "twitter",
        "hosts": TWITTER_HOSTS,
        "canonical_host": "x.com",
        "batch_key": lambda url: twitter_profile_media_username(url),
        "canonical_path": lambda path: canonical_twitter_path(path),
        "strip_query": lambda path: True,
        "template": PROFILE_OUTPUT_TEMPLATE,
    },
    {
        "name": "facebook",
        "hosts": FACEBOOK_HOSTS,
        "canonical_host": "www.facebook.com",
        "batch_key": lambda url: facebook_profile_reels_key(url),
        "canonical_path": lambda path: canonical_facebook_path(path),
        "strip_query": lambda path: FACEBOOK_REEL_ID_RE.match(path) is not None,
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


def valid_batch_item(raw_url: str, target: dict[str, Any]) -> bool:
    if target["provider"] == "facebook":
        return facebook_reel_id(raw_url) is not None
    if target["provider"] == "twitter":
        owner = twitter_status_username(raw_url)
        return bool(owner) and owner.lower() == str(target["key"]).lower()
    return False


MAX_REMEMBERED_FINISHED_JOBS = 40
MAX_JOBS_IN_RESPONSE = 300
MAX_RESPONSE_BYTES = 768 * 1024
MAX_PROFILE_BATCH_JOBS = 500
MAX_QUEUED_JOBS = 1000
MAX_PROFILE_NAME_CHARS = 512
ACTIVE_STATUSES = {"queued", "running"}
DUPLICATE_BLOCKING_STATUSES = {"queued", "running", "complete"}
RESTARTABLE_STATUSES = {"queued", "failed", "cancelled"}
CANCELLABLE_STATUSES = {"queued", "running"}
JOB_LEASE_SECONDS = 600.0
HEARTBEAT_INTERVAL_SECONDS = 30.0
PROGRESS_PERSIST_SECONDS = 0.5
PROGRESS_PERSIST_PERCENT = 1.0
PROGRESS_UPDATE_KEYS = {"status_detail", "progress", "speed", "eta", "fragment"}
LAUNCH_ATTEMPT_LIMIT = 5
QUEUE_KICK_ATTEMPT_LIMIT = 1
LAUNCH_BACKOFF_BASE_SECONDS = 2.0
LAUNCH_BACKOFF_MAX_SECONDS = 60.0
CANCEL_GRACE_SECONDS = 3.0
CANCEL_POLL_SECONDS = 0.1
PROC_ROOT = Path("/proc")
PROC_STAT_STATE_INDEX = 0
PROC_STAT_PGRP_INDEX = 2
PROC_STAT_START_TICKS_INDEX = 19
REDACTED = "***"
SENSITIVE_VALUE_FLAGS = {
    "--add-header",
    "--ap-password",
    "--ap-username",
    "--client-certificate-password",
    "--cookies",
    "--http-header",
    "--netrc-cmd",
    "--password",
    "--username",
    "--video-password",
    "-p",
    "-u",
}
SENSITIVE_KEY_HINTS = (
    "auth",
    "credential",
    "cookie",
    "hash",
    "key",
    "passwd",
    "password",
    "secret",
    "session",
    "sig",
    "token",
)
PROGRESS_RE = re.compile(r"\[download\]\s+(?P<percent>\d+(?:\.\d+)?)%")
SPEED_RE = re.compile(r"\sat\s+(?P<speed>\S+/s)")
ETA_RE = re.compile(r"\sETA\s+(?P<eta>\S+)")
FRAGMENT_RE = re.compile(r"\(frag\s+(?P<fragment>\d+/\d+)\)")
DESTINATION_PREFIX = "[download] Destination: "
MERGE_PREFIX = "[Merger] Merging formats into "
FIXUP_PREFIX = "[Fixup"


def ensure_state() -> None:
    for directory in (APP_DIR, STATE_DIR):
        try:
            directory.mkdir(mode=PRIVATE_DIR_MODE, parents=True, exist_ok=True)
        except OSError:
            pass


def open_private(path: Path, mode: str) -> TextIO:
    flags = os.O_WRONLY | os.O_CREAT
    flags |= os.O_APPEND if "a" in mode else os.O_TRUNC
    handle = os.fdopen(os.open(path, flags, PRIVATE_FILE_MODE), mode, encoding="utf-8")
    try:
        os.fchmod(handle.fileno(), PRIVATE_FILE_MODE)
    except OSError:
        pass
    return handle


def rotate_log_if_needed() -> None:
    try:
        if not LOG_PATH.exists() or LOG_PATH.stat().st_size < MAX_LOG_BYTES:
            return
        try:
            LOG_BACKUP_PATH.unlink()
        except FileNotFoundError:
            pass
        LOG_PATH.replace(LOG_BACKUP_PATH)
    except OSError:
        pass


def log_line(message: str) -> None:
    handle = open_log_stream()
    if handle is None:
        return

    try:
        with handle:
            handle.write(f"[{timestamp()}] {message}\n")
    except OSError:
        pass


def open_log_stream() -> TextIO | None:
    ensure_state()
    rotate_log_if_needed()
    try:
        return open_private(LOG_PATH, "a")
    except OSError:
        return None


def write_log_stream(handle: TextIO | None, text: str) -> TextIO | None:
    if handle is None:
        return None

    try:
        handle.write(text)
        handle.flush()
        if handle.tell() < MAX_LOG_BYTES:
            return handle
        handle.close()
    except OSError:
        return None

    return open_log_stream()


def timestamp() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def parse_timestamp(value: Any) -> float | None:
    text = str(value or "").strip()
    if not text:
        return None

    try:
        return time.mktime(time.strptime(text[:19], "%Y-%m-%d %H:%M:%S"))
    except (ValueError, OverflowError):
        return None


def default_launch_state() -> dict[str, Any]:
    return {"failures": 0, "blocked_until": 0.0}


def normalize_launch_state(candidate: Any) -> dict[str, Any]:
    launch = default_launch_state()
    if not isinstance(candidate, dict):
        return launch

    failures = candidate.get("failures")
    if isinstance(failures, (int, float)) and failures > 0:
        launch["failures"] = int(failures)

    blocked_until = candidate.get("blocked_until")
    if isinstance(blocked_until, (int, float)) and blocked_until > 0:
        launch["blocked_until"] = float(blocked_until)

    return launch


def default_jobs_state() -> dict[str, Any]:
    return {"jobs": [], "launch": default_launch_state()}


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
    normalized.setdefault("worker_pid", None)
    normalized.setdefault("worker_start_ticks", None)
    normalized.setdefault("heartbeat", None)
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

    return {
        "jobs": [normalize_job(job) for job in jobs if isinstance(job, dict)],
        "launch": normalize_launch_state(data.get("launch")),
    }


def write_jobs_unlocked(state: dict[str, Any]) -> None:
    jobs = [normalize_job(job) for job in state.get("jobs", []) if isinstance(job, dict)]
    jobs.sort(key=lambda job: job.get("started_at") or "", reverse=True)
    active_jobs = [job for job in jobs if job.get("status") in ACTIVE_STATUSES]
    finished_jobs = [job for job in jobs if job.get("status") not in ACTIVE_STATUSES]
    trimmed = active_jobs + finished_jobs[:MAX_REMEMBERED_FINISHED_JOBS]
    payload = {"jobs": trimmed, "launch": normalize_launch_state(state.get("launch"))}
    temp_path = JOBS_PATH.with_suffix(".json.tmp")
    with open_private(temp_path, "w") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    temp_path.replace(JOBS_PATH)


def mutate_jobs(mutator: Any) -> dict[str, Any]:
    ensure_state()
    with open_private(JOBS_LOCK_PATH, "a") as lock_handle:
        fcntl.flock(lock_handle, fcntl.LOCK_EX)
        state = read_jobs_unlocked()
        reap_stale_jobs(state)
        result = mutator(state)
        write_jobs_unlocked(state)
        fcntl.flock(lock_handle, fcntl.LOCK_UN)
    return result if isinstance(result, dict) else state


def read_jobs_shared() -> dict[str, Any]:
    ensure_state()
    with open_private(JOBS_LOCK_PATH, "a") as lock_handle:
        fcntl.flock(lock_handle, fcntl.LOCK_SH)
        state = read_jobs_unlocked()
        fcntl.flock(lock_handle, fcntl.LOCK_UN)
    return state


def read_proc_stat_fields(pid: Any) -> list[str]:
    if not isinstance(pid, int) or pid <= 1:
        return []

    try:
        with (PROC_ROOT / str(pid) / "stat").open("r", encoding="utf-8") as handle:
            return handle.read().rsplit(")", 1)[-1].split()
    except (OSError, ValueError):
        return []


def proc_stat_number(fields: list[str], index: int) -> int | None:
    if len(fields) <= index:
        return None

    try:
        return int(fields[index])
    except ValueError:
        return None


def process_is_zombie(pid: int) -> bool:
    fields = read_proc_stat_fields(pid)
    return bool(fields) and fields[PROC_STAT_STATE_INDEX] == "Z"


def process_start_ticks(pid: Any) -> int | None:
    return proc_stat_number(read_proc_stat_fields(pid), PROC_STAT_START_TICKS_INDEX)


def process_is_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or pid <= 1:
        return False

    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True

    return not process_is_zombie(pid)


def process_identity_matches(pid: Any, start_ticks: Any) -> bool:
    """True only when pid is live and was started at the recorded time.

    PIDs are recycled, so a bare "is this pid alive" test can point at an
    unrelated process. Comparing the start time from /proc pins the identity.
    """
    if not isinstance(start_ticks, int) or not process_is_alive(pid):
        return False

    actual_ticks = process_start_ticks(pid)
    return actual_ticks is not None and actual_ticks == start_ticks


def job_worker_pid(job: dict[str, Any]) -> int | None:
    for key in ("worker_pid", "pid"):
        pid = job.get(key)
        if isinstance(pid, int) and pid > 1:
            return pid

    return None


def job_worker_is_alive(job: dict[str, Any]) -> bool | None:
    """True if the recorded worker runs, False if it is gone, None if unknown."""
    pid = job_worker_pid(job)
    if pid is None:
        return None

    if not process_is_alive(pid):
        return False

    start_ticks = job.get("worker_start_ticks")
    if isinstance(start_ticks, int):
        actual_ticks = process_start_ticks(pid)
        if actual_ticks is not None and actual_ticks != start_ticks:
            return False

    return True


def job_last_seen(job: dict[str, Any]) -> float | None:
    heartbeat = job.get("heartbeat")
    if isinstance(heartbeat, (int, float)):
        return float(heartbeat)

    for key in ("updated_at", "run_started_at", "started_at"):
        parsed = parse_timestamp(job.get(key))
        if parsed is not None:
            return parsed

    return None


def running_job_is_stale(job: dict[str, Any]) -> bool:
    """Worker liveness decides; the lease only covers jobs with no known worker.

    Reaping a job whose worker is still downloading would free the slot and let a
    second yt-dlp write into the same directory, so a verifiably live worker is
    never stale no matter how long its heartbeat has been silent.
    """
    if job.get("status") != "running":
        return False

    worker_is_alive = job_worker_is_alive(job)
    if worker_is_alive is not None:
        return not worker_is_alive

    last_seen = job_last_seen(job)
    if last_seen is None:
        return True

    return time.time() - last_seen > JOB_LEASE_SECONDS


def reap_stale_jobs(state: dict[str, Any]) -> list[dict[str, Any]]:
    now = timestamp()
    reaped = []
    for job in state["jobs"]:
        if not running_job_is_stale(job):
            continue

        job.update(
            {
                "status": "failed",
                "status_detail": "Interrupted",
                "error": "Download worker is no longer running.",
                "exit_code": 1,
                "speed": None,
                "eta": None,
                "updated_at": now,
                "finished_at": now,
            }
        )
        reaped.append(job)

    return reaped


def reap_stale_jobs_now() -> None:
    def mutator(state: dict[str, Any]) -> None:
        return None

    mutate_jobs(mutator)


def update_job(job_id: str, updates: dict[str, Any]) -> None:
    def mutator(state: dict[str, Any]) -> None:
        for job in state["jobs"]:
            if job.get("id") != job_id:
                continue
            if job.get("status") == "cancelled":
                return

            job.update(updates)
            job["updated_at"] = timestamp()
            job["heartbeat"] = time.time()
            return

    mutate_jobs(mutator)


def promote_running_jobs(jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    running = [job for job in jobs if job.get("status") == "running"]
    if not running:
        return jobs

    return running + [job for job in jobs if job.get("status") != "running"]


def visible_jobs(jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # The running job is the oldest active one, so without promotion it sorts
    # below every newer queued job and falls off the dashboard's short list.
    return promote_running_jobs(jobs)[:MAX_JOBS_IN_RESPONSE]


def encoded_size(payload: dict[str, Any]) -> int:
    return len(json.dumps(payload).encode("utf-8"))


def jobs_within_budget(
    jobs: list[dict[str, Any]],
    build_response: Any,
    budget: int = MAX_RESPONSE_BYTES,
) -> list[dict[str, Any]]:
    """Drop jobs from the tail until the encoded response fits the budget.

    Chrome caps a native message at 1 MB of encoded bytes, and a job count says
    nothing about how many bytes its URL, filename and error text take. Job
    order is left alone unless the payload has to be cut, in which case running
    jobs move to the front so truncation cannot hide them.
    """
    shown = jobs
    promoted = False
    while shown:
        size = encoded_size(build_response(shown))
        if size <= budget:
            break

        if not promoted:
            shown = promote_running_jobs(shown)
            promoted = True

        estimate = int(len(shown) * budget / size)
        shown = shown[: max(0, min(estimate, len(shown) - 1))]

    return shown


def queue_needs_kick(state: dict[str, Any]) -> bool:
    """Whether reading the queue should also try to get it moving again.

    A failed launch can leave jobs queued with nothing running and no stale
    record to notice, so the dashboard poll doubles as the retry trigger. The
    launch backoff keeps a permanently failing launch from spinning.
    """
    jobs = state["jobs"]
    if any(running_job_is_stale(job) for job in jobs):
        return True

    if any(job.get("status") == "running" for job in jobs):
        return False

    if not any(job.get("status") == "queued" for job in jobs):
        return False

    return not launch_is_blocked(state)


def get_jobs() -> dict[str, Any]:
    state = read_jobs_shared()
    if queue_needs_kick(state):
        reap_stale_jobs_now()
        launch_next_queued_job(attempt_limit=QUEUE_KICK_ATTEMPT_LIMIT)
        state = read_jobs_shared()

    jobs = state["jobs"]
    active_count = sum(1 for job in jobs if job.get("status") == "running")
    queued_count = sum(1 for job in jobs if job.get("status") == "queued")

    def build_response(shown: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "ok": True,
            "jobs": shown,
            "active_count": active_count,
            "queued_count": queued_count,
            "total_count": len(jobs),
            "truncated": len(shown) < len(jobs),
        }

    return build_response(jobs_within_budget(visible_jobs(jobs), build_response))


def normalized_url_key(raw_url: Any) -> str:
    try:
        return normalize_url(str(raw_url))
    except (TypeError, ValueError):
        return str(raw_url or "")


def duplicate_url_index(state: dict[str, Any]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for job in state["jobs"]:
        if job.get("status") in DUPLICATE_BLOCKING_STATUSES:
            index.setdefault(normalized_url_key(job.get("url")), job)

    return index


def duplicate_in_index(index: dict[str, dict[str, Any]], url: str) -> dict[str, Any] | None:
    job = index.get(normalized_url_key(url))
    return normalize_job(job) if job else None


def duplicate_download_for_url(state: dict[str, Any], url: str) -> dict[str, Any] | None:
    return duplicate_in_index(duplicate_url_index(state), url)


def queue_capacity(state: dict[str, Any]) -> int:
    """How many more jobs may be queued before the state file is capped."""
    queued = sum(1 for job in state["jobs"] if job.get("status") == "queued")
    return max(0, MAX_QUEUED_JOBS - queued)


def queue_full_response() -> dict[str, Any]:
    return {
        "ok": False,
        "queue_full": True,
        "error": (
            f"The download queue already holds {MAX_QUEUED_JOBS} waiting jobs. "
            "Let some finish or clear them first."
        ),
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


def is_sensitive_key(key: str) -> bool:
    lowered = key.lower()
    return any(hint in lowered for hint in SENSITIVE_KEY_HINTS)


def redact_url(raw_url: Any) -> str:
    text = str(raw_url or "")
    try:
        parsed = urlparse(text)
    except ValueError:
        return REDACTED

    if not parsed.scheme or not parsed.netloc:
        return text

    netloc = parsed.netloc
    if "@" in netloc:
        netloc = f"{REDACTED}@{netloc.rsplit('@', 1)[1]}"

    query = parsed.query
    if query:
        pairs = parse_qsl(query, keep_blank_values=True)
        if pairs:
            query = urlencode(
                [(key, REDACTED if is_sensitive_key(key) else value) for key, value in pairs]
            )

    return urlunparse(parsed._replace(netloc=netloc, query=query))


def redact_command(command: list[str]) -> str:
    parts: list[str] = []
    redact_next = False
    for argument in command:
        text = str(argument)
        if redact_next:
            parts.append(REDACTED)
            redact_next = False
            continue

        if text in SENSITIVE_VALUE_FLAGS:
            parts.append(text)
            redact_next = True
            continue

        flag, separator, _ = text.partition("=")
        if separator and flag in SENSITIVE_VALUE_FLAGS:
            parts.append(f"{flag}={REDACTED}")
            continue

        parts.append(redact_url(text) if "://" in text else text)

    return " ".join(parts)


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


def path_segments(path: str) -> list[str]:
    return [part for part in path.split("/") if part]


def canonical_twitter_path(path: str) -> str:
    parts = path_segments(path)
    for index, part in enumerate(parts[:-1]):
        if part.lower() in TWITTER_STATUS_SEGMENTS and TWITTER_STATUS_ID_RE.fullmatch(parts[index + 1]):
            return "/" + "/".join(parts[:index] + ["status", parts[index + 1]])

    return "/" + "/".join(parts) if parts else ""


def normalize_url(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Only http(s) URLs are supported.")

    parsed = parsed._replace(fragment="")
    provider = provider_for_url(raw_url)
    if provider:
        parsed = parsed._replace(
            netloc=provider["canonical_host"],
            query="" if provider["strip_query"](parsed.path) else parsed.query,
            path=provider["canonical_path"](parsed.path),
        )
    else:
        parsed = parsed._replace(path=parsed.path.rstrip("/"))

    return urlunparse(parsed)


def valid_twitter_username(username: str) -> str | None:
    if not TWITTER_USERNAME_RE.fullmatch(username):
        return None
    if username.lower() in TWITTER_RESERVED_USERNAMES:
        return None

    return username


def twitter_profile_media_username(raw_url: str) -> str | None:
    parsed = urlparse(raw_url)
    if (parsed.hostname or "").lower() not in TWITTER_HOSTS:
        return None

    parts = path_segments(parsed.path)
    if len(parts) < 2 or parts[1].lower() != "media":
        return None

    return valid_twitter_username(parts[0])


def twitter_status_username(raw_url: str) -> str | None:
    parsed = urlparse(raw_url)
    if (parsed.hostname or "").lower() not in TWITTER_HOSTS:
        return None

    parts = path_segments(parsed.path)
    if len(parts) < 3 or parts[1].lower() not in TWITTER_STATUS_SEGMENTS:
        return None
    if not TWITTER_STATUS_ID_RE.fullmatch(parts[2]):
        return None

    return valid_twitter_username(parts[0])


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

    # /people/<name-segment>/<digits> — the numeric id is the key, matching
    # profile.php?id=<digits> so the same profile keys the same batch however
    # it is reached. Checked before the two-segment vanity rule below since it
    # is a structurally different (three-segment) form.
    if len(parts) == 3 and parts[0].lower() == "people":
        query = parse_qs(parsed.query)
        if "reels_tab" not in query.get("sk", []):
            return None
        candidate = parts[2]
        return candidate if candidate.isdigit() else None

    if len(parts) == 2 and parts[1].lower() == "reels":
        candidate = parts[0]
        if candidate.lower() in FACEBOOK_RESERVED_SEGMENTS:
            return None
        return candidate if FACEBOOK_VANITY_RE.match(candidate) else None

    return None


def facebook_people_url_name(raw_url: str) -> str | None:
    """The percent-decoded name segment from a /people/<name>/<digits> URL.

    Returns None for any other URL shape, and never raises on malformed
    percent-encoding — the caller falls back to the numeric id in that case.
    """
    parsed = urlparse(raw_url)
    if (parsed.hostname or "").lower() not in FACEBOOK_HOSTS:
        return None

    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) != 3 or parts[0].lower() != "people":
        return None

    try:
        decoded = unquote(parts[1], errors="strict")
    except (UnicodeDecodeError, ValueError):
        return None

    decoded = decoded.strip()
    return decoded or None


FORBIDDEN_PATH_CHARS = set('/\\:*?"<>|')
MAX_PATH_PART_BYTES = 255


def safe_path_part(value: str, fallback: str = "download") -> str:
    normalized = unicodedata.normalize("NFC", str(value or ""))
    # Bound the work before character sanitisation to prevent DoS on multi-megabyte inputs
    if len(normalized) > MAX_PATH_PART_BYTES * 4:
        normalized = normalized[: MAX_PATH_PART_BYTES * 4]
    cleaned = "".join(
        "_" if character in FORBIDDEN_PATH_CHARS or ord(character) < 32 else character
        for character in normalized
    )
    cleaned = cleaned.strip(" ._")

    # Single-pass truncation: encode once, slice at byte cap, decode safely
    encoded = cleaned.encode("utf-8")
    if len(encoded) > MAX_PATH_PART_BYTES:
        cleaned = encoded[:MAX_PATH_PART_BYTES].decode("utf-8", errors="ignore")
    cleaned = cleaned.strip(" ._")

    if not cleaned or cleaned in {".", ".."}:
        return safe_path_part(fallback) if fallback and fallback != value else "download"
    return cleaned


def config_for_response(config: dict[str, Any]) -> dict[str, Any]:
    return {
        "browser": config["browser"],
        "keyring": config.get("keyring", ""),
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

    keyring = str(config["keyring"]).strip().lower()
    if keyring not in VALID_KEYRINGS:
        raise ValueError(f"Unsupported cookie keyring '{keyring}'.")

    download_dir = str(config["download_dir"]).strip() or "~/Downloads"
    resolve_download_dir(download_dir)
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
        "keyring": keyring,
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
    with open_private(CONFIG_PATH, "w") as handle:
        json.dump(config, handle, indent=2)
        handle.write("\n")
    return config


def resolve_download_dir(value: Any) -> str:
    """Expand a download folder, rejecting anything that is not an absolute path.

    yt-dlp resolves a relative -P against the worker's working directory, so a
    URI such as smb://host/share would silently land inside the host's app dir.
    """
    text = str(value or "").strip()
    path = os.path.expanduser(text)
    if not os.path.isabs(path):
        raise ValueError(
            f"Download folder must be an absolute local path, not '{text}'. "
            "Mount network shares first and use the mounted folder path."
        )
    return path


def remember_extension_origin(argv: list[str]) -> None:
    for arg in argv[1:]:
        match = EXTENSION_ORIGIN_RE.fullmatch(arg)
        if match:
            os.environ[EXTENSION_ID_ENV] = match.group(1)
            return


def extension_profile(browser: str) -> str:
    """Return the browser profile this extension is installed in, if unambiguous.

    With no profile, yt-dlp reads the most recently written cookie database of
    any profile, which may not be signed in to the site being downloaded.
    """
    config_dir = CHROMIUM_CONFIG_DIRS.get(browser)
    extension_id = os.environ.get(EXTENSION_ID_ENV, "")
    if not config_dir or not extension_id:
        return ""

    config_home = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    try:
        candidates = sorted((config_home / config_dir).glob("*/Preferences"))
    except OSError:
        return ""

    matches = []
    for preferences_path in candidates:
        try:
            with preferences_path.open("r", encoding="utf-8") as handle:
                preferences = json.load(handle)
            settings = preferences["extensions"]["settings"]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if isinstance(settings, dict) and extension_id in settings:
            matches.append(preferences_path.parent.name)
    return matches[0] if len(matches) == 1 else ""


def browser_spec(config: dict[str, Any]) -> str:
    browser = config["browser"]
    profile = config.get("profile", "") or extension_profile(browser)
    keyring = config.get("keyring", "")
    if keyring and browser != "firefox":
        browser = f"{browser}+{keyring}"
    return f"{browser}:{profile}" if profile else browser


def build_command(
    url: str,
    config: dict[str, Any],
    download_dir_override: str | None = None,
) -> list[str]:
    download_dir = resolve_download_dir(download_dir_override or config["download_dir"])

    command = [
        config["yt_dlp_path"],
        "--newline",
        "--cookies-from-browser",
        browser_spec(config),
        "-P",
        str(download_dir),
    ]
    provider = provider_for_url(url)
    if provider:
        command.extend(["-o", provider["template"]])
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
                "worker_pid": None,
                "worker_start_ticks": None,
                "run_started_at": now,
                "updated_at": now,
                "heartbeat": time.time(),
                "finished_at": None,
            }
        )
        return {"job": normalize_job(selected)}

    return mutate_jobs(mutator).get("job")


def launch_is_blocked(state: dict[str, Any]) -> bool:
    launch = normalize_launch_state(state.get("launch"))
    return time.time() < launch["blocked_until"]


def record_launch_failure() -> None:
    def mutator(state: dict[str, Any]) -> None:
        launch = normalize_launch_state(state.get("launch"))
        failures = launch["failures"] + 1
        delay = min(
            LAUNCH_BACKOFF_BASE_SECONDS * (2 ** (failures - 1)),
            LAUNCH_BACKOFF_MAX_SECONDS,
        )
        state["launch"] = {"failures": failures, "blocked_until": time.time() + delay}
        return None

    mutate_jobs(mutator)


def clear_launch_failures() -> None:
    def mutator(state: dict[str, Any]) -> None:
        state["launch"] = default_launch_state()
        return None

    mutate_jobs(mutator)


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

    update_job(
        job["id"],
        {
            "pid": process.pid,
            "worker_pid": process.pid,
            "worker_start_ticks": process_start_ticks(process.pid),
        },
    )
    return True


def launch_next_queued_job(
    preferred_job_id: str | None = None,
    attempt_limit: int = LAUNCH_ATTEMPT_LIMIT,
) -> dict[str, Any]:
    wanted_job_id = preferred_job_id
    last_job_id = None
    failed = False
    for _ in range(max(1, attempt_limit)):
        job = reserve_next_job(wanted_job_id)
        if not job:
            break

        last_job_id = job["id"]
        if launch_reserved_job(job):
            # Failures are cleared once the worker has run yt-dlp, so a worker
            # that cannot even start it keeps the backoff growing.
            return {"started": True, "job_id": last_job_id}

        failed = True
        wanted_job_id = None

    if failed:
        record_launch_failure()

    return {"started": False, "job_id": last_job_id}


def signal_process_group(pgid: int, number: int) -> bool:
    try:
        os.killpg(pgid, number)
    except OSError:
        return False

    return True


def process_group_is_running(pgid: int) -> bool:
    """Whether the group still holds a process that is not a zombie.

    A pgid stays reserved while any member exists, so once the group is known to
    be ours it cannot silently become someone else's between signals.
    """
    if not signal_process_group(pgid, 0):
        return False

    try:
        entries = os.listdir(PROC_ROOT)
    except OSError:
        return True

    for entry in entries:
        if not entry.isdigit():
            continue

        fields = read_proc_stat_fields(int(entry))
        if not fields or fields[PROC_STAT_STATE_INDEX] == "Z":
            continue
        if proc_stat_number(fields, PROC_STAT_PGRP_INDEX) == pgid:
            return True

    return False


def worker_process_group(pid: Any, start_ticks: Any) -> int | None:
    """The process group to signal, or None when the worker cannot be confirmed."""
    if not process_identity_matches(pid, start_ticks):
        return None

    try:
        pgid = os.getpgid(pid)
    except OSError:
        return None

    if pgid <= 1 or pgid == os.getpgrp():
        return None

    return pgid


def terminate_process_group(pid: Any, start_ticks: Any) -> bool:
    pgid = worker_process_group(pid, start_ticks)
    if pgid is None:
        return False

    if not signal_process_group(pgid, signal.SIGTERM):
        return False

    deadline = time.monotonic() + CANCEL_GRACE_SECONDS
    while time.monotonic() < deadline:
        if not process_group_is_running(pgid):
            return True
        time.sleep(CANCEL_POLL_SECONDS)

    if process_group_is_running(pgid):
        signal_process_group(pgid, signal.SIGKILL)

    return True


def cancel_download_job(job_id: str) -> dict[str, Any]:
    now = timestamp()

    def mutator(state: dict[str, Any]) -> dict[str, Any]:
        for job in state["jobs"]:
            if job.get("id") != job_id:
                continue

            status = job.get("status")
            if status not in CANCELLABLE_STATUSES:
                return {
                    "ok": False,
                    "error": "Only queued or running downloads can be cancelled.",
                }

            job.update(
                {
                    "status": "cancelled",
                    "status_detail": "Cancelled",
                    "speed": None,
                    "eta": None,
                    "error": None,
                    "exit_code": None,
                    "force_requested_at": None,
                    "updated_at": now,
                    "finished_at": now,
                }
            )
            return {
                "ok": True,
                "was_running": status == "running",
                "worker_pid": job.get("worker_pid"),
                "worker_start_ticks": job.get("worker_start_ticks"),
            }

        return {"ok": False, "error": "Download job not found."}

    result = mutate_jobs(mutator)
    if not result.get("ok"):
        return result

    if result.get("was_running"):
        signalled = terminate_process_group(
            result.get("worker_pid"),
            result.get("worker_start_ticks"),
        )
        if signalled:
            log_line(f"Cancelled running download job {job_id}")
        else:
            log_line(
                f"Cancelled download job {job_id} without signalling: "
                "its worker could not be identified."
            )
        launch_next_queued_job()

    return {"ok": True, "job_id": job_id, "status": "cancelled"}


def force_download_job(job_id: str) -> dict[str, Any]:
    now = timestamp()

    def mutator(state: dict[str, Any]) -> dict[str, Any]:
        for job in state["jobs"]:
            if job.get("id") != job_id:
                continue

            status = job.get("status")
            if status == "running":
                return {"ok": True, "status": "running", "job_id": job_id}

            if status not in RESTARTABLE_STATUSES:
                return {
                    "ok": False,
                    "error": "Only queued, failed, or cancelled downloads can be started from the dashboard.",
                }

            job.update(
                {
                    "status": "queued",
                    "status_detail": "Queued next",
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
            if status != "queued":
                job.update(
                    {
                        "progress": 0,
                        "filename": None,
                        "pid": None,
                        "worker_pid": None,
                        "worker_start_ticks": None,
                        "run_started_at": None,
                        "heartbeat": None,
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


def remove_download_job(job_id: str) -> dict[str, Any]:
    def mutator(state: dict[str, Any]) -> dict[str, Any]:
        for job in state["jobs"]:
            if job.get("id") != job_id:
                continue

            if job.get("status") == "running":
                return {"ok": False, "error": "Running downloads cannot be removed."}

            state["jobs"] = [existing for existing in state["jobs"] if existing.get("id") != job_id]
            return {"ok": True, "removed": 1}

        return {"ok": False, "error": "Download job not found."}

    return mutate_jobs(mutator)


def clear_download_jobs() -> dict[str, Any]:
    def mutator(state: dict[str, Any]) -> dict[str, Any]:
        original_count = len(state["jobs"])
        state["jobs"] = [job for job in state["jobs"] if job.get("status") == "running"]
        return {"ok": True, "removed": original_count - len(state["jobs"])}

    return mutate_jobs(mutator)


def get_download_job(job_id: str) -> dict[str, Any] | None:
    state = read_jobs_shared()
    for job in state["jobs"]:
        if job.get("id") == job_id:
            return normalize_job(job)

    return None


def containing_folder_for_job(job: dict[str, Any]) -> Path:
    filename = str(job.get("filename") or "").strip().strip('"')
    if filename:
        return Path(os.path.expanduser(filename)).parent

    download_dir = str(job.get("download_dir") or "").strip()
    if download_dir:
        return Path(os.path.expanduser(download_dir))

    raise RuntimeError("This download does not have a known folder yet.")


def open_folder(path: Path) -> None:
    for opener in ("xdg-open", "gio", "kde-open", "kde-open5"):
        executable = shutil.which(opener)
        if not executable:
            continue

        command = [executable, str(path)]
        if opener == "gio":
            command = [executable, "open", str(path)]

        subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return

    raise RuntimeError("No file explorer opener found. Install xdg-open or gio.")


def open_download_folder(job_id: str) -> dict[str, Any]:
    job = get_download_job(job_id)
    if not job:
        return {"ok": False, "error": "Download job not found."}

    folder = containing_folder_for_job(job)
    if not folder.is_dir():
        return {"ok": False, "error": f"Folder does not exist: {folder}"}

    open_folder(folder)
    return {"ok": True, "path": str(folder)}


def decode_worker_payload(encoded_payload: str) -> dict[str, Any]:
    return json.loads(base64.urlsafe_b64decode(encoded_payload.encode("ascii")).decode("utf-8"))


def start_job_heartbeat(job_id: str) -> threading.Event:
    stop_event = threading.Event()

    def beat() -> None:
        while not stop_event.wait(HEARTBEAT_INTERVAL_SECONDS):
            try:
                update_job(job_id, {})
            except Exception as error:  # noqa: BLE001
                try:
                    log_line(f"Heartbeat failed for job {job_id}: {error}")
                except Exception:  # noqa: BLE001
                    pass

    threading.Thread(target=beat, daemon=True).start()
    return stop_event


def is_progress_update(updates: dict[str, Any]) -> bool:
    return updates.get("status_detail") == "Downloading" and set(updates).issubset(PROGRESS_UPDATE_KEYS)


def cookie_failure_hint(line: str) -> str | None:
    """Keep actionable cookie diagnostics when a later extractor error masks them."""
    lowered = line.strip().lower()
    if not lowered.startswith(("warning:", "error:")):
        return None
    if "secretstorage" in lowered and ("not available" in lowered or "not installed" in lowered):
        return (
            "Install SecretStorage in the Python environment used by the configured yt-dlp "
            "executable so it can read the GNOME keyring."
        )
    if "cookie" in lowered and any(
        phrase in lowered for phrase in ("cannot decrypt", "failed to decrypt", "could not be decrypted")
    ):
        return (
            "Some browser cookies could not be decrypted, so the download may be missing your "
            "signed-in session. Check the cookies browser, profile, and Cookie keyring in "
            "extension Settings; select gnomekeyring if Chrome uses GNOME Keyring on Hyprland."
        )
    return None


GUEST_FALLBACK_HINT = (
    "yt-dlp found no X/Twitter login in the browser cookies it read and fell back to "
    "guest access, which cannot see sensitive or restricted posts. Set the cookies "
    "profile in extension Settings to the browser profile that is signed in to X "
    "(for example Default or Profile 1)."
)


def guest_fallback_hint(line: str) -> str | None:
    if line.startswith("[twitter]") and line.rstrip().endswith("Downloading guest token"):
        return GUEST_FALLBACK_HINT
    return None


def run_yt_dlp(command: list[str], job_id: str) -> int:
    handle = open_log_stream()
    # Parsing output and tracking the process must also work when logging fails.
    cookie_hints: list[str] = []
    last_error: str | None = None
    pending: dict[str, Any] = {}
    last_written = 0.0
    last_progress: float | None = None
    process: subprocess.Popen[str] | None = None
    try:
        handle = write_log_stream(handle, f"\n=== Download started at {timestamp()} ===\n")
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            bufsize=1,
        )
        update_job(job_id, {"pid": process.pid})

        assert process.stdout is not None
        for line in process.stdout:
            hint = cookie_failure_hint(line) or guest_fallback_hint(line)
            if hint and hint not in cookie_hints:
                cookie_hints.append(hint)
            updates = parse_progress_line(line)
            if updates and updates.get("error"):
                last_error = updates["error"]
            progress_only = bool(updates) and is_progress_update(updates)
            if not progress_only:
                handle = write_log_stream(handle, line)
            if not updates:
                continue

            if not progress_only:
                update_job(job_id, {**pending, **updates})
                pending = {}
                last_written = time.monotonic()
                continue

            pending.update(updates)
            progress = updates.get("progress")
            moved = isinstance(progress, (int, float)) and (
                last_progress is None or abs(float(progress) - last_progress) >= PROGRESS_PERSIST_PERCENT
            )
            now = time.monotonic()
            if moved or now - last_written >= PROGRESS_PERSIST_SECONDS:
                update_job(job_id, pending)
                if isinstance(progress, (int, float)):
                    last_progress = float(progress)
                pending = {}
                last_written = now

        if pending:
            update_job(job_id, pending)

        return_code = process.wait()
        if return_code:
            error = last_error or f"yt-dlp exited with exit code {return_code}. See {LOG_PATH}."
            update_job(job_id, {"error": "\n".join([error, *cookie_hints])})
        else:
            update_job(job_id, {"error": None})
        handle = write_log_stream(handle, f"=== Download finished with exit code {return_code} ===\n")
        return return_code
    except BaseException:
        # The caller marks the job failed and moves on, so yt-dlp must not
        # keep running untracked alongside the next download.
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        raise
    finally:
        if handle is not None:
            handle.close()


def run_download_worker(encoded_payload: str) -> int:
    try:
        payload = decode_worker_payload(encoded_payload)
        url = payload["url"]
        job_id = payload["job_id"]
        source = payload.get("source", "extension")
        download_dir_override = payload.get("download_dir")
        config = load_config()
        command = build_command(url, config, download_dir_override)
        download_dir = resolve_download_dir(download_dir_override or config["download_dir"])

        safe_url = redact_url(url)
        notify("yt-dlp download started", safe_url)
        log_line(f"Starting download for {safe_url} from {source}")
        log_line("Command: " + redact_command(command))
        update_job(
            job_id,
            {
                "download_dir": download_dir,
                "pid": os.getpid(),
                "worker_pid": os.getpid(),
                "worker_start_ticks": process_start_ticks(os.getpid()),
                "status": "running",
                "status_detail": "Starting",
            },
        )
        stop_heartbeat = start_job_heartbeat(job_id)

        try:
            return_code = run_yt_dlp(command, job_id)
            clear_launch_failures()
            if return_code == 0:
                notify("yt-dlp download complete", safe_url)
                log_line(f"Download complete for {safe_url}")
                update_job(
                    job_id,
                    {
                        "status": "complete",
                        "status_detail": "Complete",
                        "progress": 100,
                        "exit_code": return_code,
                        "finished_at": timestamp(),
                    },
                )
            else:
                notify("yt-dlp download failed", f"{safe_url}\nSee {LOG_PATH}")
                log_line(f"Download failed for {safe_url} with exit code {return_code}")
                update_job(
                    job_id,
                    {
                        "status": "failed",
                        "status_detail": "Failed",
                        "exit_code": return_code,
                        "finished_at": timestamp(),
                    },
                )

            launch_next_queued_job()
            return return_code
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
            # yt-dlp could not run, which will fail every queued job the same
            # way, so back off instead of starting the next one immediately.
            record_launch_failure()
            return 1
        finally:
            stop_heartbeat.set()
    except Exception as error:  # noqa: BLE001
        log_line(f"Worker error: {error}")
        notify("yt-dlp worker error", f"{error}\nSee {LOG_PATH}")
        try:
            job_id = decode_worker_payload(encoded_payload).get("job_id")
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
        record_launch_failure()
        return 1


def start_download_job(
    raw_url: str,
    source: str,
    download_dir_override: str | None = None,
    allow_duplicate: bool = False,
) -> dict[str, Any]:
    normalized_url = normalize_url(raw_url)
    job_id = uuid.uuid4().hex
    normalized_download_dir = None
    if download_dir_override is not None:
        normalized_download_dir = str(download_dir_override).strip()
        resolve_download_dir(normalized_download_dir)

    started_at = timestamp()
    new_job = {
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

    def mutator(state: dict[str, Any]) -> dict[str, Any]:
        if not allow_duplicate:
            duplicate = duplicate_download_for_url(state, normalized_url)
            if duplicate:
                return {
                    "ok": False,
                    "duplicate": True,
                    "duplicate_job": duplicate,
                    "error": "This video is already queued, running, or completed.",
                }

        if not queue_capacity(state):
            return queue_full_response()

        state["jobs"].insert(0, normalize_job(new_job))
        return {"ok": True}

    response = mutate_jobs(mutator)
    if not response.get("ok"):
        return response

    launch_result = launch_next_queued_job(job_id)

    return {
        "ok": True,
        "status": "started" if launch_result.get("started") else "queued",
        "job_id": job_id,
        "url": normalized_url,
        "log_path": str(LOG_PATH),
    }


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

    if download_dir_override is None:
        config = load_config()
        base_download_dir = str(config["download_dir"]).strip()
    else:
        base_download_dir = str(download_dir_override).strip()

    base_download_path = resolve_download_dir(base_download_dir)

    video_urls: list[str] = []
    seen_urls: set[str] = set()
    rejected_count = 0
    for profile_video_url in profile_video_urls:
        try:
            normalized_video_url = normalize_url(profile_video_url)
        except ValueError:
            rejected_count += 1
            continue

        if not valid_batch_item(normalized_video_url, target):
            rejected_count += 1
            continue

        if normalized_video_url in seen_urls:
            continue
        seen_urls.add(normalized_video_url)
        video_urls.append(normalized_video_url)

    limit_skipped_count = max(0, len(video_urls) - MAX_PROFILE_BATCH_JOBS)
    video_urls = video_urls[:MAX_PROFILE_BATCH_JOBS]

    if not video_urls:
        if rejected_count:
            rejection_messages = {
                "twitter": f"None of the {rejected_count} scraped links are posts by @{target['key']}. Reload the profile media page and try again.",
                "facebook": f"None of the {rejected_count} scraped links are reels from this profile. Reload the profile reels page and try again.",
            }
            message = rejection_messages.get(target["provider"], rejection_messages["twitter"])
            raise ValueError(message)
        raise ValueError(
            "No profile video links were provided. Open the profile media page in Chrome and try again."
        )

    # Preference order: scraped page name (most authoritative, handles renames),
    # then the name segment decoded from the URL itself, then the numeric/vanity
    # key. safe_path_part sanitises whichever wins, so this is not a new trust
    # boundary.
    profile_name_stripped = (profile_name or "").strip() if profile_name else ""
    url_decoded_name = facebook_people_url_name(normalized_profile_url) or ""
    folder_name = safe_path_part(
        profile_name_stripped or url_decoded_name or target["key"], fallback=target["key"]
    )
    profile_dir = Path(base_download_path) / folder_name
    started_at = timestamp()

    def make_job(video_url: str, index: int) -> dict[str, Any]:
        queued_at = f"{started_at}.{index:04d}"
        return {
            "id": uuid.uuid4().hex,
            "url": video_url,
            "source": source,
            "download_dir": str(profile_dir),
            "status": "queued",
            "status_detail": "Queued",
            "progress": 0,
            "started_at": queued_at,
            "queued_at": queued_at,
            "updated_at": started_at,
        }

    new_jobs = [normalize_job(make_job(video_url, index)) for index, video_url in enumerate(video_urls)]

    def mutator(state: dict[str, Any]) -> dict[str, Any]:
        if allow_duplicate:
            queued_jobs = list(new_jobs)
            skipped = 0
        else:
            queued_jobs = []
            duplicates: list[dict[str, Any]] = []
            index = duplicate_url_index(state)
            for job in new_jobs:
                duplicate = duplicate_in_index(index, job["url"])
                if duplicate:
                    duplicates.append(duplicate)
                else:
                    queued_jobs.append(job)

            if not queued_jobs:
                return {
                    "ok": False,
                    "duplicate": True,
                    "duplicate_job": duplicates[0],
                    "duplicate_count": len(duplicates),
                    "discovered_count": len(new_jobs),
                    "rejected_count": rejected_count,
                    "error": "All profile videos are already queued, running, or completed.",
                }

            skipped = len(duplicates)

        capacity = queue_capacity(state)
        capped_count = max(0, len(queued_jobs) - capacity)
        if capped_count:
            queued_jobs = queued_jobs[:capacity]
        if not queued_jobs:
            return queue_full_response()

        state["jobs"] = queued_jobs + state["jobs"]
        return {
            "ok": True,
            "queued_jobs": queued_jobs,
            "skipped_count": skipped,
            "capped_count": capped_count,
        }

    response = mutate_jobs(mutator)
    if not response.get("ok"):
        return response

    queued_jobs = response["queued_jobs"]
    profile_dir.mkdir(parents=True, exist_ok=True)
    launch_result = launch_next_queued_job(queued_jobs[0]["id"])
    return {
        "ok": True,
        "profile": True,
        "username": target["key"],
        "status": "started" if launch_result.get("started") else "queued",
        "queued_count": len(queued_jobs),
        "discovered_count": len(new_jobs),
        "skipped_count": response.get("skipped_count", 0),
        "rejected_count": rejected_count,
        "limit_skipped_count": limit_skipped_count + response.get("capped_count", 0),
        "download_dir": str(profile_dir),
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
        allow_duplicate = bool(message.get("allow_duplicate", False))
        profile_name = message.get("profile_name")
        if profile_name is not None and not isinstance(profile_name, str):
            raise ValueError("profile_name must be a string when provided.")
        if profile_name is not None and len(profile_name) > MAX_PROFILE_NAME_CHARS:
            profile_name = profile_name[:MAX_PROFILE_NAME_CHARS]
        if batch_target_for_url(url):
            raw_profile_urls = message.get("profile_urls")
            if not isinstance(raw_profile_urls, list):
                raw_profile_urls = []
            profile_urls = [str(profile_url).strip() for profile_url in raw_profile_urls]
            profile_urls = [profile_url for profile_url in profile_urls if profile_url]
            return start_profile_download_jobs(
                url,
                source,
                download_dir,
                profile_urls,
                allow_duplicate,
                profile_name,
            )
        return start_download_job(url, source, download_dir, allow_duplicate)

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

    if message_type == "cancel_download_job":
        job_id = str(message.get("job_id", "")).strip()
        if not job_id:
            raise ValueError("Missing job_id field.")
        return cancel_download_job(job_id)

    if message_type == "remove_download_job":
        job_id = str(message.get("job_id", "")).strip()
        if not job_id:
            raise ValueError("Missing job_id field.")
        return remove_download_job(job_id)

    if message_type == "clear_download_jobs":
        return clear_download_jobs()

    if message_type == "open_download_folder":
        job_id = str(message.get("job_id", "")).strip()
        if not job_id:
            raise ValueError("Missing job_id field.")
        return open_download_folder(job_id)

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

    remember_extension_origin(sys.argv)

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
