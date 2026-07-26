"""Unit tests for the yt-dlp native messaging host."""
from __future__ import annotations

import unittest
import unittest.mock
from typing import Any

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
                result = host.safe_path_part(value)
                self.assertTrue(result)
                self.assertNotIn("/", result)
                self.assertNotIn("\\", result)
                self.assertNotEqual(result, "..")
                self.assertNotEqual(result, ".")
                self.assertFalse(result.startswith("."))


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
        for segment in host.FACEBOOK_RESERVED_SEGMENTS:
            with self.subTest(segment=segment):
                self.assertIsNone(
                    host.batch_target_for_url(f"https://www.facebook.com/{segment}/reels")
                )

    def test_single_reel_is_not_a_batch(self) -> None:
        self.assertIsNone(host.batch_target_for_url("https://www.facebook.com/reel/123"))


class FacebookPeopleUrlBatchMatchingTests(unittest.TestCase):
    """The third profile URL shape: /people/<name-segment>/<digits>?sk=reels_tab."""

    PEOPLE_URL = (
        "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/61590939736806/?sk=reels_tab"
    )

    def test_matches_people_url_keyed_on_numeric_id(self) -> None:
        target = host.batch_target_for_url(self.PEOPLE_URL)
        self.assertEqual(target, {"provider": "facebook", "key": "61590939736806"})

    def test_same_profile_via_profile_php_and_people_url_produces_same_key(self) -> None:
        via_profile_php = host.batch_target_for_url(
            "https://www.facebook.com/profile.php?id=61590939736806&sk=reels_tab"
        )
        via_people = host.batch_target_for_url(self.PEOPLE_URL)
        self.assertEqual(via_profile_php, via_people)
        self.assertEqual(via_people["key"], "61590939736806")

    def test_rejects_people_url_without_reels_tab(self) -> None:
        self.assertIsNone(
            host.batch_target_for_url(
                "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/61590939736806/"
            )
        )

    def test_two_segment_people_reels_still_does_not_match(self) -> None:
        """The reserved-segment rule for /people/reels must stay intact."""
        self.assertIsNone(host.batch_target_for_url("https://www.facebook.com/people/reels"))

    def test_rejects_non_numeric_third_segment(self) -> None:
        self.assertIsNone(
            host.batch_target_for_url(
                "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/not-a-number/?sk=reels_tab"
            )
        )

    def test_people_still_in_reserved_segments(self) -> None:
        """people must stay reserved so the two-segment vanity form /people/reels
        cannot match — this rule is orthogonal to (and must survive alongside)
        the new three-segment form."""
        self.assertIn("people", host.FACEBOOK_RESERVED_SEGMENTS)


class FacebookPeopleUrlNameTests(unittest.TestCase):
    def test_decodes_percent_encoded_cjk_name(self) -> None:
        self.assertEqual(
            host.facebook_people_url_name(
                "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/61590939736806/?sk=reels_tab"
            ),
            "小妮",
        )

    def test_decoded_name_survives_safe_path_part_intact(self) -> None:
        name = host.facebook_people_url_name(
            "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/61590939736806/?sk=reels_tab"
        )
        self.assertEqual(host.safe_path_part(name), "小妮")

    def test_returns_none_for_non_people_urls(self) -> None:
        self.assertIsNone(
            host.facebook_people_url_name("https://www.facebook.com/somepage/reels")
        )
        self.assertIsNone(
            host.facebook_people_url_name(
                "https://www.facebook.com/profile.php?id=123&sk=reels_tab"
            )
        )

    def test_malformed_percent_encoding_falls_back_rather_than_raising(self) -> None:
        # "%E5%B0" alone is a truncated/invalid UTF-8 sequence.
        malformed_url = "https://www.facebook.com/people/%E5%B0/61590939736806/?sk=reels_tab"
        try:
            result = host.facebook_people_url_name(malformed_url)
        except Exception as error:  # noqa: BLE001
            self.fail(f"facebook_people_url_name raised instead of falling back: {error}")
        self.assertIsNone(result)


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


