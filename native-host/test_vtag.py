import json
import os
import tempfile
import unittest
from pathlib import Path

import vtag


class VtagTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.db = vtag.connect(self.root / "db" / "vtag.db")
        self.pl = self.root / "playlists"
        vtag.PLAYLIST_DIR = self.pl
        vtag.ROOT = self.root  # videos/ is the collection "videos"
        self.notes = []
        vtag.notify = lambda s, b="": self.notes.append((s, b))
        self.menus = []
        vtag.menu = lambda cmd, *a: self.menus.pop(0)(cmd, a)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def video(self, name, data=b"x" * 200_000):
        p = self.root / "videos" / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return str(p)

    def test_set_tags_normalises_and_reports_changes(self):
        v = self.video("a.mp4")
        self.assertEqual(vtag.set_tags(self.db, v, ["Dance ", " dance", "Long  Take"]),
                         (["dance", "long take"], []))
        self.assertEqual(vtag.set_tags(self.db, v, ["dance", "outdoor"]),
                         (["outdoor"], ["long take"]))
        self.assertEqual(vtag.tags_of(self.db, v), ["dance", "outdoor"])

    def test_removing_all_tags_forgets_the_file(self):
        v = self.video("a.mp4")
        vtag.set_tags(self.db, v, ["dance"])
        vtag.set_tags(self.db, v, [])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM files").fetchone()[0], 0)

    def test_fav_toggles_and_writes_playlist(self):
        v = self.video("我的 video.mp4")
        vtag.cmd_fav(self.db, [v])
        self.assertEqual(vtag.tags_of(self.db, v), ["favorite"])
        text = (self.pl / "videos" / "favorite.m3u").read_text(encoding="utf-8")
        self.assertIn(v, text.splitlines())
        self.assertIn("#EXTINF:-1,我的 video", text)
        vtag.cmd_fav(self.db, [v])
        self.assertEqual(vtag.tags_of(self.db, v), [])
        self.assertEqual(list(self.pl.iterdir()), [])
        self.assertEqual([n[0] for n in self.notes],
                         ["★ Favorited in videos", "☆ Unfavorited in videos"])

    def test_each_collection_has_its_own_favorites(self):
        a = self.video("a.mp4", b"a" * 10)
        b = str(self.root / "group d" / "someone" / "b.mp4")
        Path(b).parent.mkdir(parents=True)
        Path(b).write_bytes(b"b" * 10)
        (self.pl).mkdir()
        (self.pl / "favorite.m3u").write_text("old flat playlist\n")
        vtag.cmd_fav(self.db, [a])
        vtag.cmd_fav(self.db, [b])
        self.assertEqual(sorted(str(p.relative_to(self.pl)) for p in self.pl.rglob("*.m3u")),
                         ["group d/favorite.m3u", "videos/favorite.m3u"])
        self.assertNotIn(a, (self.pl / "group d" / "favorite.m3u").read_text())
        self.assertEqual(list(vtag.groups(self.db, first="videos")),
                         [("videos", "favorite"), ("group d", "favorite")])

    def test_collection_is_first_folder_under_root(self):
        self.assertEqual(vtag.collection(self.root / "group c" / "x" / "y.mp4"), "group c")
        self.assertEqual(vtag.collection(self.root / "group c" / "y.mp4"), "group c")
        self.assertEqual(vtag.collection(self.root / "loose.mp4"), vtag.OTHER)
        self.assertEqual(vtag.collection("/elsewhere/y.mp4"), vtag.OTHER)

    def test_fav_uses_playing_file(self):
        v = self.video("a.mp4")
        vtag.current_file = lambda: v
        vtag.cmd_fav(self.db, [])
        self.assertEqual(vtag.tags_of(self.db, v), ["favorite"])

    def test_moved_file_keeps_its_tags(self):
        v = self.video("a.mp4", os.urandom(300_000))
        vtag.set_tags(self.db, v, ["dance"])
        moved = str(Path(v).with_name("renamed.mp4"))
        os.rename(v, moved)
        self.assertEqual(vtag.tags_of(self.db, moved), ["dance"])
        vtag.set_tags(self.db, moved, vtag.tags_of(self.db, moved) + ["new"])
        self.assertEqual(vtag.tags_of(self.db, moved), ["dance", "new"])
        # the renamed file took over the old row instead of adding one
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM files").fetchone()[0], 1)

    def test_copy_does_not_steal_tags(self):
        data = os.urandom(300_000)
        a, b = self.video("a.mp4", data), self.video("b.mp4", data)
        vtag.set_tags(self.db, a, ["dance"])
        vtag.set_tags(self.db, b, ["other"])
        self.assertEqual(vtag.tags_of(self.db, a), ["dance"])
        self.assertEqual(vtag.tags_of(self.db, b), ["other"])

    def test_playlists_skip_missing_files_and_order_newest_first(self):
        a, b = self.video("a.mp4", b"a" * 1000), self.video("b.mp4", b"b" * 1000)
        vtag.set_tags(self.db, a, ["dance"])
        vtag.set_tags(self.db, b, ["dance"])
        self.db.execute("UPDATE tags SET added = 1 WHERE file_id = "
                        "(SELECT id FROM files WHERE path = ?)", (a,))
        vtag.write_playlists(self.db)
        pl = self.pl / "videos" / "dance.m3u"
        paths = [l for l in pl.read_text().splitlines() if not l.startswith("#")]
        self.assertEqual(paths, [b, a])
        os.remove(b)
        vtag.write_playlists(self.db)
        self.assertNotIn(b, pl.read_text())

    def test_tag_menu_checks_current_tags_and_adds_typed_ones(self):
        v, w = self.video("a.mp4", b"a" * 10), self.video("b.mp4", b"b" * 10)
        vtag.set_tags(self.db, w, ["favorite", "dance"])
        vtag.set_tags(self.db, v, ["dance"])
        seen = {}

        def select(cmd, args):
            seen["args"] = args
            return json.dumps(["favorite", vtag.NEW_TAG])

        self.menus = [select, lambda cmd, args: "Outdoor, night"]
        vtag.cmd_tag(self.db, [v])
        self.assertEqual(vtag.tags_of(self.db, v), ["favorite", "night", "outdoor"])
        args = list(seen["args"])
        self.assertEqual(args[args.index("--selected") + 1], "dance")
        self.assertEqual(args[1], f"{vtag.ICON_NEW}\t{vtag.NEW_TAG}")
        self.assertEqual(args[2], f"{vtag.ICON_STAR}\tfavorite")

    def test_dismissed_tag_menu_changes_nothing(self):
        v = self.video("a.mp4")
        vtag.set_tags(self.db, v, ["dance"])
        self.menus = [lambda cmd, args: None]
        vtag.cmd_tag(self.db, [v])
        self.assertEqual(vtag.tags_of(self.db, v), ["dance"])

    def test_first_tag_goes_straight_to_input(self):
        v = self.video("a.mp4")
        self.menus = [lambda cmd, args: "dance" if cmd == "omarchy-menu-input" else None]
        vtag.cmd_tag(self.db, [v])
        self.assertEqual(vtag.tags_of(self.db, v), ["dance"])

    def test_browse_picks_tag_from_menu_row(self):
        v = self.video("a.mp4")
        vtag.set_tags(self.db, v, ["dance"])
        opened = []
        vtag.open_tag = lambda db, coll, tag: opened.append((coll, tag))
        vtag.current_file = lambda: (_ for _ in ()).throw(vtag.VtagError("idle"))
        self.menus = [lambda cmd, args: "hard › ch › dance\t1 video"]
        vtag.cmd_browse(self.db, [])
        self.assertEqual(opened, [("hard › ch", "dance")])


