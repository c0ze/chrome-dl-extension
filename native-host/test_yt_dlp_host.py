"""Unit tests for the yt-dlp native messaging host."""
from __future__ import annotations

import json
import os
import tempfile
import unittest
import unittest.mock
import io
from pathlib import Path
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


class CookieKeyringTests(unittest.TestCase):
    def test_legacy_config_keeps_automatic_keyring(self) -> None:
        config = host.normalize_config({"browser": "chrome", "profile": "Default"})
        self.assertEqual(config["keyring"], "")
        self.assertEqual(host.browser_spec(config), "chrome:Default")

    def test_keyring_survives_settings_round_trip_and_command_building(self) -> None:
        config = host.normalize_config({"keyring": " GNOMEKEYRING ", "profile": "Profile 1"})
        config = host.normalize_config(host.config_for_response(config))
        command = host.build_command("https://example.invalid/", config)
        self.assertEqual(command[command.index("--cookies-from-browser") + 1],
                         "chrome+gnomekeyring:Profile 1")

    def test_keyring_without_profile(self) -> None:
        config = host.normalize_config({"keyring": "kwallet6"})
        self.assertEqual(host.browser_spec(config), "chrome+kwallet6")

    def test_firefox_ignores_chromium_keyring_setting(self) -> None:
        config = host.normalize_config({"browser": "firefox", "keyring": "gnomekeyring"})
        self.assertEqual(host.browser_spec(config), "firefox")

    def test_invalid_keyring_rejected(self) -> None:
        with self.assertRaises(ValueError):
            host.normalize_config({"keyring": "gnomekeyring:OtherProfile"})


EXTENSION_ID = "a" * 32


class CookieProfileDetectionTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.config_home = Path(temp.name)
        env = unittest.mock.patch.dict(
            os.environ,
            {"XDG_CONFIG_HOME": str(self.config_home), host.EXTENSION_ID_ENV: EXTENSION_ID},
        )
        env.start()
        self.addCleanup(env.stop)

    def add_profile(self, name: str, extension_ids: list[str], root: str = "google-chrome") -> None:
        profile_dir = self.config_home / root / name
        profile_dir.mkdir(parents=True)
        settings = {extension_id: {} for extension_id in extension_ids}
        (profile_dir / "Preferences").write_text(json.dumps({"extensions": {"settings": settings}}))

    def test_empty_profile_uses_the_only_profile_with_the_extension(self) -> None:
        # Without a profile, yt-dlp reads whichever profile wrote cookies last,
        # which may not be signed in to the site being downloaded.
        self.add_profile("Default", ["b" * 32])
        self.add_profile("Profile 5", [EXTENSION_ID])
        self.add_profile("Profile 9", [])
        config = host.normalize_config({"keyring": "gnomekeyring"})
        self.assertEqual(host.browser_spec(config), "chrome+gnomekeyring:Profile 5")

    def test_explicit_profile_wins(self) -> None:
        self.add_profile("Profile 5", [EXTENSION_ID])
        config = host.normalize_config({"profile": "Default"})
        self.assertEqual(host.browser_spec(config), "chrome:Default")

    def test_ambiguous_install_keeps_yt_dlp_default(self) -> None:
        self.add_profile("Default", [EXTENSION_ID])
        self.add_profile("Profile 5", [EXTENSION_ID])
        self.assertEqual(host.browser_spec(host.normalize_config({})), "chrome")

    def test_unknown_extension_id_keeps_yt_dlp_default(self) -> None:
        self.add_profile("Profile 5", [EXTENSION_ID])
        with unittest.mock.patch.dict(os.environ):
            del os.environ[host.EXTENSION_ID_ENV]
            self.assertEqual(host.browser_spec(host.normalize_config({})), "chrome")

    def test_unreadable_preferences_are_skipped(self) -> None:
        broken = self.config_home / "google-chrome" / "Default"
        broken.mkdir(parents=True)
        (broken / "Preferences").write_text("{not json")
        self.add_profile("Profile 5", [EXTENSION_ID])
        self.assertEqual(host.browser_spec(host.normalize_config({})), "chrome:Profile 5")

    def test_uses_the_configured_browser_data_dir(self) -> None:
        self.add_profile("Default", [EXTENSION_ID])
        self.add_profile("Profile 2", [EXTENSION_ID], root="BraveSoftware/Brave-Browser")
        config = host.normalize_config({"browser": "brave"})
        self.assertEqual(host.browser_spec(config), "brave:Profile 2")

    def test_firefox_is_not_probed(self) -> None:
        self.add_profile("Default", [EXTENSION_ID])
        self.assertEqual(host.browser_spec(host.normalize_config({"browser": "firefox"})), "firefox")

    def test_remember_extension_origin_reads_chrome_caller_argument(self) -> None:
        with unittest.mock.patch.dict(os.environ):
            del os.environ[host.EXTENSION_ID_ENV]
            host.remember_extension_origin(["host.py", f"chrome-extension://{'c' * 32}/"])
            self.assertEqual(os.environ[host.EXTENSION_ID_ENV], "c" * 32)

    def test_remember_extension_origin_ignores_other_arguments(self) -> None:
        host.remember_extension_origin(["host.py", "--parent-window=0", "chrome-extension://bad/"])
        self.assertEqual(os.environ[host.EXTENSION_ID_ENV], EXTENSION_ID)


