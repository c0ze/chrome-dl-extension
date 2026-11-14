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