class ProfileItemValidationTests(unittest.TestCase):
    def test_facebook_batch_accepts_only_reel_urls(self) -> None:
        target = {"provider": "facebook", "key": "61590939736806"}
        self.assertTrue(host.valid_batch_item("https://www.facebook.com/reel/123", target))
        self.assertFalse(
            host.valid_batch_item("https://www.facebook.com/somepage/posts/9", target)
        )
        self.assertFalse(host.valid_batch_item("https://x.com/alice/status/1", target))

    def test_twitter_batch_still_enforces_ownership(self) -> None:
        target = {"provider": "twitter", "key": "alice"}
        self.assertTrue(host.valid_batch_item("https://x.com/alice/status/1", target))
        self.assertFalse(host.valid_batch_item("https://x.com/bob/status/1", target))


class StartProfileDownloadJobsProfileNameTests(unittest.TestCase):
    def setUp(self) -> None:
        self._config_patch = unittest.mock.patch.object(
            host, "load_config", return_value=dict(host.DEFAULT_CONFIG)
        )
        self._config_patch.start()
        self.addCleanup(self._config_patch.stop)

        self._mutate_patch = unittest.mock.patch.object(host, "mutate_jobs")
        mock_mutate_jobs = self._mutate_patch.start()
        self.addCleanup(self._mutate_patch.stop)

        def fake_mutate(mutator):
            state: dict[str, Any] = {"jobs": []}
            return mutator(state)

        mock_mutate_jobs.side_effect = fake_mutate

        self._launch_patch = unittest.mock.patch.object(
            host, "launch_next_queued_job", return_value={"started": True}
        )
        self._launch_patch.start()
        self.addCleanup(self._launch_patch.stop)

        self._mkdir_patch = unittest.mock.patch.object(host.Path, "mkdir")
        self._mkdir_patch.start()
        self.addCleanup(self._mkdir_patch.stop)

    def test_facebook_folder_uses_scraped_profile_name_when_present(self) -> None:
        result = host.start_profile_download_jobs(
            "https://www.facebook.com/somepage/reels",
            "extension",
            None,
            ["https://www.facebook.com/reel/123"],
            False,
            "My Cool Page",
        )
        self.assertTrue(result["ok"])
        self.assertTrue(result["download_dir"].endswith("My Cool Page"))
        self.assertEqual(result["username"], "somepage")

    def test_facebook_folder_falls_back_to_key_without_profile_name(self) -> None:
        result = host.start_profile_download_jobs(
            "https://www.facebook.com/somepage/reels",
            "extension",
            None,
            ["https://www.facebook.com/reel/123"],
            False,
            None,
        )
        self.assertTrue(result["ok"])
        self.assertTrue(result["download_dir"].endswith("somepage"))

    def test_people_url_folder_falls_back_to_url_decoded_name_without_scraped_name(self) -> None:
        """Preference order: scraped name > URL-decoded /people/ segment > numeric id.

        With no scraped profile_name, the URL's own percent-encoded name
        segment (小妮) must be used instead of falling straight to the numeric id.
        """
        result = host.start_profile_download_jobs(
            "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/61590939736806/?sk=reels_tab",
            "extension",
            None,
            ["https://www.facebook.com/reel/123"],
            False,
            None,
        )
        self.assertTrue(result["ok"])
        self.assertTrue(result["download_dir"].endswith("小妮"))
        self.assertEqual(result["username"], "61590939736806")

    def test_people_url_scraped_name_still_wins_over_url_decoded_name(self) -> None:
        result = host.start_profile_download_jobs(
            "https://www.facebook.com/people/%E5%B0%8F%E5%A6%AE/61590939736806/?sk=reels_tab",
            "extension",
            None,
            ["https://www.facebook.com/reel/123"],
            False,
            "Scraped Display Name",
        )
        self.assertTrue(result["ok"])
        self.assertTrue(result["download_dir"].endswith("Scraped Display Name"))

    def test_hostile_profile_name_cannot_escape_the_base_download_directory(self) -> None:
        """End-to-end trust-boundary test: a scraped profile name is untrusted

        input and must never let the resulting download directory land outside
        the configured base download directory, however path-traversal-shaped
        it is.
        """
        base_download_dir = "/tmp/base-download-dir"
        result = host.start_profile_download_jobs(
            "https://www.facebook.com/somepage/reels",
            "extension",
            base_download_dir,
            ["https://www.facebook.com/reel/123"],
            False,
            "../../../../etc",
        )
        self.assertTrue(result["ok"])
        download_dir = host.Path(result["download_dir"])
        self.assertEqual(download_dir.parent, host.Path(base_download_dir))

    def test_twitter_profile_download_still_works_without_profile_name(self) -> None:
        result = host.start_profile_download_jobs(
            "https://x.com/alice/media",
            "extension",
            None,
            ["https://x.com/alice/status/1", "https://x.com/bob/status/2"],
            False,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["username"], "alice")
        self.assertEqual(result["rejected_count"], 1)
        self.assertTrue(result["download_dir"].endswith("alice"))

    def test_non_batch_url_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, r"Profile downloads require.*X/Twitter.*Facebook"):
            host.start_profile_download_jobs(
                "https://example.com/somepage",
                "extension",
                None,
                [],
                False,
            )

    def test_facebook_rejection_message_no_at_sign(self) -> None:
        """Verify Facebook rejection message uses 'reels from this profile', not '@profile_id'."""
        with self.assertRaises(ValueError) as cm:
            host.start_profile_download_jobs(
                "https://www.facebook.com/61590939736806/reels",
                "extension",
                None,
                ["https://www.facebook.com/invalid/link"],  # Will be rejected
                False,
            )
        error_message = str(cm.exception)
        self.assertNotIn("@", error_message)
        self.assertIn("reels from this profile", error_message)


