#!/usr/bin/env python3
"""Library check: finds broken and duplicate videos under the download folder.

A scan reads every video once (ffprobe, plus a decode of its last seconds),
keeps what it learned in an index so the next scan only reads new or changed
files, and writes a report of broken files and groups of duplicates. Nothing is
ever deleted: a file the user removes is moved to <library>/_trash, keeping its
path below the library root.

The scan runs as its own process (`library_check.py --scan <root> <state>`),
because it takes far longer than a native message may.
"""
from __future__ import annotations

import concurrent.futures
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

VIDEO_SUFFIXES = {".mp4", ".mkv", ".webm", ".mov", ".m4v"}
# Synology metadata (@eaDir), hidden folders and our own _trash are not library content.
SKIP_PREFIXES = ("@", ".", "_")
TRASH_NAME = "_trash"
INDEX_VERSION = 1
SCAN_WORKERS = 4
PROBE_TIMEOUT_SECONDS = 60
STATUS_INTERVAL_SECONDS = 2.0
# Two re-encodes of one video differ by a frame or two at most.
DURATION_TOLERANCE_SECONDS = 0.1
# Out of 64 bits per frame; the same picture at another quality differs by a few.
FINGERPRINT_MAX_DISTANCE = 5
FINGERPRINT_POSITIONS = (0.3, 0.7)
PARTIAL_HASH_BYTES = 256 * 1024
THUMBNAIL_WIDTH = 240
PRIVATE_FILE_MODE = 0o600
# <handle>-<id>.<ext>: a name the download archive can recognise later.
ID_NAMED_RE = re.compile(r"^[A-Za-z0-9_]{1,15}-\d{10,}\.")
PRIVATE_DIR_MODE = 0o700


def index_path(state_dir: Path) -> Path:
    return state_dir / "library_index.json"


def status_path(state_dir: Path) -> Path:
    return state_dir / "library_scan.json"


def lock_path(state_dir: Path) -> Path:
    return state_dir / "library_scan.lock"


def thumbs_dir(state_dir: Path) -> Path:
    return state_dir / "library-thumbs"


def thumbnail_key(relative_path: str) -> str:
    return hashlib.sha1(relative_path.encode("utf-8", errors="surrogateescape")).hexdigest()


def write_json(path: Path, payload: dict[str, Any]) -> None:
    temp_path = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, PRIVATE_FILE_MODE)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    temp_path.replace(path)


def read_json(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def load_index(state_dir: Path) -> dict[str, Any]:
    data = read_json(index_path(state_dir))
    if data.get("version") != INDEX_VERSION or not isinstance(data.get("files"), dict):
        return {"version": INDEX_VERSION, "files": {}, "report": empty_report()}
    data.setdefault("report", empty_report())
    return data


def empty_report() -> dict[str, Any]:
    return {"broken": [], "groups": [], "scanned": 0, "finished_at": None}


def library_videos(root: Path) -> list[str]:
    """Every video under the library root, as paths relative to it."""
    found: list[str] = []
    for current, directories, files in os.walk(root):
        directories[:] = [name for name in directories if not name.startswith(SKIP_PREFIXES)]
        for name in files:
            if os.path.splitext(name)[1].lower() in VIDEO_SUFFIXES:
                found.append(os.path.relpath(os.path.join(current, name), root))
    found.sort()
    return found


def run_tool(command: list[str]) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=PROBE_TIMEOUT_SECONDS,
    )


def last_line(output: bytes) -> str:
    """The last thing a tool said, without ffmpeg's "[h264 @ 0x55...]" prefixes."""
    lines = [line.strip() for line in output.decode("utf-8", errors="replace").splitlines() if line.strip()]
    if not lines:
        return ""
    cleaned = lines[-1]
    while cleaned.startswith("[") and "]" in cleaned:
        cleaned = cleaned[cleaned.index("]") + 1 :].strip()
    return cleaned[:200]


