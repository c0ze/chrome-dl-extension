"""Unit tests for the yt-dlp native messaging host."""
from __future__ import annotations

import unittest

import yt_dlp_host as host


class NormalizeUrlTwitterTests(unittest.TestCase):
    def test_canonicalises_status_variants_to_one_key(self) -> None:
        variants = [
            "https://x.com/foo/status/123",
            "https://x.com/foo/status/123/",
            "https://twitter.com/foo/status/123",
            "https://mobile.twitter.com/foo/status/123",
            "https://x.com/foo/status/123/photo/1",
            "https://x.com/foo/status/123?s=20",
        ]
        results = {host.normalize_url(url) for url in variants}
        self.assertEqual(results, {"https://x.com/foo/status/123"})

    def test_rejects_non_http_schemes(self) -> None:
        for url in ["ftp://x.com/a", "file:///etc/passwd", "javascript:alert(1)"]:
            with self.assertRaises(ValueError):
                host.normalize_url(url)

    def test_preserves_query_for_non_twitter_hosts(self) -> None:
        self.assertEqual(
            host.normalize_url("https://example.com/watch?v=abc"),
            "https://example.com/watch?v=abc",
        )


class TwitterBatchMatchingTests(unittest.TestCase):
    def test_matches_profile_media_url(self) -> None:
        self.assertEqual(
            host.twitter_profile_media_username("https://x.com/alice/media"),
            "alice",
        )

    def test_rejects_reserved_usernames(self) -> None:
        for name in ["home", "explore", "notifications", "messages", "i", "settings"]:
            with self.subTest(name=name):
                self.assertIsNone(
                    host.twitter_profile_media_username(f"https://x.com/{name}/media")
                )

    def test_rejects_non_media_paths(self) -> None:
        self.assertIsNone(host.twitter_profile_media_username("https://x.com/alice"))
        self.assertIsNone(
            host.twitter_profile_media_username("https://x.com/alice/status/1")
        )

    def test_status_username_extracts_owner(self) -> None:
        self.assertEqual(
            host.twitter_status_username("https://x.com/alice/status/123"),
            "alice",
        )


class SafePathPartTraversalTests(unittest.TestCase):
    """Traversal safety must never regress, whatever else changes."""

    def test_never_escapes_the_base_directory(self) -> None:
        for hostile in [
            "../../etc/passwd",
            "..",
            "../",
            "/etc/passwd",
            "a/b/c",
            "a\\b",
            "....//" ,
            "..././..",
            "....///...." ,
            "..%2F..%2Fetc",
        ]:
            with self.subTest(hostile=hostile):
                result = host.safe_path_part(hostile)
                self.assertNotIn("/", result)
                self.assertNotIn("\\", result)
                self.assertNotEqual(result, "..")
                self.assertNotEqual(result, ".")
                self.assertFalse(result.startswith("."))

    def test_never_returns_empty(self) -> None:
        for value in ["", "...", "___", "///"]:
            with self.subTest(value=value):
                self.assertTrue(host.safe_path_part(value))


class SafePathPartUnicodeTests(unittest.TestCase):
    def test_preserves_japanese(self) -> None:
        self.assertEqual(host.safe_path_part("ネコ動画"), "ネコ動画")

    def test_preserves_mixed_scripts(self) -> None:
        self.assertEqual(host.safe_path_part("Neko 動画"), "Neko 動画")

    def test_strips_filesystem_hostile_characters(self) -> None:
        result = host.safe_path_part('a/b\\c:d*e?f"g<h>i|j')
        for bad in '/\\:*?"<>|':
            self.assertNotIn(bad, result)

    def test_caps_at_255_utf8_bytes_on_a_character_boundary(self) -> None:
        result = host.safe_path_part("動" * 200)
        self.assertLessEqual(len(result.encode("utf-8")), 255)
        # Must not have split a multi-byte sequence and land on a boundary.
        # "動" is 3 bytes in UTF-8, so 255 // 3 == 85 characters.
        self.assertEqual(len(result), 85)
        self.assertEqual(len(result.encode("utf-8")), 255)

    def test_uses_supplied_fallback_when_empty(self) -> None:
        self.assertEqual(host.safe_path_part("///", fallback="61590939736806"), "61590939736806")

    def test_strips_control_characters(self) -> None:
        self.assertNotIn("\x00", host.safe_path_part("a\x00b"))
        self.assertNotIn("\n", host.safe_path_part("a\nb"))


