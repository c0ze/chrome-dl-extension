#!/usr/bin/python3 -I
"""vtag: tag and favorite the video Haruna is playing, and open tags as playlists.

Haruna custom commands call `vtag fav`, `vtag tag` and `vtag browse`; the
playing file comes from Haruna's MPRIS metadata, so Haruna passes nothing.
Tags live in SQLite (the NAS share is NFS 4.1, which has no user xattrs).
Tags are grouped by collection: the first folder under ROOT (group c, group d,
...), so each collection has its own favorites. Every change rewrites one
.m3u per collection and tag in ~/Videos/Tags/<collection>/<tag>.m3u, and the
links in each group folder's FAVORITES_DIR (see write_favorite_links).

ROOT is the downloader's download folder, so a collection is a group of the
downloader's library. The downloader's native host imports this module for
its favorites; ~/.local/bin/vtag links to the installed copy for Haruna.
"""

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse

HOME = Path.home()
DB_PATH = Path(os.environ.get("VTAG_DB", HOME / ".local/share/vtag/vtag.db"))
PLAYLIST_DIR = Path(os.environ.get("VTAG_PLAYLISTS", HOME / "Videos/Tags"))
DOWNLOADER_CONFIG = HOME / ".local/share/yt-dlp-browser-host/config.json"


def default_root():
    """VTAG_ROOT, else the downloader's download folder, else ~/Downloads."""
    if os.environ.get("VTAG_ROOT"):
        return Path(os.environ["VTAG_ROOT"])
    try:
        with open(DOWNLOADER_CONFIG, encoding="utf-8") as f:
            return Path(os.path.expanduser(json.load(f)["download_dir"]))
    except (OSError, ValueError, KeyError, TypeError):
        return HOME / "Downloads"


ROOT = default_root()
OTHER = "other"  # collection of files that are not in a folder under ROOT
OMARCHY_BIN = HOME / ".local/share/omarchy/bin"
FAVORITE = "favorite"
# A folder in each group (ROOT/<group>/) with links to the group's favorite
# videos. File managers can't group a listing, so it is named to sort first.
FAVORITES_DIR = "0 ★ Favorites"
NEW_TAG = "New tag…"
FP_CHUNK = 64 * 1024

ICON_TAG, ICON_STAR, ICON_NEW = "", "", ""


class VtagError(Exception):
    pass


# --- storage -----------------------------------------------------------------

