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


if __name__ == "__main__":
    unittest.main()