def probe_video(path: Path) -> dict[str, Any]:
    """What ffprobe and a decode of the last seconds say about one file.

    Returns the facts for the index; `error` is set when the file is broken.
    """
    try:
        stat = path.stat()
    except OSError as error:
        return {"size": 0, "mtime": 0, "error": f"cannot be read: {error.strerror or error}"}

    facts: dict[str, Any] = {"size": stat.st_size, "mtime": int(stat.st_mtime)}
    if stat.st_size == 0:
        return {**facts, "error": "empty file"}

    try:
        probe = run_tool(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration:stream=codec_type,width,height",
                "-of",
                "json",
                str(path),
            ]
        )
    except subprocess.TimeoutExpired:
        return {**facts, "error": "ffprobe timed out reading it"}

    if probe.returncode != 0:
        return {**facts, "error": last_line(probe.stderr) or "ffprobe cannot read it"}

    try:
        described = json.loads(probe.stdout or b"{}")
    except ValueError:
        return {**facts, "error": "ffprobe gave no description"}

    video = next(
        (stream for stream in described.get("streams") or [] if stream.get("codec_type") == "video"),
        None,
    )
    if not video:
        return {**facts, "error": "no video stream"}

    try:
        duration = float((described.get("format") or {}).get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    if duration <= 0:
        return {**facts, "error": "no playable length"}

    facts.update(
        {"duration": round(duration, 3), "width": int(video.get("width") or 0), "height": int(video.get("height") or 0)}
    )

    # ffprobe only reads the header, which a download cut short still has when
    # the index sits at the front of the file. Decoding a frame near the end
    # fails when the data is not there.
    try:
        tail = run_tool(
            [
                "ffmpeg",
                "-v",
                "error",
                "-sseof",
                "-2",
                "-i",
                str(path),
                "-map",
                "0:v:0",
                "-frames:v",
                "1",
                "-vf",
                "scale=16:16,format=gray",
                "-f",
                "rawvideo",
                "-",
            ]
        )
    except subprocess.TimeoutExpired:
        return {**facts, "error": "timed out decoding the end"}

    if tail.returncode != 0 or not tail.stdout:
        stops = last_video_timestamp(path)
        if stops is not None and stops < duration - 1:
            return {**facts, "error": f"picture stops at {clock(stops)} of {clock(duration)}"}
        reason = last_line(tail.stderr)
        return {**facts, "error": f"the end cannot be decoded (cut short?){': ' + reason if reason else ''}"}

    return facts


def clock(seconds: float) -> str:
    total = int(seconds)
    return f"{total // 60}:{total % 60:02d}"


def last_video_timestamp(path: Path) -> float | None:
    """When the last video packet is shown: where the picture really ends."""
    try:
        packets = run_tool(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", str(path)]
        )
    except subprocess.TimeoutExpired:
        return None

    latest: float | None = None
    for line in packets.stdout.decode("ascii", errors="replace").split():
        try:
            value = float(line.strip(","))
        except ValueError:
            continue
        latest = value if latest is None else max(latest, value)
    return latest


def partial_hash(path: Path, size: int) -> str:
    """A hash of the first and last block plus the size: enough to tell two
    videos of the same size apart without reading gigabytes over the network."""
    digest = hashlib.sha1(str(size).encode("ascii"))
    with path.open("rb") as handle:
        digest.update(handle.read(PARTIAL_HASH_BYTES))
        if size > PARTIAL_HASH_BYTES * 2:
            handle.seek(size - PARTIAL_HASH_BYTES)
            digest.update(handle.read(PARTIAL_HASH_BYTES))
        elif size > PARTIAL_HASH_BYTES:
            digest.update(handle.read())
    return digest.hexdigest()


def difference_hash(gray: bytes) -> int:
    """64 bits from a 9x8 grey frame: is each pixel brighter than its right neighbour."""
    bits = 0
    for row in range(8):
        for column in range(8):
            left = gray[row * 9 + column]
            right = gray[row * 9 + column + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return bits


def fingerprint_video(path: Path, duration: float, thumbnail: Path | None = None) -> list[int] | None:
    """Difference hashes of two frames; None when a frame cannot be read.

    Two frames rather than one: plenty of unrelated videos share a black or
    title frame at any single position. The first frame is also saved as the
    report's thumbnail.
    """
    hashes: list[int] = []
    for index, position in enumerate(FINGERPRINT_POSITIONS):
        command = [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-ss",
            f"{duration * position:.3f}",
            "-i",
            str(path),
            "-frames:v",
            "1",
            "-vf",
            "scale=9:8,format=gray",
            "-f",
            "rawvideo",
            "-",
        ]
        if index == 0 and thumbnail is not None:
            command += ["-frames:v", "1", "-vf", f"scale={THUMBNAIL_WIDTH}:-2", "-q:v", "6", str(thumbnail)]
        try:
            frame = run_tool(command)
        except subprocess.TimeoutExpired:
            return None
        if frame.returncode != 0 or len(frame.stdout) < 72:
            return None
        hashes.append(difference_hash(frame.stdout[:72]))
    return hashes


def fingerprints_match(first: list[int], second: list[int]) -> bool:
    return all(bin(a ^ b).count("1") <= FINGERPRINT_MAX_DISTANCE for a, b in zip(first, second))


class Groups:
    """Union-find over file paths."""

    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, item: str) -> str:
        self.parent.setdefault(item, item)
        while self.parent[item] != item:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def join(self, first: str, second: str) -> None:
        self.parent[self.find(first)] = self.find(second)

    def members(self) -> list[list[str]]:
        grouped: dict[str, list[str]] = {}
        for item in self.parent:
            grouped.setdefault(self.find(item), []).append(item)
        return [sorted(group) for group in grouped.values() if len(group) > 1]


def keep_order(entry: tuple[str, dict[str, Any]]) -> tuple[Any, ...]:
    """Best copy first: most pixels, then most bytes, then a name that carries
    the video's id, then the least nested, then by name."""
    path, facts = entry
    return (
        -(int(facts.get("width") or 0) * int(facts.get("height") or 0)),
        -int(facts.get("size") or 0),
        not ID_NAMED_RE.match(os.path.basename(path)),
        path.count(os.sep),
        path,
    )


def duration_clusters(files: dict[str, dict[str, Any]]) -> list[list[str]]:
    """Files whose lengths sit within the tolerance of a neighbour's."""
    ordered = sorted(files, key=lambda path: files[path]["duration"])
    clusters: list[list[str]] = []
    current: list[str] = []
    for path in ordered:
        if current and files[path]["duration"] - files[current[-1]]["duration"] > DURATION_TOLERANCE_SECONDS:
            if len(current) > 1:
                clusters.append(current)
            current = []
        current.append(path)
    if len(current) > 1:
        clusters.append(current)
    return clusters


def find_duplicates(root: Path, files: dict[str, dict[str, Any]], state_dir: Path, progress: Any) -> list[dict[str, Any]]:
    """Groups of files that hold the same video.

    Identical: same size and same hash of the first and last block. Similar:
    same length and matching frames, which is the same video at another
    quality or re-uploaded.
    """
    healthy = {path: facts for path, facts in files.items() if not facts.get("error")}
    identical = Groups()

    by_size: dict[int, list[str]] = {}
    for path, facts in healthy.items():
        by_size.setdefault(facts["size"], []).append(path)
    for size, paths in by_size.items():
        if len(paths) < 2:
            continue
        by_hash: dict[str, list[str]] = {}
        for path in paths:
            if not healthy[path].get("hash"):
                try:
                    healthy[path]["hash"] = partial_hash(root / path, size)
                except OSError:
                    continue
            by_hash.setdefault(healthy[path]["hash"], []).append(path)
        for same in by_hash.values():
            for path in same[1:]:
                identical.join(same[0], path)

    def ordered(members: list[str]) -> list[tuple[str, dict[str, Any]]]:
        return sorted(((path, healthy[path]) for path in members), key=keep_order)

    report: list[dict[str, Any]] = []
    extra_copies: set[str] = set()
    for members in identical.members():
        copies = ordered(members)
        report.append({"kind": "identical", "files": [file_for_report(path, facts) for path, facts in copies]})
        extra_copies.update(path for path, _facts in copies[1:])

    # Identical copies are settled above; only the copy that would be kept is
    # compared any further, so a set never mixes the two kinds.
    distinct = {path: facts for path, facts in healthy.items() if path not in extra_copies}
    clusters = duration_clusters(distinct)
    wanted = [path for cluster in clusters for path in cluster if not distinct[path].get("fingerprint")]
    thumbs = thumbs_dir(state_dir)
    thumbs.mkdir(mode=PRIVATE_DIR_MODE, parents=True, exist_ok=True)

    def fingerprint(path: str) -> None:
        facts = distinct[path]
        thumbnail = thumbs / f"{thumbnail_key(path)}.jpg"
        facts["fingerprint"] = fingerprint_video(root / path, facts["duration"], thumbnail) or []

    with concurrent.futures.ThreadPoolExecutor(max_workers=SCAN_WORKERS) as pool:
        for done, _result in enumerate(pool.map(fingerprint, wanted), start=1):
            progress("Comparing videos of the same length", done, len(wanted))

    similar = Groups()
    for cluster in clusters:
        for index, first in enumerate(cluster):
            for second in cluster[index + 1 :]:
                if distinct[second]["duration"] - distinct[first]["duration"] > DURATION_TOLERANCE_SECONDS:
                    break
                prints = distinct[first].get("fingerprint"), distinct[second].get("fingerprint")
                if prints[0] and prints[1] and fingerprints_match(prints[0], prints[1]):
                    similar.join(first, second)

    for members in similar.members():
        report.append(
            {"kind": "similar", "files": [file_for_report(path, facts) for path, facts in ordered(members)]}
        )

    # The extra copies of an identical set have no frame of their own yet.
    for group in report:
        if group["kind"] == "identical":
            kept = thumbs / f"{group['files'][0]['thumb']}.jpg"
            if not kept.exists():
                first = group["files"][0]
                fingerprint_video(root / first["path"], healthy[first["path"]]["duration"], kept)
            for file in group["files"][1:]:
                file["thumb"] = group["files"][0]["thumb"]

    # Biggest waste first.
    report.sort(key=lambda group: -sum(file["size"] for file in group["files"][1:]))
    return report


def file_for_report(path: str, facts: dict[str, Any]) -> dict[str, Any]:
    return {
        "path": path,
        "size": int(facts.get("size") or 0),
        "duration": facts.get("duration"),
        "width": facts.get("width"),
        "height": facts.get("height"),
        "thumb": thumbnail_key(path),
    }


def scan_library(root: Path, state_dir: Path) -> dict[str, Any]:
    """Run a whole scan; returns the report. Called in the scan process."""
    started = time.strftime("%Y-%m-%d %H:%M:%S")
    last_status = 0.0

    def progress(stage: str, done: int, total: int, force: bool = False) -> None:
        nonlocal last_status
        now = time.monotonic()
        if not force and now - last_status < STATUS_INTERVAL_SECONDS:
            return
        last_status = now
        write_json(
            status_path(state_dir),
            {"state": "running", "stage": stage, "done": done, "total": total, "started_at": started, "pid": os.getpid()},
        )

    progress("Listing videos", 0, 0, force=True)
    index = load_index(state_dir)
    known: dict[str, dict[str, Any]] = index["files"]
    paths = library_videos(root)

    files: dict[str, dict[str, Any]] = {}
    to_probe: list[str] = []
    for path in paths:
        facts = known.get(path)
        try:
            stat = (root / path).stat()
        except OSError:
            to_probe.append(path)
            continue
        unchanged = facts and facts.get("size") == stat.st_size and facts.get("mtime") == int(stat.st_mtime)
        # A broken file is read again every time: there are few of them, and
        # the verdict should not outlive a better way of reaching it.
        if unchanged and not facts.get("error"):
            files[path] = facts
        else:
            to_probe.append(path)

    with concurrent.futures.ThreadPoolExecutor(max_workers=SCAN_WORKERS) as pool:
        results = pool.map(lambda path: (path, probe_video(root / path)), to_probe)
        for done, (path, facts) in enumerate(results, start=1):
            files[path] = facts
            progress("Reading videos", done, len(to_probe))
            if done % 500 == 0:
                # A scan of a large library can be interrupted; keep what is read.
                write_json(index_path(state_dir), {**index, "files": {**known, **files}})

    groups = find_duplicates(root, files, state_dir, progress)
    report = {
        "broken": sorted(
            ({"path": path, "error": facts["error"], "size": int(facts.get("size") or 0)} for path, facts in files.items() if facts.get("error")),
            key=lambda item: item["path"],
        ),
        "groups": groups,
        "scanned": len(files),
        "finished_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    write_json(index_path(state_dir), {"version": INDEX_VERSION, "files": files, "report": report})
    prune_thumbnails(state_dir, report)
    write_json(
        status_path(state_dir),
        {"state": "done", "started_at": started, "finished_at": report["finished_at"], "pid": os.getpid()},
    )
    return report


def prune_thumbnails(state_dir: Path, report: dict[str, Any]) -> None:
    wanted = {file["thumb"] for group in report["groups"] for file in group["files"]}
    try:
        for path in thumbs_dir(state_dir).glob("*.jpg"):
            if path.stem not in wanted:
                path.unlink(missing_ok=True)
    except OSError:
        pass


def run_scan_process(root: Path, state_dir: Path) -> int:
    """Entry point of the scan process: one scan at a time, failures recorded."""
    state_dir.mkdir(mode=PRIVATE_DIR_MODE, parents=True, exist_ok=True)
    with open(lock_path(state_dir), "a", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return 0  # Another scan is running.
        try:
            scan_library(root, state_dir)
            return 0
        except Exception as error:  # noqa: BLE001
            write_json(
                status_path(state_dir),
                {"state": "failed", "error": str(error), "finished_at": time.strftime("%Y-%m-%d %H:%M:%S")},
            )
            return 1


def scan_is_running(state_dir: Path) -> bool:
    """Whether a scan process holds the scan lock right now."""
    try:
        with open(lock_path(state_dir), "a", encoding="utf-8") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return True
            fcntl.flock(lock, fcntl.LOCK_UN)
    except OSError:
        return False
    return False


def scan_status(state_dir: Path) -> dict[str, Any]:
    status = read_json(status_path(state_dir)) or {"state": "never"}
    if status.get("state") == "running" and not scan_is_running(state_dir):
        # The scan process died without saying so.
        status = {"state": "failed", "error": "The scan stopped unexpectedly. Start it again; it resumes."}
    report = load_index(state_dir)["report"]
    extra = sum(file["size"] for group in report["groups"] for file in group["files"][1:])
    return {
        **status,
        "scanned": report["scanned"],
        "finished_at": report["finished_at"],
        "broken_count": len(report["broken"]),
        "group_count": len(report["groups"]),
        "identical_count": sum(1 for group in report["groups"] if group["kind"] == "identical"),
        "duplicate_bytes": extra,
    }


def start_scan(root: Path, state_dir: Path) -> dict[str, Any]:
    if not root.is_dir():
        return {"ok": False, "missing_dir": True, "error": f"The download folder is not available: {root}"}
    for tool in ("ffprobe", "ffmpeg"):
        if not shutil.which(tool):
            return {"ok": False, "error": f"The library check needs {tool}, which is not installed."}
    if scan_is_running(state_dir):
        return {"ok": True, "already_running": True}

    state_dir.mkdir(mode=PRIVATE_DIR_MODE, parents=True, exist_ok=True)
    write_json(
        status_path(state_dir),
        {"state": "running", "stage": "Starting", "done": 0, "total": 0, "started_at": time.strftime("%Y-%m-%d %H:%M:%S")},
    )
    subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--scan", str(root), str(state_dir)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return {"ok": True, "already_running": False}


def library_file(root: Path, relative_path: Any) -> Path:
    """The file a report path names, refusing anything outside the library."""
    text = str(relative_path or "")
    parts = Path(text).parts
    if not text or os.path.isabs(text) or ".." in parts or any(part.startswith(SKIP_PREFIXES) for part in parts):
        raise ValueError("That path is not a video in the library.")
    path = root / text
    if os.path.splitext(text)[1].lower() not in VIDEO_SUFFIXES or path.is_symlink():
        raise ValueError("That path is not a video in the library.")
    return path


def trash_destination(root: Path, relative_path: str) -> Path:
    """Where a file goes in the trash: same path below <library>/_trash, never over another."""
    target = root / TRASH_NAME / relative_path
    candidate = target
    number = 1
    while candidate.exists():
        candidate = target.with_name(f"{target.stem}.{number}{target.suffix}")
        number += 1
    return candidate


def trash_files(root: Path, state_dir: Path, relative_paths: list[Any]) -> dict[str, Any]:
    """Move files to the library's trash folder and take them out of the report."""
    if scan_is_running(state_dir):
        return {"ok": False, "error": "A library scan is running. Remove files when it has finished."}

    moved: list[str] = []
    failed: list[str] = []
    for relative_path in relative_paths:
        try:
            source = library_file(root, relative_path)
            destination = trash_destination(root, str(relative_path))
            destination.parent.mkdir(parents=True, exist_ok=True)
            source.rename(destination)
            moved.append(str(relative_path))
        except (OSError, ValueError) as error:
            failed.append(f"{relative_path}: {error}")

    if moved:
        forget_files(state_dir, set(moved))
    return {
        "ok": not failed,
        "moved": len(moved),
        "trash": str(root / TRASH_NAME),
        "error": f"Could not move {len(failed)} files. {failed[0]}" if failed else None,
    }


def forget_files(state_dir: Path, gone: set[str]) -> None:
    index = load_index(state_dir)
    for path in gone:
        index["files"].pop(path, None)
    report = index["report"]
    report["broken"] = [item for item in report["broken"] if item["path"] not in gone]
    groups = []
    for group in report["groups"]:
        files = [file for file in group["files"] if file["path"] not in gone]
        if len(files) > 1:
            groups.append({**group, "files": files})
    report["groups"] = groups
    report["scanned"] = len(index["files"])
    write_json(index_path(state_dir), index)


def report_page(state_dir: Path, kind: str, offset: int, limit: int) -> dict[str, Any]:
    report = load_index(state_dir)["report"]
    items = report["broken"] if kind == "broken" else [group for group in report["groups"] if group["kind"] == kind]
    offset = max(0, offset)
    limit = max(1, min(limit, 200))
    return {"ok": True, "kind": kind, "total": len(items), "offset": offset, "items": items[offset : offset + limit]}


def extra_identical_files(state_dir: Path) -> list[str]:
    """Every copy but the best of each group of identical files."""
    report = load_index(state_dir)["report"]
    return [file["path"] for group in report["groups"] if group["kind"] == "identical" for file in group["files"][1:]]


def main(argv: list[str]) -> int:
    if len(argv) == 4 and argv[1] == "--scan":
        return run_scan_process(Path(argv[2]), Path(argv[3]))
    print("usage: library_check.py --scan <library root> <state dir>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