def connect(path=None):
    path = Path(path or DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            size INTEGER,
            fp TEXT,
            added REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS files_fp ON files(fp);
        CREATE TABLE IF NOT EXISTS tags (
            file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            added REAL NOT NULL,
            PRIMARY KEY (file_id, tag)
        );
    """)
    return db


def fingerprint(path):
    """Size plus a hash of the first and last 64 KiB: cheap over NFS, and
    stable across a move or rename."""
    size = os.path.getsize(path)
    h = hashlib.sha1(str(size).encode())
    with open(path, "rb") as f:
        h.update(f.read(FP_CHUNK))
        if size > FP_CHUNK:
            f.seek(max(FP_CHUNK, size - FP_CHUNK))
            h.update(f.read(FP_CHUNK))
    return size, h.hexdigest()


def lookup(db, path):
    """Row id for path, or None. A file that was moved keeps its tags: a new
    path whose fingerprint matches a row whose path is gone takes that row
    over. Returns (id, size, fp); size and fp are None when the path matched."""
    row = db.execute("SELECT id FROM files WHERE path = ?", (path,)).fetchone()
    if row:
        return row[0], None, None
    size, fp = fingerprint(path)
    for fid, old in db.execute("SELECT id, path FROM files WHERE fp = ?", (fp,)).fetchall():
        if not os.path.exists(old):
            db.execute("UPDATE files SET path = ?, size = ? WHERE id = ?", (path, size, fid))
            db.commit()
            return fid, None, None
    return None, size, fp


def file_id(db, path):
    path = str(Path(path).resolve())
    fid, size, fp = lookup(db, path)
    if fid is not None:
        return fid
    cur = db.execute("INSERT INTO files (path, size, fp, added) VALUES (?, ?, ?, ?)",
                     (path, size, fp, time.time()))
    return cur.lastrowid


def clean_tag(tag):
    return " ".join(tag.split()).lower()


def tags_of(db, path):
    fid, _, _ = lookup(db, str(Path(path).resolve()))
    if fid is None:
        return []
    rows = db.execute("SELECT tag FROM tags WHERE file_id = ? ORDER BY tag", (fid,))
    return [r[0] for r in rows]


def set_tags(db, path, tags):
    """Make path's tags exactly `tags`. Returns (added, removed)."""
    want = {clean_tag(t) for t in tags if clean_tag(t)}
    fid = file_id(db, path)
    have = {r[0] for r in db.execute("SELECT tag FROM tags WHERE file_id = ?", (fid,))}
    now = time.time()
    db.executemany("INSERT INTO tags (file_id, tag, added) VALUES (?, ?, ?)",
                   [(fid, t, now) for t in want - have])
    db.executemany("DELETE FROM tags WHERE file_id = ? AND tag = ?",
                   [(fid, t) for t in have - want])
    db.execute("DELETE FROM files WHERE id = ? AND NOT EXISTS "
               "(SELECT 1 FROM tags WHERE file_id = ?)", (fid, fid))
    db.commit()
    return sorted(want - have), sorted(have - want)


def all_tags(db):
    """[(tag, count)], favorite first, then by use."""
    rows = db.execute("SELECT tag, COUNT(*) FROM tags GROUP BY tag").fetchall()
    return sorted(rows, key=lambda r: (r[0] != FAVORITE, -r[1], r[0]))


def collection(path):
    """First folder under ROOT ("group c"), or OTHER."""
    try:
        parts = Path(path).relative_to(ROOT).parts
    except ValueError:
        return OTHER
    return parts[0] if len(parts) > 1 else OTHER


def groups(db, first=None):
    """{(collection, tag): [path, ...]} with paths newest tagging first, in
    menu order: collection `first`, then by name; favorite first in each."""
    out = {}
    rows = db.execute("SELECT f.path, t.tag FROM files f JOIN tags t ON t.file_id = f.id "
                      "ORDER BY t.added DESC")
    for path, tag in rows:
        out.setdefault((collection(path), tag), []).append(path)
    order = sorted(out, key=lambda k: (k[0] != first, k[0].lower(), k[1] != FAVORITE,
                                       -len(out[k]), k[1]))
    return {k: out[k] for k in order}


# --- playlists ---------------------------------------------------------------

def playlist_path(coll, tag, out_dir=None):
    safe = lambda s: s.replace("/", "∕")
    return Path(out_dir or PLAYLIST_DIR) / safe(coll) / (safe(tag) + ".m3u")


def write_playlists(db, out_dir=None):
    """One .m3u per collection and tag, newest tagging first; files that are
    gone are left out. Playlists nothing uses any more are removed."""
    out_dir = Path(out_dir or PLAYLIST_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    keep = set()
    for (coll, tag), paths in groups(db).items():
        pl = playlist_path(coll, tag, out_dir)
        keep.add(pl)
        pl.parent.mkdir(exist_ok=True)
        lines = ["#EXTM3U"]
        for p in paths:
            if os.path.exists(p):
                lines += [f"#EXTINF:-1,{Path(p).stem}", p]
        tmp = pl.with_name(pl.name + ".tmp")
        tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
        tmp.replace(pl)
    for old in out_dir.rglob("*.m3u"):
        if old not in keep:
            old.unlink()
    for d in out_dir.iterdir():
        if d.is_dir() and not any(d.iterdir()):
            d.rmdir()


def link_name(path, taken):
    """The video's own name, made unique within one favorites folder."""
    name = Path(path).name
    stem, suffix, n = Path(path).stem, Path(path).suffix, 2
    while name in taken:
        name, n = f"{stem} ({n}){suffix}", n + 1
    taken.add(name)
    return name


def write_favorite_links(db, root=None):
    """Make each group's FAVORITES_DIR hold exactly one link per favorite video
    in that group. Only links are ever created or deleted there; anything else
    in the folder is left alone. A favorite counts for a group when it sits in
    a handle folder below it (ROOT/<group>/<handle>/...)."""
    root = Path(root or ROOT)
    wanted = {}
    for (coll, tag), paths in groups(db).items():
        if tag != FAVORITE:
            continue
        for p in paths:
            try:
                parts = Path(p).relative_to(root).parts
            except ValueError:
                continue
            if len(parts) >= 3 and parts[0] == coll and os.path.exists(p):
                wanted.setdefault(coll, []).append(p)
    present = {d.parent.name for d in root.glob(f"*/{FAVORITES_DIR}") if d.is_dir()}
    for coll in sorted(set(wanted) | present):
        folder = root / coll / FAVORITES_DIR
        taken, links = set(), {}
        for p in sorted(wanted.get(coll, [])):
            links[link_name(p, taken)] = os.path.relpath(p, folder)
        if links:
            folder.mkdir(exist_ok=True)
        if not folder.is_dir():
            continue
        for entry in folder.iterdir():
            if entry.is_symlink() and os.readlink(entry) != links.get(entry.name):
                entry.unlink()
        for name, target in links.items():
            if not (folder / name).is_symlink():
                (folder / name).symlink_to(target)
        if not links and not any(folder.iterdir()):
            folder.rmdir()


def publish(db):
    """Everything that shows the tags outside the database: the playlists and
    the favorites folders. A folder that can't be written (the share is
    offline) is reported, never fatal: the tag itself is saved."""
    write_playlists(db)
    try:
        write_favorite_links(db)
    except OSError as e:
        print(f"vtag: could not update the favorites folders: {e}", file=sys.stderr)


# --- desktop -----------------------------------------------------------------

def current_file():
    """The file Haruna is playing, from its MPRIS metadata."""
    try:
        url = subprocess.run(["playerctl", "-p", "haruna", "metadata", "xesam:url"],
                             capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        raise VtagError(f"playerctl failed: {e}")
    if not url:
        raise VtagError("Haruna is not playing anything")
    u = urlparse(url)
    if u.scheme != "file":
        raise VtagError(f"not a local file: {url}")
    return unquote(u.path)


def notify(summary, body=""):
    subprocess.run(["notify-send", "-a", "vtag", "-i", "haruna", "-t", "2500",
                    summary, body], check=False)


def menu(cmd, *args):
    """Run an omarchy-menu-* helper; None when the menu was dismissed."""
    env = dict(os.environ, PATH=f"{OMARCHY_BIN}:{os.environ.get('PATH', '')}")
    r = subprocess.run([str(OMARCHY_BIN / cmd), *args], capture_output=True,
                       text=True, env=env)
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def pick_tags(current, known):
    """Multi-select over known tags with the current ones checked. Returns
    the new tag list, or None if dismissed."""
    if not known:
        typed = menu("omarchy-menu-input", "New tags (comma separated)")
        return None if typed is None else current + typed.split(",")
    options = [f"{ICON_NEW}\t{NEW_TAG}"]
    options += [f"{ICON_STAR if t == FAVORITE else ICON_TAG}\t{t}" for t in known]
    args = ["Tags", *options, "--", "--multiple"]
    for t in current:
        args += ["--selected", t]
    out = menu("omarchy-menu-select", *args)
    if out is None:
        return None
    chosen = json.loads(out)
    if NEW_TAG in chosen:
        chosen.remove(NEW_TAG)
        typed = menu("omarchy-menu-input", "New tags (comma separated)")
        if typed:
            chosen += typed.split(",")
    return chosen


SEP = " › "


def playing_collection():
    try:
        return collection(current_file())
    except VtagError:
        return None


def pick_tag(db):
    """Menu of "collection › tag" rows, the playing video's collection first.
    Returns (collection, tag) or None."""
    rows = groups(db, first=playing_collection())
    if not rows:
        raise VtagError("No tagged videos yet")
    options = [f"{ICON_STAR if t == FAVORITE else ICON_TAG}\t{c}{SEP}{t}\t"
               f"{len(p)} video{'s' * (len(p) != 1)}" for (c, t), p in rows.items()]
    out = menu("omarchy-menu-select", "Open tag", *options)
    if not out:
        return None
    coll, _, tag = out.split("\t")[0].rpartition(SEP)
    return coll, tag


def open_tag(db, coll, tag):
    publish(db)
    pl = playlist_path(coll, tag)
    if not pl.exists():
        raise VtagError(f"No videos tagged {tag!r} in {coll!r}")
    subprocess.Popen(["haruna", str(pl)], start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# --- commands ----------------------------------------------------------------

def cmd_fav(db, args):
    path = args[0] if args else current_file()
    tags = tags_of(db, path)
    on = FAVORITE not in tags
    set_tags(db, path, tags + [FAVORITE] if on else [t for t in tags if t != FAVORITE])
    publish(db)
    coll = collection(path)
    notify(f"★ Favorited in {coll}" if on else f"☆ Unfavorited in {coll}", Path(path).name)


def cmd_tag(db, args):
    path = args[0] if args else current_file()
    current = tags_of(db, path)
    known = [t for t, _ in all_tags(db)]
    new = pick_tags(current, known)
    if new is None:
        return
    added, removed = set_tags(db, path, new)
    publish(db)
    if added or removed:
        notify("Tags: " + (", ".join(tags_of(db, path)) or "none"),
               " ".join([f"+{t}" for t in added] + [f"−{t}" for t in removed]))


def cmd_browse(db, args):
    if len(args) == 1:
        raise VtagError("usage: vtag browse [COLLECTION TAG]")
    picked = (args[0], clean_tag(args[1])) if args else pick_tag(db)
    if picked:
        open_tag(db, *picked)


def cmd_add(db, args):
    if len(args) < 2:
        raise VtagError("usage: vtag add FILE TAG...")
    set_tags(db, args[0], tags_of(db, args[0]) + args[1:])
    publish(db)


def cmd_rm(db, args):
    if len(args) < 2:
        raise VtagError("usage: vtag rm FILE TAG...")
    drop = {clean_tag(t) for t in args[1:]}
    set_tags(db, args[0], [t for t in tags_of(db, args[0]) if t not in drop])
    publish(db)


def cmd_show(db, args):
    path = args[0] if args else current_file()
    print(path)
    print(", ".join(tags_of(db, path)) or "(no tags)")


def cmd_tags(db, args):
    for (coll, tag), paths in groups(db).items():
        print(f"{len(paths):5}  {coll}{SEP}{tag}")


def cmd_list(db, args):
    tag = clean_tag(args[0]) if args else FAVORITE
    for (coll, t), paths in groups(db).items():
        if t != tag or (len(args) > 1 and coll != args[1]):
            continue
        print(f"{coll}{SEP}{t}")
        for p in paths:
            print("  " + (p if os.path.exists(p) else f"{p}  (missing)"))


def cmd_sync(db, args):
    publish(db)
    print(PLAYLIST_DIR)


COMMANDS = {
    "fav": (cmd_fav, "toggle favorite on the playing video (or FILE)"),
    "tag": (cmd_tag, "pick tags for the playing video (or FILE) in a menu"),
    "browse": (cmd_browse, "pick a collection › tag (or give COLLECTION TAG), open in Haruna"),
    "add": (cmd_add, "FILE TAG...: add tags"),
    "rm": (cmd_rm, "FILE TAG...: remove tags"),
    "show": (cmd_show, "tags of the playing video (or FILE)"),
    "tags": (cmd_tags, "tags per collection, with counts"),
    "list": (cmd_list, "[TAG [COLLECTION]]: tagged files (default: favorite)"),
    "sync": (cmd_sync, f"rewrite the playlists in {PLAYLIST_DIR}"),
}


def main(argv):
    if not argv or argv[0] not in COMMANDS:
        print("usage: vtag COMMAND [args]\n")
        for name, (_, desc) in COMMANDS.items():
            print(f"  {name:7} {desc}")
        return 0 if argv[:1] in ([], ["-h"], ["--help"]) else 2
    fn = COMMANDS[argv[0]][0]
    db = connect()
    try:
        fn(db, argv[1:])
    except (VtagError, OSError) as e:
        print(f"vtag: {e}", file=sys.stderr)
        if not sys.stdout.isatty():
            notify("vtag", str(e))
        return 1
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
