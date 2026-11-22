"""Favorites and removals for the downloader's library.

Favorites are vtag's: the same SQLite database Haruna's mouse button writes,
so a video favorited in either place is a favorite in both. A collection is
the first folder under the library root, which is a group in the downloader.

Removing a video deletes its file for good but keeps a record of it (where it
was, its post, its size and a thumbnail) in removed.json, and puts its id in
yt-dlp's download archive so it is not downloaded again. "Allow again" lifts
that block. Nothing here decides which files to remove: callers pass them.
"""
from __future__ import annotations

import contextlib
import errno
import json
import os
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Iterator

import library_check
import vtag

FAVORITE = vtag.FAVORITE
# <uploader>-<id>.<ext>, the name the downloader gives a video: its id is the
# one yt-dlp's archive records.
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_]{1,15}-(\d{10,})\.")
THUMBNAIL_WIDTH = 320
FRAME_TIMEOUT_SECONDS = 30
PRIVATE_FILE_MODE = 0o600
PRIVATE_DIR_MODE = 0o700
MAX_REMOVED_PAGE = 200


# --- favorites ---------------------------------------------------------------

@contextlib.contextmanager
def open_favorites(root: Path, db_path: Path | None = None) -> Iterator[Any]:
    """vtag's database, with vtag's groups taken from root (the library)."""
    vtag.ROOT = root
    db = vtag.connect(db_path)
    try:
        yield db
    finally:
        db.close()


def is_favorite(db, path: Path) -> bool:
    """By exact path only: never reads the file, so it is cheap for a long list."""
    row = db.execute(
        "SELECT 1 FROM files f JOIN tags t ON t.file_id = f.id WHERE f.path = ? AND t.tag = ?",
        (str(path), FAVORITE),
    ).fetchone()
    return row is not None


def favorite_paths(db) -> set[str]:
    rows = db.execute(
        "SELECT f.path FROM files f JOIN tags t ON t.file_id = f.id WHERE t.tag = ?", (FAVORITE,)
    )
    return {row[0] for row in rows}


def set_favorite(db, path: Path, on: bool) -> bool:
    """Make path a favorite or not; returns whether it is one now."""
    tags = vtag.tags_of(db, str(path))
    if on and FAVORITE not in tags:
        vtag.set_tags(db, str(path), [*tags, FAVORITE])
    elif not on and FAVORITE in tags:
        vtag.set_tags(db, str(path), [tag for tag in tags if tag != FAVORITE])
    vtag.publish(db)
    return on


def collection_of(root: Path, path: Path) -> str:
    """The group a file is in: its first folder under root, or vtag's "other"."""
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        return vtag.OTHER
    return parts[0] if len(parts) > 1 else vtag.OTHER


def favorites(db, root: Path, group: str | None = None) -> dict[str, Any]:
    """Favorites per group, newest first; with `group`, that group's videos."""
    rows = db.execute(
        "SELECT f.path, t.added FROM files f JOIN tags t ON t.file_id = f.id "
        "WHERE t.tag = ? ORDER BY t.added DESC",
        (FAVORITE,),
    ).fetchall()
    counts: dict[str, int] = {}
    items: list[dict[str, Any]] = []
    for raw_path, added in rows:
        path = Path(raw_path)
        name = collection_of(root, path)
        counts[name] = counts.get(name, 0) + 1
        if group is None or name != group:
            continue
        try:
            relative = str(path.relative_to(root))
        except ValueError:
            relative = ""
        items.append(
            {
                "path": str(path),
                "relative": relative,
                "name": path.name,
                "handle": path.parent.name,
                "exists": path.is_file(),
                "added": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(added)),
                "thumb": library_check.thumbnail_key(relative or str(path)),
            }
        )
    return {"ok": True, "groups": counts, "group": group, "items": items}


def playlist_for(group: str) -> Path:
    return vtag.playlist_path(group, FAVORITE)


# --- thumbnails --------------------------------------------------------------