class DownloadDirValidationTests(unittest.TestCase):
    def test_accepts_absolute_and_home_relative_paths(self) -> None:
        self.assertEqual(host.resolve_download_dir("/srv/videos"), "/srv/videos")
        self.assertEqual(host.resolve_download_dir(" ~/Downloads "), os.path.expanduser("~/Downloads"))

    def test_rejects_paths_that_would_land_in_the_host_directory(self) -> None:
        # A relative path resolves against the worker's working directory, so
        # smb://host/share used to create ./smb:/host/share inside the app dir.
        for value in ["smb://nas.local/home/videos", "Videos", "./x", "file:///tmp/x", ""]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                host.resolve_download_dir(value)

    def test_config_rejects_relative_download_dir(self) -> None:
        with self.assertRaises(ValueError):
            host.normalize_config({"download_dir": "smb://nas.local/share"})

    def test_single_download_rejects_relative_download_dir(self) -> None:
        with unittest.mock.patch.object(host, "mutate_jobs") as mutate_jobs, self.assertRaises(ValueError):
            host.start_download_job("https://x.com/a/status/1", "toolbar", "smb://nas.local/share")
        mutate_jobs.assert_not_called()

    def test_profile_download_rejects_relative_download_dir(self) -> None:
        with unittest.mock.patch.object(host, "mutate_jobs") as mutate_jobs, self.assertRaises(ValueError):
            host.start_profile_download_jobs(
                "https://x.com/a/media", "toolbar", "smb://nas.local/share", ["https://x.com/a/status/1"]
            )
        mutate_jobs.assert_not_called()


class VisibleJobsTests(unittest.TestCase):
    def test_running_job_leads_a_short_queue(self) -> None:
        # Jobs are stored newest first, so the running (oldest) job would
        # otherwise fall below the dashboard's short list.
        jobs = [{"id": str(i), "status": "queued"} for i in range(9)]
        jobs.append({"id": "run", "status": "running"})
        self.assertEqual(host.visible_jobs(jobs)[0]["id"], "run")
        self.assertEqual(len(host.visible_jobs(jobs)), 10)