class FacebookBatchMatchingTests(unittest.TestCase):
    def test_matches_profile_php_reels_tab(self) -> None:
        target = host.batch_target_for_url(
            "https://www.facebook.com/profile.php?id=61590939736806&sk=reels_tab"
        )
        self.assertEqual(target, {"provider": "facebook", "key": "61590939736806"})

    def test_matches_vanity_reels_path(self) -> None:
        target = host.batch_target_for_url("https://www.facebook.com/somepage/reels")
        self.assertEqual(target, {"provider": "facebook", "key": "somepage"})

    def test_matches_mobile_subdomain(self) -> None:
        self.assertEqual(
            host.batch_target_for_url("https://m.facebook.com/somepage/reels")["key"],
            "somepage",
        )

    def test_rejects_profile_php_without_reels_tab(self) -> None:
        self.assertIsNone(
            host.batch_target_for_url("https://www.facebook.com/profile.php?id=123")
        )

    def test_rejects_videos_tab(self) -> None:
        self.assertIsNone(host.batch_target_for_url("https://www.facebook.com/somepage/videos"))

    def test_rejects_reserved_segments(self) -> None:
        for segment in ["reel", "watch", "groups", "marketplace", "profile.php", "login"]:
            with self.subTest(segment=segment):
                self.assertIsNone(
                    host.batch_target_for_url(f"https://www.facebook.com/{segment}/reels")
                )

    def test_single_reel_is_not_a_batch(self) -> None:
        self.assertIsNone(host.batch_target_for_url("https://www.facebook.com/reel/123"))


class FacebookUrlCanonicalisationTests(unittest.TestCase):
    def test_strips_tracking_parameters_so_duplicates_collapse(self) -> None:
        variants = [
            "https://www.facebook.com/reel/1234567890",
            "https://www.facebook.com/reel/1234567890/",
            "https://m.facebook.com/reel/1234567890?fs=e&s=TIeo",
            "https://web.facebook.com/reel/1234567890?mibextid=abc",
        ]
        results = {host.normalize_url(url) for url in variants}
        self.assertEqual(results, {"https://www.facebook.com/reel/1234567890"})

    def test_reel_id_extraction(self) -> None:
        self.assertEqual(
            host.facebook_reel_id("https://www.facebook.com/reel/1234567890"), "1234567890"
        )
        self.assertIsNone(host.facebook_reel_id("https://www.facebook.com/somepage/reels"))


class FacebookNonReelQueryPreservationTests(unittest.TestCase):
    """strip_query is path-aware: only recognised reel paths lose their query.

    facebook.com/watch/?v=<id> is a URL yt-dlp's facebook extractor resolves;
    facebook.com/watch (no query) is not. Stripping the query on this path
    silently breaks the download, so these must never regress.
    """

    def test_watch_url_keeps_its_video_id(self) -> None:
        self.assertEqual(
            host.normalize_url("https://facebook.com/watch/?v=1234567890123456"),
            "https://www.facebook.com/watch?v=1234567890123456",
        )

    def test_watch_live_url_keeps_its_full_query(self) -> None:
        self.assertEqual(
            host.normalize_url(
                "https://facebook.com/watch/live/?ref=watch_permalink&v=999"
            ),
            "https://www.facebook.com/watch/live?ref=watch_permalink&v=999",
        )

    def test_video_permalink_still_normalises_correctly(self) -> None:
        self.assertEqual(
            host.normalize_url("https://facebook.com/somepage/videos/123456/"),
            "https://www.facebook.com/somepage/videos/123456",
        )

    def test_reel_urls_still_drop_tracking_params(self) -> None:
        variants = [
            "https://www.facebook.com/reel/1234567890",
            "https://www.facebook.com/reel/1234567890/",
            "https://m.facebook.com/reel/1234567890?fs=e&s=TIeo",
            "https://web.facebook.com/reel/1234567890?mibextid=abc",
        ]
        results = {host.normalize_url(url) for url in variants}
        self.assertEqual(results, {"https://www.facebook.com/reel/1234567890"})

    def test_twitter_still_strips_its_query(self) -> None:
        self.assertEqual(
            host.normalize_url("https://x.com/foo/status/123?s=20"),
            "https://x.com/foo/status/123",
        )


class FacebookVanityRegexTraversalTests(unittest.TestCase):
    def test_rejects_dotdot_as_a_batch_target(self) -> None:
        self.assertIsNone(host.batch_target_for_url("https://www.facebook.com/../reels"))

    def test_rejects_dot_as_a_batch_target(self) -> None:
        self.assertIsNone(host.batch_target_for_url("https://www.facebook.com/./reels"))


if __name__ == "__main__":
    unittest.main()