def grab_frame(video: Path, target: Path) -> bool:
    """A small frame of video at target; one second in, or the start of a shorter clip."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    target.parent.mkdir(mode=PRIVATE_DIR_MODE, parents=True, exist_ok=True)
    for seek in ("1", "0"):
        try:
            subprocess.run(
                [ffmpeg, "-y", "-loglevel", "error", "-ss", seek, "-i", str(video), "-frames:v", "1",
                 "-vf", f"scale={THUMBNAIL_WIDTH}:-2", "-q:v", "5", str(target)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=FRAME_TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        if target.is_file() and target.stat().st_size > 0:
            target.chmod(PRIVATE_FILE_MODE)
            return True
    target.unlink(missing_ok=True)
    return False


def video_length(video: Path) -> float | None:
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
            stdin=subprocess.DEVNULL, capture_output=True, timeout=FRAME_TIMEOUT_SECONDS,
        )
        return round(float(probe.stdout.decode().strip()), 3)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


# --- removals ----------------------------------------------------------------

def removed_path(state_dir: Path) -> Path:
    return state_dir / "removed.json"


def removed_thumbs(state_dir: Path) -> Path:
    return state_dir / "removed-thumbs"


def read_removed(state_dir: Path) -> list[dict[str, Any]]:
    try:
        with removed_path(state_dir).open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return []
    items = data.get("items") if isinstance(data, dict) else None
    return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def write_removed(state_dir: Path, items: list[dict[str, Any]]) -> None:
    state_dir.mkdir(mode=PRIVATE_DIR_MODE, parents=True, exist_ok=True)
    target = removed_path(state_dir)
    temp = target.with_name(f"{target.name}.{os.getpid()}.tmp")
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, PRIVATE_FILE_MODE)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump({"items": items}, handle, indent=1)
    temp.replace(target)


def video_id(path: Path) -> str | None:
    match = VIDEO_ID_RE.match(path.name)
    return match.group(1) if match else None


def archive_lines(archive: Path) -> list[str]:
    try:
        return archive.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []


def block_download(archive: Path, ident: str) -> bool:
    """Add the id to the archive; True when this call added it (it was not there)."""
    line = f"twitter {ident}"
    if line in archive_lines(archive):
        return False
    archive.parent.mkdir(mode=PRIVATE_DIR_MODE, parents=True, exist_ok=True)
    descriptor = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_APPEND, PRIVATE_FILE_MODE)
    with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")
    return True


def unblock_download(archive: Path, ident: str) -> None:
    lines = archive_lines(archive)
    kept = [line for line in lines if line != f"twitter {ident}"]
    if len(kept) == len(lines):
        return
    temp = archive.with_name(f"{archive.name}.{os.getpid()}.tmp")
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, PRIVATE_FILE_MODE)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write("".join(f"{line}\n" for line in kept))
    temp.replace(archive)


def remove_videos(
    root: Path,
    state_dir: Path,
    archive: Path,
    targets: list[dict[str, Any]],
    db=None,
) -> dict[str, Any]:
    """Delete videos from the library and record them as removed.

    Each target names a file relative to root ("relative"), and may carry the
    post's "url", a "thumb" picture that already exists and a "reason". The
    record and its thumbnail are written before the file is deleted, so a
    failure never leaves a video gone without a trace.
    """
    records = read_removed(state_dir)
    removed: list[str] = []
    failed: list[str] = []
    for target in targets:
        relative = str(target.get("relative") or "")
        try:
            video = library_check.library_file(root, relative)
            if not video.is_file():
                raise ValueError("the file is not there any more")
            if not library_check.inside_library(root, video):
                raise ValueError("the file is outside the library")
        except (OSError, ValueError) as error:
            failed.append(f"{relative or '?'}: {error}")
            continue

        record_id = uuid.uuid4().hex
        picture = removed_thumbs(state_dir) / f"{record_id}.jpg"
        existing = Path(str(target.get("thumb") or ""))
        has_picture = False
        if target.get("thumb") and existing.is_file():
            picture.parent.mkdir(mode=PRIVATE_DIR_MODE, parents=True, exist_ok=True)
            shutil.copyfile(existing, picture)
            picture.chmod(PRIVATE_FILE_MODE)
            has_picture = True
        else:
            has_picture = grab_frame(video, picture)

        ident = video_id(video)
        favorite = bool(db is not None and is_favorite(db, video))
        record = {
            "id": record_id,
            "relative": relative,
            "name": video.name,
            "handle": video.parent.name,
            "group": collection_of(root, video),
            "url": target.get("url") or None,
            "video_id": ident,
            "size": video.stat().st_size,
            "duration": video_length(video),
            "favorite": favorite,
            "reason": target.get("reason") or "removed",
            "removed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "thumb": has_picture,
        }
        records.insert(0, record)
        write_removed(state_dir, records)
        blocked = block_download(archive, ident) if ident else False

        try:
            # Checked again now: a folder may have been swapped for a symlink since.
            if not library_check.inside_library(root, video):
                raise OSError(errno.EPERM, "the file is outside the library")
            video.unlink()
        except OSError as error:
            # Keep the list honest: the file is still there.
            records.remove(record)
            write_removed(state_dir, records)
            picture.unlink(missing_ok=True)
            if blocked and ident:
                unblock_download(archive, ident)
            failed.append(f"{relative}: {error.strerror or error}")
            continue

        if favorite:
            set_favorite(db, video, False)
        removed.append(relative)

    if removed:
        library_check.forget_files(state_dir, set(removed))
    return {
        "ok": not failed,
        "removed": len(removed),
        "paths": removed,
        "error": f"Could not remove {len(failed)} of {len(targets)}. {failed[0]}" if failed else None,
    }


def removed_page(state_dir: Path, offset: int, limit: int) -> dict[str, Any]:
    items = read_removed(state_dir)
    offset = max(0, offset)
    limit = max(1, min(limit, MAX_REMOVED_PAGE))
    return {"ok": True, "total": len(items), "offset": offset, "items": items[offset : offset + limit]}


def allow_again(state_dir: Path, archive: Path, record_id: str) -> dict[str, Any]:
    """Forget a removal, so the video can be downloaded again."""
    records = read_removed(state_dir)
    record = next((item for item in records if item.get("id") == record_id), None)
    if record is None:
        return {"ok": False, "error": "That removed video is not in the list."}
    if record.get("video_id"):
        unblock_download(archive, str(record["video_id"]))
    records.remove(record)
    write_removed(state_dir, records)
    if re.fullmatch(r"[0-9a-f]{32}", record_id):
        (removed_thumbs(state_dir) / f"{record_id}.jpg").unlink(missing_ok=True)
    return {"ok": True, "url": record.get("url")}


def removed_url_keys(state_dir: Path, key: Any) -> set[str]:
    """The posts of removed videos, by the host's duplicate key.

    A removal made from a file alone (Favorites, the library check) has no post
    link, but its file name still carries the post's id, the one the archive holds.
    That id names an X post only for a record with an X link or no link at all
    (and a path in the library); a Facebook reel's own id says nothing about X.
    """
    x_prefix = key("https://x.com/i/status/1")[:-1]
    keys = set()
    for item in read_removed(state_dir):
        url = item.get("url")
        if url:
            keys.add(key(url))
        ident = str(item.get("video_id") or "")
        names_x_post = key(url).startswith(x_prefix) if url else bool(item.get("relative"))
        if ident.isdigit() and names_x_post:
            keys.add(key(f"https://x.com/i/status/{ident}"))
    return keys