class WorkerFailureBackoffTests(unittest.TestCase):
    def run_worker(self, run_yt_dlp: Any) -> tuple[unittest.mock.MagicMock, unittest.mock.MagicMock, unittest.mock.MagicMock]:
        payload = host.encode_worker_payload({"id": "job", "url": "https://x.com/a/status/1"})
        with (
            unittest.mock.patch.object(host, "load_config", return_value=dict(host.DEFAULT_CONFIG)),
            unittest.mock.patch.object(host, "run_yt_dlp", side_effect=run_yt_dlp),
            unittest.mock.patch.object(host, "update_job"),
            unittest.mock.patch.object(host, "notify"),
            unittest.mock.patch.object(host, "log_line"),
            unittest.mock.patch.object(host, "start_job_heartbeat", return_value=unittest.mock.MagicMock()),
            unittest.mock.patch.object(host, "launch_next_queued_job") as launch_next,
            unittest.mock.patch.object(host, "record_launch_failure") as record_failure,
            unittest.mock.patch.object(host, "clear_launch_failures") as clear_failures,
        ):
            host.run_download_worker(payload)
        return launch_next, record_failure, clear_failures

    def test_missing_yt_dlp_backs_off_instead_of_failing_the_whole_queue(self) -> None:
        launch_next, record_failure, clear_failures = self.run_worker(FileNotFoundError("yt-dlp"))
        launch_next.assert_not_called()
        record_failure.assert_called_once()
        clear_failures.assert_not_called()

    def test_unexpected_worker_error_backs_off(self) -> None:
        launch_next, record_failure, _ = self.run_worker(RuntimeError("boom"))
        launch_next.assert_not_called()
        record_failure.assert_called_once()

    def test_worker_cancelled_before_it_started_does_not_run_yt_dlp(self) -> None:
        payload = host.encode_worker_payload({"id": "job", "url": "https://x.com/a/status/1"})
        with (
            unittest.mock.patch.object(host, "load_config", return_value=dict(host.DEFAULT_CONFIG)),
            unittest.mock.patch.object(host, "update_job", return_value=False),
            unittest.mock.patch.object(host, "notify"),
            unittest.mock.patch.object(host, "log_line"),
            unittest.mock.patch.object(host, "run_yt_dlp") as run_yt_dlp,
            unittest.mock.patch.object(host, "launch_next_queued_job") as launch_next,
        ):
            self.assertEqual(host.run_download_worker(payload), 0)
        run_yt_dlp.assert_not_called()
        launch_next.assert_not_called()

    def test_update_job_reports_cancelled_jobs(self) -> None:
        state = {"jobs": [{"id": "a", "status": "cancelled"}, {"id": "b", "status": "running"}]}
        with unittest.mock.patch.object(host, "mutate_jobs", side_effect=lambda mutator: mutator(state)):
            self.assertFalse(host.update_job("a", {"status": "running"}))
            self.assertFalse(host.update_job("missing", {"status": "running"}))
            self.assertTrue(host.update_job("b", {"progress": 5}))
        self.assertEqual(state["jobs"][0]["status"], "cancelled")

    def test_a_failed_download_still_moves_on(self) -> None:
        launch_next, record_failure, clear_failures = self.run_worker(lambda *_: 1)
        launch_next.assert_called_once()
        record_failure.assert_not_called()
        clear_failures.assert_called_once()


class RedactCommandTests(unittest.TestCase):
    def test_redacts_every_form_yt_dlp_accepts(self) -> None:
        command = [
            "yt-dlp", "--add-headers", "Authorization: Bearer XYZ", "--add-header", "Cookie: c=1",
            "-psecret", "--passw", "pw2", "-2", "123456", "--password=pw3", "-uuser", "--twofactor=7",
        ]
        redacted = host.redact_command(command)
        for secret in ["XYZ", "c=1", "secret", "pw2", "123456", "pw3", "user", "=7"]:
            self.assertNotIn(secret, redacted)

    def test_keeps_ordinary_arguments(self) -> None:
        command = ["yt-dlp", "--newline", "--cookies-from-browser", "chrome", "-P", "/srv/v", "-o", "%(id)s"]
        self.assertEqual(host.redact_command(command), " ".join(command))