if __name__ == "__main__":
    unittest.main()


class FavoriteLinksTest(unittest.TestCase):
    """Each group folder shows its favorite videos first, as links in FAVORITES_DIR."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "library"
        self.db = vtag.connect(Path(self.tmp.name) / "vtag.db")
        self.saved = (vtag.ROOT, vtag.PLAYLIST_DIR)
        vtag.ROOT = self.root
        vtag.PLAYLIST_DIR = Path(self.tmp.name) / "playlists"

    def tearDown(self):
        vtag.ROOT, vtag.PLAYLIST_DIR = self.saved
        self.db.close()
        self.tmp.cleanup()

    def video(self, relative, data=b"x" * 1000):
        p = self.root / relative
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return str(p)

    def favorite(self, path, on=True):
        tags = vtag.tags_of(self.db, path)
        vtag.set_tags(self.db, path, tags + ["favorite"] if on else [t for t in tags if t != "favorite"])
        vtag.publish(self.db)

    def folder(self, group):
        return self.root / group / vtag.FAVORITES_DIR

    def test_a_favorite_appears_as_a_link_in_its_groups_favorites_folder(self):
        v = self.video("group d/alice/alice-1.mp4")

        self.favorite(v)

        link = self.folder("group d") / "alice-1.mp4"
        self.assertTrue(link.is_symlink())
        # Relative, so it works from every machine that mounts the share elsewhere.
        self.assertEqual(os.readlink(link), "../alice/alice-1.mp4")
        self.assertEqual(link.resolve(), Path(v).resolve())

    def test_unfavoriting_removes_the_link_and_the_empty_folder(self):
        v = self.video("group d/alice/alice-1.mp4")
        self.favorite(v)

        self.favorite(v, on=False)

        self.assertFalse(self.folder("group d").exists())

    def test_the_folder_sorts_before_every_handle(self):
        names = sorted([vtag.FAVORITES_DIR, "0abc", "1234_name", "Alice", "_x"], key=str.lower)
        self.assertEqual(names[0], vtag.FAVORITES_DIR)

    def test_two_favorites_with_the_same_name_both_get_a_link(self):
        self.favorite(self.video("group d/alice/clip.mp4"))
        self.favorite(self.video("group d/bob/clip.mp4", b"y" * 1000))

        self.assertEqual(sorted(p.name for p in self.folder("group d").iterdir()), ["clip (2).mp4", "clip.mp4"])

    def test_each_group_has_its_own_folder(self):
        self.favorite(self.video("group d/alice/a.mp4"))
        self.favorite(self.video("group c/bob/b.mp4", b"y" * 1000))

        self.assertEqual([p.name for p in self.folder("group d").iterdir()], ["a.mp4"])
        self.assertEqual([p.name for p in self.folder("group c").iterdir()], ["b.mp4"])

    def test_anything_that_is_not_a_link_is_left_alone(self):
        v = self.video("group d/alice/a.mp4")
        self.favorite(v)
        (self.folder("group d") / "notes.txt").write_text("mine")

        self.favorite(v, on=False)

        self.assertEqual([p.name for p in self.folder("group d").iterdir()], ["notes.txt"])

    def test_a_video_that_is_not_in_a_handle_folder_or_is_gone_gets_no_link(self):
        loose = self.video("group d/loose.mp4")
        gone = self.video("group d/alice/gone.mp4")
        self.favorite(loose)
        self.favorite(gone)
        os.remove(gone)

        vtag.publish(self.db)

        self.assertFalse(self.folder("group d").exists())

    def outside(self, relative, data=b"z" * 1000):
        """A video in a site folder next to the library (<site>/<handle>/...)."""
        p = self.root.parent / relative
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return str(p)

    def test_a_favorite_next_to_the_library_gets_a_link_in_its_own_site_folder(self):
        v = self.outside("othersite/carol/a.ts")

        self.favorite(v)

        link = self.root.parent / "othersite" / vtag.FAVORITES_DIR / "a.ts"
        self.assertEqual(os.readlink(link), "../carol/a.ts")
        self.favorite(v, on=False)
        self.assertFalse(link.parent.exists())

    def test_a_loose_video_next_to_the_library_gets_no_link(self):
        # Directly in a site folder, or directly beside the library: there is no
        # handle folder, so no folder above it to show it in.
        self.favorite(self.outside("othersite/loose.ts"))
        self.favorite(self.outside("loose.ts", b"w" * 1000))

        self.assertEqual(list(self.root.parent.rglob(vtag.FAVORITES_DIR)), [])

    def test_favoriting_through_a_link_favorites_the_video_itself(self):
        v = self.video("group d/alice/a.mp4")
        self.favorite(v)
        link = str(self.folder("group d") / "a.mp4")

        # Haruna reports the path it opened, which may be the link.
        self.assertEqual(vtag.tags_of(self.db, link), ["favorite"])

    def test_an_offline_share_does_not_lose_the_favorite(self):
        v = self.video("group d/alice/a.mp4")
        original = vtag.write_favorite_links

        def offline(db, root=None):
            raise OSError("share is offline")

        vtag.write_favorite_links = offline
        try:
            self.favorite(v)
        finally:
            vtag.write_favorite_links = original
        self.assertEqual(vtag.tags_of(self.db, v), ["favorite"])
