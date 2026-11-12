#!/usr/bin/env python3
from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any

import library_check as check

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def make_video(path: Path, source: str = "testsrc", size: str = "320x240", seconds: float = 3, extra: list[str] | None = None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"{source}=size={size}:rate=10",
         "-t", str(seconds), "-pix_fmt", "yuv420p", *(extra or []), str(path)],
        check=True,
    )
    return path


class LibraryCheckCase(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / "library"
        self.state = Path(temp.name) / "state"
        self.root.mkdir()
        self.state.mkdir()

    def scan(self) -> dict[str, Any]:
        return check.scan_library(self.root, self.state)

    def groups(self, report: dict[str, Any]) -> list[tuple[str, list[str]]]:
        return [(group["kind"], [file["path"] for file in group["files"]]) for group in report["groups"]]


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg and ffprobe are not installed")
class BrokenFileTests(LibraryCheckCase):
    def test_a_healthy_video_is_not_reported(self) -> None:
        make_video(self.root / "g/alice/good.mp4")

        report = self.scan()

        self.assertEqual(report["broken"], [])
        self.assertEqual(report["scanned"], 1)

    def test_empty_and_unreadable_files_are_broken(self) -> None:
        (self.root / "g/alice").mkdir(parents=True)
        (self.root / "g/alice/empty.mp4").write_bytes(b"")
        (self.root / "g/alice/garbage.mp4").write_bytes(b"not a video at all" * 100)

        broken = {item["path"]: item["error"] for item in self.scan()["broken"]}

        self.assertEqual(broken["g/alice/empty.mp4"], "empty file")
        self.assertIn("g/alice/garbage.mp4", broken)

    def test_a_download_cut_short_is_broken_even_when_its_header_is_intact(self) -> None:
        # With the index at the front, ffprobe alone reports a cut file as fine.
        whole = make_video(self.root / "g/alice/whole.mp4", seconds=6, extra=["-movflags", "+faststart"])
        cut = self.root / "g/alice/cut.mp4"
        cut.write_bytes(whole.read_bytes()[: whole.stat().st_size // 3])

        broken = [item["path"] for item in self.scan()["broken"]]

        self.assertEqual(broken, ["g/alice/cut.mp4"])

    def test_a_picture_that_stops_while_the_sound_plays_on_says_where(self) -> None:
        # What a download that skipped video segments leaves behind.
        path = self.root / "g/alice/frozen.mp4"
        path.parent.mkdir(parents=True)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-t", "2", "-i", "testsrc=size=320x240:rate=10",
             "-f", "lavfi", "-t", "8", "-i", "sine", "-pix_fmt", "yuv420p", str(path)],
            check=True,
        )

        broken = self.scan()["broken"]

        self.assertEqual([item["error"] for item in broken], ["picture stops at 0:01 of 0:08"])

    def test_a_video_with_only_sound_is_broken(self) -> None:
        path = self.root / "g/alice/sound.mp4"
        path.parent.mkdir(parents=True)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=1", str(path)], check=True
        )

        self.assertEqual(self.scan()["broken"][0]["error"], "no video stream")


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg and ffprobe are not installed")
class DuplicateTests(LibraryCheckCase):
    def test_a_copy_of_a_file_is_identical_wherever_it_sits(self) -> None:
        original = make_video(self.root / "hard j/alice/alice-1.mp4")
        (self.root / "dildo j/alice").mkdir(parents=True)
        shutil.copy(original, self.root / "dildo j/alice/abcdefghijklmnop.mp4")

        report = self.scan()

        self.assertEqual(
            self.groups(report),
            [("identical", ["dildo j/alice/abcdefghijklmnop.mp4", "hard j/alice/alice-1.mp4"])],
        )

    def test_of_two_identical_copies_the_one_named_by_its_id_is_kept(self) -> None:
        # Only that name lets the download archive recognise the video later.
        original = make_video(self.root / "g/alice/alice-1234567890001.mp4")
        shutil.copy(original, self.root / "g/alice/abcdefghijklmnop.mp4")

        report = self.scan()

        self.assertEqual(report["groups"][0]["files"][0]["path"], "g/alice/alice-1234567890001.mp4")

    def test_the_same_video_at_another_quality_is_similar_and_the_better_one_is_kept(self) -> None:
        make_video(self.root / "g/alice/small.mp4", size="160x120")
        make_video(self.root / "g/alice/big.mp4", size="640x480")

        report = self.scan()

        self.assertEqual(self.groups(report), [("similar", ["g/alice/big.mp4", "g/alice/small.mp4"])])

    def test_copies_and_another_quality_of_one_video_are_reported_separately(self) -> None:
        # The copies can be removed without looking; the other quality cannot.
        original = make_video(self.root / "g/alice/big.mp4", size="640x480")
        shutil.copy(original, self.root / "g/alice/big copy.mp4")
        make_video(self.root / "g/alice/small.mp4", size="160x120")

        report = self.scan()

        self.assertEqual(
            sorted(self.groups(report)),
            [
                ("identical", ["g/alice/big copy.mp4", "g/alice/big.mp4"]),
                ("similar", ["g/alice/big copy.mp4", "g/alice/small.mp4"]),
            ],
        )
        self.assertEqual(check.extra_identical_files(self.state), ["g/alice/big.mp4"])

    def test_ffmpeg_decoder_prefixes_are_not_shown_to_the_user(self) -> None:
        noisy = b"[vist#0:0/h264 @ 0x5572] [dec:h264 @ 0x5572] Decoding error: Invalid data\n"
        self.assertEqual(check.last_line(noisy), "Decoding error: Invalid data")

    def test_different_videos_of_the_same_length_are_not_duplicates(self) -> None:
        make_video(self.root / "g/alice/one.mp4", source="testsrc")
        make_video(self.root / "g/alice/two.mp4", source="mandelbrot")

        self.assertEqual(self.scan()["groups"], [])

    def test_the_same_picture_at_a_different_length_is_not_a_duplicate(self) -> None:
        make_video(self.root / "g/alice/short.mp4", seconds=2)
        make_video(self.root / "g/alice/long.mp4", seconds=4)

        self.assertEqual(self.scan()["groups"], [])

    def test_a_broken_file_is_never_offered_as_the_copy_to_keep(self) -> None:
        make_video(self.root / "g/alice/good.mp4")
        (self.root / "g/alice/bad.mp4").write_bytes(b"")

        report = self.scan()

        self.assertEqual(report["groups"], [])
        self.assertEqual(len(report["broken"]), 1)

    def test_a_second_scan_reads_only_what_changed(self) -> None:
        make_video(self.root / "g/alice/one.mp4")
        self.scan()
        make_video(self.root / "g/alice/two.mp4", source="mandelbrot")

        probed: list[str] = []
        original = check.probe_video

        def counting(path: Path) -> dict[str, Any]:
            probed.append(path.name)
            return original(path)

        check.probe_video = counting
        self.addCleanup(setattr, check, "probe_video", original)
        report = self.scan()

        self.assertEqual(probed, ["two.mp4"])
        self.assertEqual(report["scanned"], 2)

    def test_metadata_and_trash_folders_are_not_scanned(self) -> None:
        make_video(self.root / "g/alice/one.mp4")
        for folder in ("@eaDir/g", "_trash/g/alice", "g/alice/@eaDir"):
            (self.root / folder).mkdir(parents=True)
            shutil.copy(self.root / "g/alice/one.mp4", self.root / folder / "one.mp4")

        report = self.scan()

        self.assertEqual(report["scanned"], 1)
        self.assertEqual(report["groups"], [])


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg and ffprobe are not installed")
class TrashTests(LibraryCheckCase):
    def setUp(self) -> None:
        super().setUp()
        original = make_video(self.root / "hard j/alice/alice-1.mp4")
        shutil.copy(original, self.root / "hard j/alice/copy.mp4")
        self.scan()

    def test_a_removed_file_keeps_its_place_below_the_trash_folder(self) -> None:
        response = check.trash_files(self.root, self.state, ["hard j/alice/copy.mp4"])

        self.assertTrue(response["ok"])
        self.assertTrue((self.root / "_trash/hard j/alice/copy.mp4").is_file())
        self.assertFalse((self.root / "hard j/alice/copy.mp4").exists())

    def test_a_removed_file_leaves_the_report_and_ends_its_group(self) -> None:
        check.trash_files(self.root, self.state, ["hard j/alice/copy.mp4"])

        status = check.scan_status(self.state)
        self.assertEqual(status["group_count"], 0)
        self.assertEqual(status["scanned"], 1)

    def test_a_second_file_of_the_same_name_does_not_replace_the_first_in_the_trash(self) -> None:
        check.trash_files(self.root, self.state, ["hard j/alice/copy.mp4"])
        shutil.copy(self.root / "hard j/alice/alice-1.mp4", self.root / "hard j/alice/copy.mp4")

        check.trash_files(self.root, self.state, ["hard j/alice/copy.mp4"])

        self.assertTrue((self.root / "_trash/hard j/alice/copy.mp4").is_file())
        self.assertTrue((self.root / "_trash/hard j/alice/copy.1.mp4").is_file())

    def test_only_library_videos_can_be_removed(self) -> None:
        outside = self.root.parent / "outside.mp4"
        outside.write_bytes(b"x")
        (self.root / "notes.txt").write_text("keep")

        for path in ("../outside.mp4", str(outside), "notes.txt", "_trash/x.mp4", "@eaDir/x.mp4", ""):
            response = check.trash_files(self.root, self.state, [path])
            self.assertFalse(response["ok"], path)

        self.assertTrue(outside.exists())
        self.assertTrue((self.root / "notes.txt").exists())

    def test_removing_every_extra_identical_copy_keeps_one_of_each(self) -> None:
        extras = check.extra_identical_files(self.state)

        self.assertEqual(len(extras), 1)
        check.trash_files(self.root, self.state, extras)
        remaining = sorted(path.name for path in (self.root / "hard j/alice").iterdir())
        self.assertEqual(len(remaining), 1)

    def test_nothing_is_removed_while_a_scan_is_running(self) -> None:
        import fcntl

        with open(check.lock_path(self.state), "a", encoding="utf-8") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            response = check.trash_files(self.root, self.state, ["hard j/alice/copy.mp4"])

        self.assertFalse(response["ok"])
        self.assertTrue((self.root / "hard j/alice/copy.mp4").exists())


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg and ffprobe are not installed")
class ScanProcessTests(LibraryCheckCase):
    def test_the_scan_process_reports_done_and_leaves_a_report(self) -> None:
        make_video(self.root / "g/alice/one.mp4")

        self.assertEqual(check.run_scan_process(self.root, self.state), 0)

        status = check.scan_status(self.state)
        self.assertEqual(status["state"], "done")
        self.assertEqual(status["scanned"], 1)

    def test_a_scan_that_died_is_not_shown_as_running_forever(self) -> None:
        check.write_json(check.status_path(self.state), {"state": "running", "done": 3, "total": 9})

        self.assertEqual(check.scan_status(self.state)["state"], "failed")

    def test_a_missing_library_is_reported_before_anything_starts(self) -> None:
        response = check.start_scan(self.root / "gone", self.state)

        self.assertFalse(response["ok"])
        self.assertTrue(response["missing_dir"])

    def test_the_report_is_served_in_pages(self) -> None:
        for name in ("a", "b", "c"):
            (self.root / "g").mkdir(exist_ok=True)
            (self.root / f"g/{name}.mp4").write_bytes(b"")
        self.scan()

        page = check.report_page(self.state, "broken", 1, 1)

        self.assertEqual(page["total"], 3)
        self.assertEqual([item["path"] for item in page["items"]], ["g/b.mp4"])


class FingerprintTests(unittest.TestCase):
    def test_a_few_changed_bits_still_match_and_many_do_not(self) -> None:
        self.assertTrue(check.fingerprints_match([0b1111, 0], [0b1100, 0]))
        self.assertFalse(check.fingerprints_match([0xFFFF, 0], [0, 0]))
        # Both frames must agree: one shared black frame proves nothing.
        self.assertFalse(check.fingerprints_match([0, 0], [0, 0xFFFF]))


if __name__ == "__main__":
    unittest.main()