class HandleMessageProfileNameTests(unittest.TestCase):
    def test_rejects_non_string_profile_name(self) -> None:
        with self.assertRaises(ValueError):
            host.handle_message(
                {
                    "type": "download",
                    "url": "https://www.facebook.com/somepage/reels",
                    "profile_urls": ["https://www.facebook.com/reel/123"],
                    "profile_name": 12345,
                }
            )

    def test_forwards_profile_name_to_facebook_batch(self) -> None:
        captured: dict[str, Any] = {}

        def fake_start_profile_download_jobs(
            raw_url, source, download_dir_override, profile_video_urls,
            allow_duplicate=False, profile_name=None,
        ):
            captured["profile_name"] = profile_name
            captured["raw_url"] = raw_url
            return {"ok": True}

        with unittest.mock.patch.object(
            host,
            "start_profile_download_jobs",
            side_effect=fake_start_profile_download_jobs,
        ):
            result = host.handle_message(
                {
                    "type": "download",
                    "url": "https://www.facebook.com/somepage/reels",
                    "profile_urls": ["https://www.facebook.com/reel/123"],
                    "profile_name": "My Cool Page",
                }
            )

        self.assertTrue(result["ok"])
        self.assertEqual(captured["profile_name"], "My Cool Page")

    def test_absent_profile_name_forwards_none(self) -> None:
        captured: dict[str, Any] = {}

        def fake_start_profile_download_jobs(
            raw_url, source, download_dir_override, profile_video_urls,
            allow_duplicate=False, profile_name=None,
        ):
            captured["profile_name"] = profile_name
            return {"ok": True}

        with unittest.mock.patch.object(
            host,
            "start_profile_download_jobs",
            side_effect=fake_start_profile_download_jobs,
        ):
            host.handle_message(
                {
                    "type": "download",
                    "url": "https://x.com/alice/media",
                    "profile_urls": ["https://x.com/alice/status/1"],
                }
            )

        self.assertIsNone(captured["profile_name"])


if __name__ == "__main__":
    unittest.main()