class SaveConfigTests(unittest.TestCase):
    def test_save_replaces_config_without_leaving_temp_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            config_path = Path(temp) / "config.json"
            config_path.write_text("{}")
            with (
                unittest.mock.patch.object(host, "CONFIG_PATH", config_path),
                unittest.mock.patch.object(host, "ensure_state"),
            ):
                host.save_config({"download_dir": "/srv/videos"})
            self.assertEqual(json.loads(config_path.read_text())["download_dir"], "/srv/videos")
            self.assertEqual(os.stat(config_path).st_mode & 0o777, 0o600)
            self.assertEqual(sorted(p.name for p in Path(temp).iterdir()), ["config.json"])


class DownloadDiagnosticsTests(unittest.TestCase):
    def run_output(self, output: str, returncode: int, log_available: bool = True):
        process = unittest.mock.MagicMock()
        process.stdout = io.StringIO(output)
        process.pid = 12345
        process.wait.return_value = returncode
        job = {}
        log = io.StringIO() if log_available else None
        with (
            unittest.mock.patch.object(host, "open_log_stream", return_value=log),
            unittest.mock.patch.object(host, "write_log_stream", side_effect=lambda handle, text: handle),
            unittest.mock.patch.object(host.subprocess, "Popen", return_value=process),
            unittest.mock.patch.object(host, "update_job", side_effect=lambda _, updates: job.update(updates)),
        ):
            code = host.run_yt_dlp(["yt-dlp", "https://example.invalid/"], "test-job")
        self.assertEqual(code, returncode)
        return job

    def test_decryption_warning_explains_misleading_no_video_error(self) -> None:
        job = self.run_output(
            "WARNING: cannot decrypt v11 cookies: no key found\n"
            "ERROR: [twitter] 123: No video could be found in this tweet\n", 1)
        self.assertIn("No video", job["error"])
        self.assertIn("cookie", job["error"].lower())
        self.assertIn("keyring", job["error"].lower())

    def test_missing_secretstorage_is_not_overwritten_by_extractor_error(self) -> None:
        job = self.run_output(
            "ERROR: secretstorage not available as the `secretstorage` module is not installed.\n"
            "ERROR: [twitter] 123: Could not authenticate you\n", 1)
        self.assertIn("SecretStorage", job["error"])
        self.assertIn("Could not authenticate", job["error"])

    def test_diagnostics_and_pid_still_work_without_log_file(self) -> None:
        job = self.run_output("ERROR: network unavailable\n", 1, log_available=False)
        self.assertEqual(job["pid"], 12345)
        self.assertEqual(job["error"], "ERROR: network unavailable")

    def test_success_clears_recovered_errors(self) -> None:
        job = self.run_output("ERROR: temporary failure\n[download] 100%\n", 0)
        self.assertIsNone(job["error"])

    def test_success_with_unrelated_cookie_warning_is_not_an_error(self) -> None:
        job = self.run_output("WARNING: cannot decrypt v11 cookies: no key found\n", 0)
        self.assertIsNone(job.get("error"))

    def test_guest_fallback_explains_missing_x_session(self) -> None:
        job = self.run_output(
            "Extracted 89 cookies from chrome\n"
            "[twitter] 123: Downloading guest token\n"
            "ERROR: [twitter] 123: No video could be found in this tweet\n", 1)
        self.assertIn("No video", job["error"])
        self.assertIn("guest", job["error"])
        self.assertIn("profile", job["error"].lower())

    def test_unexpected_error_kills_yt_dlp(self) -> None:
        process = unittest.mock.MagicMock()
        process.stdout = io.StringIO("[download] Destination: a.mp4\n")
        process.poll.return_value = None
        with (
            unittest.mock.patch.object(host, "open_log_stream", return_value=None),
            unittest.mock.patch.object(host.subprocess, "Popen", return_value=process),
            unittest.mock.patch.object(host, "update_job", side_effect=[None, OSError("disk full")]),
            self.assertRaises(OSError),
        ):
            host.run_yt_dlp(["yt-dlp", "https://example.invalid/"], "test-job")
        process.kill.assert_called_once()

    def test_nonzero_exit_without_error_line_has_useful_error(self) -> None:
        job = self.run_output("", 2)
        self.assertIn("exit code 2", job["error"])


if __name__ == "__main__":
    unittest.main()
