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

_HANDLE_STATE = tempfile.TemporaryDirectory()


def setUpModule() -> None:
    # Downloads record their handle, so no test may reach the real handle list.
    root = Path(_HANDLE_STATE.name)
    host.HANDLES_PATH = root / "handles.json"
    host.HANDLES_LOCK_PATH = root / "handles.lock"
    host.THUMBS_DIR = root / "thumbs"
    host.ARCHIVE_PATH = root / "archive.txt"
    host.HANDLES_PATH.write_text('{"handles": {}}')


def tearDownModule() -> None:
    _HANDLE_STATE.cleanup()


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
        self.assertEqual(host.safe_path_part("///", fallback="100000000000001"), "100000000000001")

    def test_strips_control_characters(self) -> None:
        self.assertNotIn("\x00", host.safe_path_part("a\x00b"))
        self.assertNotIn("\n", host.safe_path_part("a\nb"))


class SafePathPartExpansionTests(unittest.TestCase):
    def test_dollar_cannot_expand_to_another_folder(self) -> None:
        self.assertNotIn("$", host.safe_path_part("$HOME"))
        self.assertEqual(host.safe_path_part("Ca$h"), "Ca_h")

    def test_control_and_bidi_characters_are_replaced(self) -> None:
        self.assertEqual(host.safe_path_part("a\x7fb\x85c"), "a_b_c")
        self.assertEqual(host.safe_path_part("evil\u202egpj.exe"), "evil_gpj.exe")

    def test_joiners_used_by_real_names_are_kept(self) -> None:
        self.assertEqual(host.safe_path_part("می\u200cخواهم"), "می\u200cخواهم")


class FacebookBatchMatchingTests(unittest.TestCase):
    def test_matches_profile_php_reels_tab(self) -> None:
        target = host.batch_target_for_url(
            "https://www.facebook.com/profile.php?id=100000000000001&sk=reels_tab"
        )
        self.assertEqual(target, {"provider": "facebook", "key": "100000000000001"})

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
        "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/100000000000001/?sk=reels_tab"
    )

    def test_matches_people_url_keyed_on_numeric_id(self) -> None:
        target = host.batch_target_for_url(self.PEOPLE_URL)
        self.assertEqual(target, {"provider": "facebook", "key": "100000000000001"})

    def test_same_profile_via_profile_php_and_people_url_produces_same_key(self) -> None:
        via_profile_php = host.batch_target_for_url(
            "https://www.facebook.com/profile.php?id=100000000000001&sk=reels_tab"
        )
        via_people = host.batch_target_for_url(self.PEOPLE_URL)
        self.assertEqual(via_profile_php, via_people)
        self.assertEqual(via_people["key"], "100000000000001")

    def test_rejects_people_url_without_reels_tab(self) -> None:
        self.assertIsNone(
            host.batch_target_for_url(
                "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/100000000000001/"
            )
        )

    def test_two_segment_people_reels_still_does_not_match(self) -> None:
        """The reserved-segment rule for /people/reels must stay intact."""
        self.assertIsNone(host.batch_target_for_url("https://www.facebook.com/people/reels"))

    def test_rejects_non_numeric_third_segment(self) -> None:
        self.assertIsNone(
            host.batch_target_for_url(
                "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/not-a-number/?sk=reels_tab"
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
                "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/100000000000001/?sk=reels_tab"
            ),
            "山田",
        )

    def test_decoded_name_survives_safe_path_part_intact(self) -> None:
        name = host.facebook_people_url_name(
            "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/100000000000001/?sk=reels_tab"
        )
        self.assertEqual(host.safe_path_part(name), "山田")

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
        malformed_url = "https://www.facebook.com/people/%E5%B0/100000000000001/?sk=reels_tab"
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
        target = {"provider": "facebook", "key": "100000000000001"}
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
        segment (山田) must be used instead of falling straight to the numeric id.
        """
        result = host.start_profile_download_jobs(
            "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/100000000000001/?sk=reels_tab",
            "extension",
            None,
            ["https://www.facebook.com/reel/123"],
            False,
            None,
        )
        self.assertTrue(result["ok"])
        self.assertTrue(result["download_dir"].endswith("山田"))
        self.assertEqual(result["username"], "100000000000001")

    def test_people_url_scraped_name_still_wins_over_url_decoded_name(self) -> None:
        result = host.start_profile_download_jobs(
            "https://www.facebook.com/people/%E5%B1%B1%E7%94%B0/100000000000001/?sk=reels_tab",
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
                "https://www.facebook.com/100000000000001/reels",
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

    def test_unreadable_preferences_make_the_match_unknown(self) -> None:
        # The unreadable profile may be the one that called the host.
        broken = self.config_home / "google-chrome" / "Default"
        broken.mkdir(parents=True)
        (broken / "Preferences").write_text("{not json")
        self.add_profile("Profile 5", [EXTENSION_ID])
        self.assertEqual(host.browser_spec(host.normalize_config({})), "chrome")

    def test_malformed_preferences_make_the_match_unknown(self) -> None:
        self.add_profile("Profile 5", [EXTENSION_ID])
        other = self.config_home / "google-chrome" / "Default"
        other.mkdir(parents=True)
        for value in [None, [], {"extensions": None}, {"extensions": {"settings": []}}]:
            with self.subTest(value=value):
                (other / "Preferences").write_text(json.dumps(value))
                self.assertEqual(host.browser_spec(host.normalize_config({})), "chrome")

    def test_preferences_without_extensions_are_skipped(self) -> None:
        other = self.config_home / "google-chrome" / "Default"
        other.mkdir(parents=True)
        (other / "Preferences").write_text("{}")
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
            unittest.mock.patch.object(host, "claim_job", return_value=True),
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
            unittest.mock.patch.object(host, "claim_job", return_value=False),
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

    def test_rejected_options_back_off_instead_of_failing_the_whole_queue(self) -> None:
        launch_next, record_failure, clear_failures = self.run_worker(lambda *_: 2)
        launch_next.assert_not_called()
        record_failure.assert_called_once()
        clear_failures.assert_not_called()

    def test_claim_requires_the_reservation_the_worker_was_launched_for(self) -> None:
        state = {"jobs": [{"id": "a", "status": "queued", "attempt": "old"}]}
        with unittest.mock.patch.object(host, "mutate_jobs", side_effect=lambda mutator: mutator(state)):
            # Cancelled and retried: queued again, so the old worker must not run.
            self.assertFalse(host.claim_job("a", "old", {"status": "running"}))
            state["jobs"][0].update({"status": "running", "attempt": "new"})
            self.assertFalse(host.claim_job("a", "old", {"worker_pid": 1}))
            self.assertTrue(host.claim_job("a", "new", {"worker_pid": 2}))
        self.assertEqual(state["jobs"][0]["worker_pid"], 2)

    def test_reservation_hands_its_attempt_to_the_worker(self) -> None:
        state = {"jobs": [{"id": "a", "url": "https://x.com/a/status/1", "status": "queued"}]}
        with unittest.mock.patch.object(host, "mutate_jobs", side_effect=lambda mutator: mutator(state)):
            job = host.reserve_next_job()
        payload = host.decode_worker_payload(host.encode_worker_payload(job))
        self.assertEqual(payload["attempt"], state["jobs"][0]["attempt"])
        self.assertTrue(payload["attempt"])

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

    def test_boolean_options_that_prefix_a_sensitive_one_are_not_values(self) -> None:
        redacted = host.redact_command(["yt-dlp", "--netrc", "--password", "pw", "--client-certificate", "c.pem"])
        self.assertNotIn("pw", redacted.split())
        self.assertIn("c.pem", redacted)

    def test_redacts_short_option_groups(self) -> None:
        for command in (["-qpSECRET"], ["-qu", "SECRET"], ["-q2SECRET"], ["-vp", "SECRET"]):
            with self.subTest(command=command):
                self.assertNotIn("SECRET", host.redact_command(["yt-dlp", *command]))

    def test_short_option_values_are_not_read_as_credential_flags(self) -> None:
        for group in ["-N2", "-o./clip", "-fbestup", "-x"]:
            with self.subTest(group=group):
                redacted = host.redact_command(["yt-dlp", group, "--password", "SECRET"])
                self.assertEqual(redacted, f"yt-dlp {group} --password ***")

    def test_launcher_does_not_overwrite_a_newer_reservation(self) -> None:
        state = {"jobs": [{"id": "a", "url": "https://x.com/a/status/1", "status": "running",
                           "attempt": "new", "worker_pid": 222}]}
        process = unittest.mock.MagicMock(pid=111)
        with (
            unittest.mock.patch.object(host, "mutate_jobs", side_effect=lambda mutator: mutator(state)),
            unittest.mock.patch.object(host.subprocess, "Popen", return_value=process),
            unittest.mock.patch.object(host, "process_start_ticks", return_value=1),
        ):
            self.assertTrue(host.launch_reserved_job({"id": "a", "url": "https://x.com/a/status/1", "attempt": "old"}))
        self.assertEqual(state["jobs"][0]["worker_pid"], 222)

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


class ReadJobsTests(unittest.TestCase):
    def read(self, raw: bytes) -> dict[str, Any]:
        with tempfile.TemporaryDirectory() as temp:
            jobs_path = Path(temp) / "downloads.json"
            jobs_path.write_bytes(raw)
            with unittest.mock.patch.object(host, "JOBS_PATH", jobs_path):
                return host.read_jobs_unlocked()

    def test_unexpected_shapes_read_as_empty_state(self) -> None:
        for raw in [b"[]", b"null", b"\xff\xfe", b"{not json"]:
            with self.subTest(raw=raw):
                self.assertEqual(self.read(raw)["jobs"], [])


class MissingDownloadDirTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def test_existing_folder_and_new_child_of_existing_folder_are_allowed(self) -> None:
        host.require_download_dir_parent(str(self.root))
        host.require_download_dir_parent(str(self.root / "new"))
        host.require_download_dir_parent(str(self.root / "new") + "/")

    def test_stale_path_is_refused_instead_of_rebuilt(self) -> None:
        # A remembered folder on a share that moved: rebuilding the chain would
        # quietly fill local disk instead of the share.
        with self.assertRaises(host.MissingDownloadDir):
            host.require_download_dir_parent(str(self.root / "gone" / "share" / "videos"))

    def test_config_default_folder_is_checked_too(self) -> None:
        config = {**host.DEFAULT_CONFIG, "download_dir": str(self.root / "gone" / "share")}
        with (
            unittest.mock.patch.object(host, "load_config", return_value=config),
            unittest.mock.patch.object(host, "mutate_jobs") as mutate_jobs,
        ):
            response = host.handle_message({"type": "download", "url": "https://x.com/a/status/1"})
        mutate_jobs.assert_not_called()
        self.assertTrue(response["missing_dir"])

    def test_worker_refuses_a_folder_that_vanished_after_queueing(self) -> None:
        payload = host.encode_worker_payload({
            "id": "job", "url": "https://x.com/a/status/1",
            "download_dir": str(self.root / "gone" / "share" / "a"),
        })
        with (
            unittest.mock.patch.object(host, "load_config", return_value=dict(host.DEFAULT_CONFIG)),
            unittest.mock.patch.object(host, "update_job") as update_job,
            unittest.mock.patch.object(host, "claim_job", return_value=True),
            unittest.mock.patch.object(host, "notify"),
            unittest.mock.patch.object(host, "log_line"),
            unittest.mock.patch.object(host, "run_yt_dlp") as run_yt_dlp,
            unittest.mock.patch.object(host, "record_launch_failure") as record_failure,
            unittest.mock.patch.object(host, "launch_next_queued_job") as launch_next,
        ):
            self.assertEqual(host.run_download_worker(payload), 1)
        run_yt_dlp.assert_not_called()
        launch_next.assert_not_called()
        record_failure.assert_called_once()
        self.assertIn("does not exist", update_job.call_args.args[1]["error"])

    def test_download_message_reports_missing_folder(self) -> None:
        stale = str(self.root / "gone" / "share" / "videos")
        with unittest.mock.patch.object(host, "mutate_jobs") as mutate_jobs:
            single = host.handle_message({"type": "download", "url": "https://x.com/a/status/1", "download_dir": stale})
            batch = host.handle_message({
                "type": "download", "url": "https://x.com/a/media", "download_dir": stale,
                "profile_urls": ["https://x.com/a/status/1"],
            })
        mutate_jobs.assert_not_called()
        for response in (single, batch):
            self.assertFalse(response["ok"])
            self.assertTrue(response["missing_dir"])
            self.assertIn("does not exist", response["error"])


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

class RedactEmbeddedUrlTests(unittest.TestCase):
    """Logs are kept for weeks, so a credential must not survive in any spelling."""

    def test_redacts_url_credentials_attached_to_an_option(self) -> None:
        command = [
            "yt-dlp", "--proxy=http://user:SECRET@proxy:8080",
            "--geo-verification-proxy=socks5://user:SECRET@host:1080",
            "--referer=https://example.com/?token=SECRET",
        ]
        redacted = host.redact_command(command)
        self.assertNotIn("SECRET", redacted)
        self.assertIn("--proxy=http://***@proxy:8080", redacted)

    def test_credentials_containing_spaces_are_redacted_whole(self) -> None:
        # One argv element can hold spaces; the URL runs to the end of it.
        for command in (
            ["--proxy", "http://user:hello SECRET@proxy:8080"],
            ["--proxy=http://user:hello SECRET@proxy:8080"],
            ["--referer", "https://example.com/?token=hello SECRET"],
        ):
            with self.subTest(command=command):
                self.assertNotIn("SECRET", host.redact_command(["yt-dlp", *command]))

    def test_separate_url_value_is_still_redacted(self) -> None:
        redacted = host.redact_command(["yt-dlp", "--proxy", "http://user:SECRET@proxy:8080"])
        self.assertEqual(redacted, "yt-dlp --proxy http://***@proxy:8080")


class TwitterDuplicateKeyTests(unittest.TestCase):
    """A post is one video however its URL is spelled; the status id identifies it."""

    def duplicate(self, queued_url: str, new_url: str) -> dict[str, Any] | None:
        state = {"jobs": [{"id": "a", "url": queued_url, "status": "complete"}]}
        return host.duplicate_download_for_url(state, host.normalize_url(new_url))

    def test_username_case_does_not_hide_a_duplicate(self) -> None:
        self.assertIsNotNone(
            self.duplicate("https://x.com/Foo/status/123", "https://twitter.com/foo/status/123")
        )

    def test_id_only_link_matches_the_named_one(self) -> None:
        self.assertIsNotNone(
            self.duplicate("https://x.com/foo/status/123", "https://x.com/i/status/123")
        )

    def test_different_posts_are_not_duplicates(self) -> None:
        self.assertIsNone(
            self.duplicate("https://x.com/foo/status/123", "https://x.com/foo/status/124")
        )

    def test_queued_url_keeps_the_username(self) -> None:
        # The stored URL still names the account: batch validation and the
        # dashboard title read it.
        self.assertEqual(
            host.normalize_url("https://x.com/Foo/status/123"), "https://x.com/Foo/status/123"
        )


class PrivateStateTests(unittest.TestCase):
    def test_existing_directories_are_made_private(self) -> None:
        # Older installs created the state directory with the default umask.
        with tempfile.TemporaryDirectory() as temp:
            app_dir, state_dir = Path(temp) / "app", Path(temp) / "state"
            state_dir.mkdir(mode=0o755)
            with (
                unittest.mock.patch.object(host, "APP_DIR", app_dir),
                unittest.mock.patch.object(host, "STATE_DIR", state_dir),
            ):
                host.ensure_state()
            self.assertEqual(os.stat(state_dir).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(app_dir).st_mode & 0o777, 0o700)


class LoadConfigTests(unittest.TestCase):
    def test_config_that_is_not_an_object_reads_as_defaults(self) -> None:
        # Same as malformed JSON: Options must still open so it can be fixed.
        for text in ["[]", "3", '"chrome"', "null"]:
            with self.subTest(text=text), tempfile.TemporaryDirectory() as temp:
                config_path = Path(temp) / "config.json"
                config_path.write_text(text)
                with (
                    unittest.mock.patch.object(host, "CONFIG_PATH", config_path),
                    unittest.mock.patch.object(host, "ensure_state"),
                ):
                    self.assertEqual(host.load_config(), host.DEFAULT_CONFIG)


class NotifyTests(unittest.TestCase):
    def test_a_notifier_that_cannot_run_does_not_fail_the_download(self) -> None:
        with unittest.mock.patch.object(host.subprocess, "run", side_effect=PermissionError("denied")):
            host.notify("summary", "body")


class InstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        import importlib.util

        path = Path(__file__).resolve().parent.parent / "scripts" / "install_native_host.py"
        spec = importlib.util.spec_from_file_location("install_native_host", path)
        self.installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.installer)

    def merged(self, existing: dict | None, **overrides: Any) -> dict:
        options = {"download_dir": None, "cookies_browser": None, "cookies_profile": None,
                   "yt_dlp_path": None, "extra_arg": None, **overrides}
        return self.installer.merge_config(existing, unittest.mock.MagicMock(**options))

    def test_relative_download_dir_is_stored_absolute(self) -> None:
        # The host rejects a relative folder, which would break every request.
        self.assertEqual(
            self.merged(None, download_dir="videos")["download_dir"], os.path.abspath("videos")
        )
        self.assertEqual(self.merged(None, download_dir="~/Videos")["download_dir"], "~/Videos")
        self.assertEqual(self.merged(None, download_dir="/srv/v")["download_dir"], "/srv/v")

    def test_existing_config_that_cannot_be_used_gives_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "config.json"
            for text in ["{not json", "[]"]:
                with self.subTest(text=text):
                    path.write_text(text)
                    existing = self.installer.read_existing_config(path)
                    self.assertEqual(self.merged(existing), self.installer.DEFAULT_CONFIG)
            with unittest.mock.patch.object(Path, "read_text", side_effect=PermissionError("denied")):
                self.assertIsNone(self.installer.read_existing_config(path))
            path.write_text('{"profile": "Profile 1"}')
            self.assertEqual(
                self.merged(self.installer.read_existing_config(path))["profile"], "Profile 1"
            )

    def test_failed_config_write_keeps_the_previous_config(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "config.json"
            path.write_text('{"profile": "Profile 1"}')
            with (
                unittest.mock.patch.object(self.installer, "INSTALL_DIR", Path(temp)),
                unittest.mock.patch.object(self.installer.json, "dumps", side_effect=OSError("disk full")),
                self.assertRaises(OSError),
            ):
                self.installer.write_private_json(path, {"profile": ""})
            self.assertEqual(json.loads(path.read_text()), {"profile": "Profile 1"})
            self.installer.write_private_json(path, {"profile": "Default"})
            self.assertEqual(json.loads(path.read_text()), {"profile": "Default"})
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertEqual(os.listdir(temp), ["config.json"])


class CancelKeepsSlotTests(unittest.TestCase):
    def test_running_download_is_stopped_before_its_slot_is_released(self) -> None:
        # Releasing the queue first lets a retry start a second yt-dlp on the
        # same files while the cancelled one is still writing them.
        state = {"jobs": [{"id": "a", "url": "https://x.com/a/status/1", "status": "running",
                           "worker_pid": 4242, "worker_start_ticks": 7}]}
        locked = []

        def mutate(mutator: Any) -> Any:
            locked.append(True)
            try:
                return mutator(state)
            finally:
                locked.pop()

        def terminate(pid: Any, ticks: Any) -> bool:
            self.assertTrue(locked, "the worker must be stopped while the queue is locked")
            self.assertEqual((pid, ticks), (4242, 7))
            return True

        with (
            unittest.mock.patch.object(host, "mutate_jobs", side_effect=mutate),
            unittest.mock.patch.object(host, "terminate_process_group", side_effect=terminate) as stop,
            unittest.mock.patch.object(host, "launch_next_queued_job") as launch_next,
            unittest.mock.patch.object(host, "log_line"),
        ):
            self.assertTrue(host.cancel_download_job("a")["ok"])
        stop.assert_called_once()
        launch_next.assert_called_once()
        self.assertEqual(state["jobs"][0]["status"], "cancelled")


class WorkerAttemptTests(unittest.TestCase):
    def update(self, worker_attempt: Any) -> tuple[bool, dict[str, Any]]:
        state = {"jobs": [{"id": "a", "status": "running", "attempt": "new", "progress": 0}]}
        with (
            unittest.mock.patch.object(host, "mutate_jobs", side_effect=lambda mutator: mutator(state)),
            unittest.mock.patch.object(host, "WORKER_ATTEMPT", worker_attempt),
        ):
            applied = host.update_job("a", {"status": "failed"})
        return applied, state["jobs"][0]

    def test_worker_of_an_older_attempt_cannot_touch_the_retry(self) -> None:
        # After cancel and retry the old worker may still be running.
        applied, job = self.update("old")
        self.assertFalse(applied)
        self.assertEqual(job["status"], "running")

    def test_current_worker_and_the_host_can_update(self) -> None:
        for attempt in ("new", None):
            with self.subTest(attempt=attempt):
                applied, job = self.update(attempt)
                self.assertTrue(applied)
                self.assertEqual(job["status"], "failed")

    def test_worker_error_before_claim_respects_the_attempt(self) -> None:
        state = {"jobs": [{"id": "job", "status": "running", "attempt": "new"}]}
        payload = host.encode_worker_payload(
            {"id": "job", "attempt": "old", "url": "https://x.com/a/status/1"})
        with (
            unittest.mock.patch.object(host, "mutate_jobs", side_effect=lambda mutator: mutator(state)),
            unittest.mock.patch.object(host, "load_config", side_effect=ValueError("bad config")),
            unittest.mock.patch.object(host, "notify"),
            unittest.mock.patch.object(host, "log_line"),
            unittest.mock.patch.object(host, "record_launch_failure"),
            unittest.mock.patch.object(host, "WORKER_ATTEMPT", None),
        ):
            self.assertEqual(host.run_download_worker(payload), 1)
        self.assertEqual(state["jobs"][0]["status"], "running")


class OrphanedDownloadTests(unittest.TestCase):
    def spawn(self, job_id: str) -> Any:
        import subprocess

        process = subprocess.Popen(
            ["sleep", "30"], start_new_session=True,
            env={**os.environ, host.JOB_ID_ENV: job_id},
        )
        self.addCleanup(process.wait)
        self.addCleanup(process.kill)
        return process

    def test_reaping_a_dead_worker_kills_the_download_it_left_behind(self) -> None:
        # Otherwise a retry runs next to the surviving yt-dlp or ffmpeg.
        process = self.spawn("job-a")
        host.kill_orphaned_downloads({"id": "job-a", "worker_pid": process.pid})
        self.assertEqual(process.wait(timeout=5), -9)

    def test_processes_of_other_jobs_are_left_alone(self) -> None:
        # Pids are recycled, so the group id alone does not prove ownership.
        process = self.spawn("job-b")
        host.kill_orphaned_downloads({"id": "job-a", "worker_pid": process.pid})
        self.assertIsNone(process.poll())

    def test_stale_job_is_reaped_with_its_downloads(self) -> None:
        state = {"jobs": [{"id": "a", "status": "running", "worker_pid": 4242}]}
        with (
            unittest.mock.patch.object(host, "job_worker_is_alive", return_value=False),
            unittest.mock.patch.object(host, "kill_orphaned_downloads") as kill,
        ):
            host.reap_stale_jobs(state)
        kill.assert_called_once()
        self.assertEqual(state["jobs"][0]["status"], "failed")


class LogRedactionTests(unittest.TestCase):
    def test_verbose_option_dump_is_kept_out_of_the_log(self) -> None:
        # yt-dlp --verbose prints its arguments, credentials included.
        process = unittest.mock.MagicMock()
        process.stdout = io.StringIO(
            "[debug] Command-line config: ['--proxy', 'http://user:SECRET@proxy:8080', '-v']\n"
            "[debug] User config \"/home/u/yt-dlp.conf\": ['--password', 'SECRET']\n"
            "[debug] yt-dlp version 2026.01.01\n"
        )
        process.wait.return_value = 0
        written: list[str] = []
        with (
            unittest.mock.patch.object(host, "open_log_stream", return_value=io.StringIO()),
            unittest.mock.patch.object(
                host, "write_log_stream", side_effect=lambda handle, text: written.append(text) or handle),
            unittest.mock.patch.object(host.subprocess, "Popen", return_value=process),
            unittest.mock.patch.object(host, "update_job"),
        ):
            host.run_yt_dlp(["yt-dlp", "https://example.invalid/"], "test-job")
        log = "".join(written)
        self.assertNotIn("SECRET", log)
        self.assertIn("Command-line config", log)
        self.assertIn("yt-dlp version", log)


class DownloadDirExpansionTests(unittest.TestCase):
    def test_folder_with_a_variable_reference_is_refused(self) -> None:
        # yt-dlp expands $NAME in -P, so files would land outside the folder
        # the host checked and recorded.
        for folder in ("/srv/videos/$USER", "/srv/${HOME}/v", "~/$x"):
            with self.subTest(folder=folder), self.assertRaises(ValueError):
                host.resolve_download_dir(folder)


class BatchDuplicateTests(unittest.TestCase):
    def test_same_post_spelled_twice_in_one_batch_is_queued_once(self) -> None:
        state = {"jobs": []}
        with (
            tempfile.TemporaryDirectory() as temp,
            unittest.mock.patch.object(host, "mutate_jobs", side_effect=lambda mutator: mutator(state)),
            unittest.mock.patch.object(host, "launch_next_queued_job", return_value={"started": False}),
        ):
            response = host.start_profile_download_jobs(
                "https://x.com/Foo/media", "test", temp,
                ["https://x.com/Foo/status/123", "https://x.com/foo/status/123",
                 "https://x.com/Foo/status/124"],
            )
        self.assertEqual(response["queued_count"], 2)


if __name__ == "__main__":
    unittest.main()


class OpenFolderTests(unittest.TestCase):
    """The Folder button must reach a file manager, not whatever claims folders."""

    def test_file_manager_is_asked_before_the_generic_opener(self) -> None:
        completed = unittest.mock.Mock(returncode=0)
        with unittest.mock.patch.object(host.shutil, "which", return_value="/usr/bin/gdbus"), \
                unittest.mock.patch.object(host.subprocess, "run", return_value=completed) as run, \
                unittest.mock.patch.object(host.subprocess, "Popen") as popen:
            host.open_folder(Path("/tmp/it's here/clips"))

        command = run.call_args.args[0]
        self.assertIn("org.freedesktop.FileManager1.ShowFolders", command)
        # The quote is percent-encoded, so it cannot end the GVariant string.
        self.assertIn("['file:///tmp/it%27s%20here/clips']", command)
        popen.assert_not_called()

    def test_generic_opener_is_the_fallback(self) -> None:
        failed = unittest.mock.Mock(returncode=1)
        with unittest.mock.patch.object(host.shutil, "which", side_effect=lambda name: f"/usr/bin/{name}"), \
                unittest.mock.patch.object(host.subprocess, "run", return_value=failed), \
                unittest.mock.patch.object(host.subprocess, "Popen") as popen:
            host.open_folder(Path("/tmp/clips"))

        self.assertEqual(popen.call_args.args[0], ["/usr/bin/xdg-open", "/tmp/clips"])

    def test_a_hung_file_manager_does_not_block_the_fallback(self) -> None:
        timeout = host.subprocess.TimeoutExpired("gdbus", 5)
        with unittest.mock.patch.object(host.shutil, "which", side_effect=lambda name: f"/usr/bin/{name}"), \
                unittest.mock.patch.object(host.subprocess, "run", side_effect=timeout), \
                unittest.mock.patch.object(host.subprocess, "Popen") as popen:
            host.open_folder(Path("/tmp/clips"))

        popen.assert_called_once()


class HandleStateCase(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for name, value in (
            ("HANDLES_PATH", self.root / "handles.json"),
            ("HANDLES_LOCK_PATH", self.root / "handles.lock"),
            ("THUMBS_DIR", self.root / "thumbs"),
            ("JOBS_PATH", self.root / "downloads.json"),
            ("JOBS_LOCK_PATH", self.root / "downloads.lock"),
        ):
            patcher = unittest.mock.patch.object(host, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name in ("ensure_state", "log_line"):
            patcher = unittest.mock.patch.object(host, name)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.library = self.root / "library"
        self.library.mkdir()
        config = unittest.mock.patch.object(
            host, "load_config", return_value=dict(host.DEFAULT_CONFIG, download_dir=str(self.library))
        )
        config.start()
        self.addCleanup(config.stop)
        state_dir = unittest.mock.patch.object(host, "STATE_DIR", self.root)
        state_dir.start()
        self.addCleanup(state_dir.stop)
        archive = unittest.mock.patch.object(host, "ARCHIVE_PATH", self.root / "archive.txt")
        archive.start()
        self.addCleanup(archive.stop)

    def write_jobs(self, jobs: list[dict[str, Any]]) -> None:
        host.JOBS_PATH.write_text(json.dumps({"jobs": jobs}))

    def only_handle(self) -> dict[str, Any]:
        handles = host.get_handles()["handles"]
        self.assertEqual(len(handles), 1)
        return handles[0]


class HandleListTests(HandleStateCase):
    """The handle list exists to answer one question: what is new since I last downloaded?"""

    def post(self, post_id: int, username: str = "Someone") -> str:
        return f"https://x.com/{username}/status/{post_id}"

    def test_a_check_reports_only_posts_that_were_never_downloaded(self) -> None:
        host.remember_handle("Someone", [self.post(1), self.post(2)], base_dir="/data")

        response = host.record_handle_scan("someone", [self.post(1), self.post(2), self.post(3)])

        self.assertEqual(response["handle"]["pending_count"], 1)
        self.assertEqual(response["handle"]["known_count"], 2)
        self.assertIsNotNone(response["handle"]["last_checked"])

    def test_a_post_reached_through_another_spelling_is_not_new(self) -> None:
        host.remember_handle("Someone", [self.post(1)])

        response = host.record_handle_scan(
            "Someone", ["https://twitter.com/SOMEONE/status/1?s=20", self.post(2), self.post(2)]
        )

        self.assertEqual(response["handle"]["pending_count"], 1)

    def test_posts_by_other_accounts_are_never_offered(self) -> None:
        # A media page also links reposts; those belong to someone else's folder.
        host.remember_handle("Someone", [self.post(1)])

        response = host.record_handle_scan("Someone", [self.post(9, "Other"), "not a url"])

        self.assertEqual(response["handle"]["pending_count"], 0)

    def test_marking_seen_stops_the_posts_being_reported_again(self) -> None:
        host.remember_handle("Someone", [self.post(1)])
        host.record_handle_scan("Someone", [self.post(2)])

        host.mark_handle_seen("Someone")
        response = host.record_handle_scan("Someone", [self.post(1), self.post(2)])

        self.assertEqual(response["handle"]["pending_count"], 0)

    def test_new_videos_download_into_the_folder_the_handle_already_uses(self) -> None:
        host.remember_handle("Someone", [self.post(1)], base_dir="/data/x", name="Some One", replace_folder=True)
        host.record_handle_scan("Someone", [self.post(2), self.post(3)])

        with unittest.mock.patch.object(
            host, "start_profile_download_jobs", return_value={"ok": True}
        ) as start:
            host.download_handle_pending("someone")

        url, _source, base_dir, urls, allow_duplicate, name = start.call_args.args
        self.assertEqual(url, "https://x.com/Someone/media")
        self.assertEqual(base_dir, "/data/x")
        self.assertEqual(urls, [self.post(2), self.post(3)])
        self.assertFalse(allow_duplicate)
        self.assertEqual(name, "Some One")

    def test_queued_batch_marks_its_posts_as_seen(self) -> None:
        self.write_jobs([])
        with unittest.mock.patch.object(host, "launch_next_queued_job", return_value={"started": True}):
            host.start_profile_download_jobs(
                "https://x.com/Someone/media",
                "toolbar",
                str(self.root),
                [self.post(1), self.post(2)],
            )

        entry = self.only_handle()
        self.assertEqual(entry["known_count"], 2)
        self.assertEqual(entry["base_dir"], str(self.root))
        response = host.record_handle_scan("Someone", [self.post(1), self.post(2)])
        self.assertEqual(response["handle"]["pending_count"], 0)

    def test_a_single_post_download_adds_its_handle(self) -> None:
        self.write_jobs([])
        with unittest.mock.patch.object(host, "launch_next_queued_job", return_value={"started": True}):
            host.start_download_job(self.post(5), "toolbar", str(self.root))

        self.assertEqual(self.only_handle()["handle"], "Someone")

    def test_nothing_to_download_is_reported_instead_of_queueing_an_empty_batch(self) -> None:
        host.remember_handle("Someone", [self.post(1)])

        response = host.download_handle_pending("Someone")

        self.assertFalse(response["ok"])

    def test_unknown_handle_is_refused(self) -> None:
        host.HANDLES_PATH.write_text('{"handles": {}}')
        with self.assertRaises(ValueError):
            host.record_handle_scan("Stranger", [self.post(1, "Stranger")])

    def test_first_use_starts_from_the_downloads_already_on_the_dashboard(self) -> None:
        folder = "/data/x/Some One"
        self.write_jobs(
            [
                {"id": "a" * 32, "url": self.post(1), "status": "complete", "download_dir": folder},
                {"id": "b" * 32, "url": self.post(2), "status": "complete", "download_dir": folder},
                {"id": "c" * 32, "url": self.post(7, "Solo"), "status": "complete", "download_dir": "/data/misc"},
                {"id": "d" * 32, "url": self.post(8, "Gone"), "status": "failed", "download_dir": "/data/misc"},
            ]
        )

        handles = {entry["handle"]: entry for entry in host.get_handles()["handles"]}

        self.assertEqual(set(handles), {"Someone", "Solo"})
        self.assertEqual(handles["Someone"]["base_dir"], "/data/x")
        self.assertEqual(handles["Someone"]["name"], "Some One")
        self.assertEqual(handles["Someone"]["known_count"], 2)
        self.assertEqual(handles["Solo"]["base_dir"], "/data/misc")

    def test_a_handle_that_cannot_be_recorded_does_not_fail_the_download(self) -> None:
        with unittest.mock.patch.object(host, "mutate_handles", side_effect=OSError("read-only")):
            host.remember_handle("Someone", [self.post(1)])

    def test_message_handle_rejects_paths(self) -> None:
        with self.assertRaises(ValueError):
            host.message_handle({"handle": "../etc"})
        self.assertEqual(host.message_handle({"handle": "@Someone"}), "Someone")


class ThumbnailTests(HandleStateCase):
    def test_only_job_ids_name_thumbnail_files(self) -> None:
        self.assertIsNone(host.thumbnail_path("../../etc/passwd"))
        self.assertIsNone(host.thumbnail_path("A" * 32))
        self.assertEqual(host.thumbnail_path("a" * 32), host.THUMBS_DIR / f"{'a' * 32}.jpg")

    def test_thumbnails_are_returned_for_known_ids_only(self) -> None:
        host.THUMBS_DIR.mkdir()
        (host.THUMBS_DIR / f"{'a' * 32}.jpg").write_bytes(b"jpeg")

        response = host.get_thumbnails(["a" * 32, "b" * 32, "../x", 7])

        self.assertEqual(response["thumbs"], {"a" * 32: "anBlZw=="})

    def test_a_response_stops_before_chromes_message_limit(self) -> None:
        host.THUMBS_DIR.mkdir()
        for job_id in ("a" * 32, "b" * 32):
            (host.THUMBS_DIR / f"{job_id}.jpg").write_bytes(b"x" * 300 * 1024)

        response = host.get_thumbnails(["a" * 32, "b" * 32])

        self.assertEqual(list(response["thumbs"]), ["a" * 32])

    def test_pictures_of_forgotten_downloads_are_deleted(self) -> None:
        host.THUMBS_DIR.mkdir()
        kept = host.THUMBS_DIR / f"{'a' * 32}.jpg"
        stale = host.THUMBS_DIR / f"{'b' * 32}.jpg"
        kept.write_bytes(b"x")
        stale.write_bytes(b"x")
        self.write_jobs([{"id": "a" * 32, "url": "https://x.com/a/status/1", "status": "complete"}])

        host.prune_thumbnails()

        self.assertTrue(kept.exists())
        self.assertFalse(stale.exists())

    def test_a_missing_video_or_ffmpeg_leaves_the_download_complete(self) -> None:
        self.write_jobs(
            [{"id": "a" * 32, "url": "https://x.com/a/status/1", "status": "complete", "filename": "/nope.mp4"}]
        )
        self.assertFalse(host.save_job_thumbnail("a" * 32))
        with unittest.mock.patch.object(host.shutil, "which", return_value=None):
            self.assertFalse(host.save_job_thumbnail("a" * 32))

    @unittest.skipUnless(host.shutil.which("ffmpeg"), "ffmpeg is not installed")
    def test_a_frame_is_saved_for_a_finished_download(self) -> None:
        video = self.root / "clip.mp4"
        host.subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=0.5:size=640x360:rate=10", str(video)],
            check=True,
        )
        self.write_jobs(
            [{"id": "a" * 32, "url": "https://x.com/a/status/1", "status": "complete", "filename": str(video)}]
        )

        # Half a second long, so this also covers the fallback to the first frame.
        self.assertTrue(host.save_job_thumbnail("a" * 32))

        self.assertGreater((host.THUMBS_DIR / f"{'a' * 32}.jpg").stat().st_size, 0)
        self.assertTrue(host.get_download_job("a" * 32)["thumb"])


class PlayDownloadTests(HandleStateCase):
    def setUp(self) -> None:
        super().setUp()
        self.video = self.root / "clip one.mp4"
        self.video.write_bytes(b"x")
        self.write_jobs(
            [{"id": "a" * 32, "url": "https://x.com/a/status/1", "status": "complete", "filename": str(self.video)}]
        )

    def play(self, player: str) -> tuple[dict[str, Any], unittest.mock.Mock]:
        config = dict(host.DEFAULT_CONFIG, player=player)
        with unittest.mock.patch.object(host, "load_config", return_value=config), \
                unittest.mock.patch.object(host.shutil, "which", side_effect=lambda name: f"/usr/bin/{name}"), \
                unittest.mock.patch.object(host.subprocess, "Popen") as popen:
            return host.play_download("a" * 32), popen

    def test_the_configured_player_gets_the_file_as_one_argument(self) -> None:
        response, popen = self.play("haruna")

        self.assertTrue(response["ok"])
        self.assertEqual(popen.call_args.args[0], ["/usr/bin/haruna", str(self.video)])

    def test_player_arguments_come_before_the_file(self) -> None:
        _response, popen = self.play('mpv --fs --title="my clip"')

        self.assertEqual(
            popen.call_args.args[0], ["/usr/bin/mpv", "--fs", "--title=my clip", str(self.video)]
        )

    def test_a_missing_player_is_reported_not_raised(self) -> None:
        config = dict(host.DEFAULT_CONFIG, player="no-such-player")
        with unittest.mock.patch.object(host, "load_config", return_value=config), \
                unittest.mock.patch.object(host.shutil, "which", return_value=None):
            response = host.play_download("a" * 32)

        self.assertFalse(response["ok"])
        self.assertIn("no-such-player", response["error"])

    def test_a_moved_file_is_reported_before_any_player_starts(self) -> None:
        self.video.unlink()

        response, popen = self.play("mpv")

        self.assertFalse(response["ok"])
        popen.assert_not_called()

    def test_a_player_command_that_cannot_be_parsed_is_refused_when_saved(self) -> None:
        with self.assertRaises(ValueError):
            host.normalize_config(dict(host.DEFAULT_CONFIG, player='mpv "unclosed'))

    def test_an_existing_config_without_a_player_defaults_to_mpv(self) -> None:
        config = dict(host.DEFAULT_CONFIG)
        del config["player"]
        self.assertEqual(host.normalize_config(config)["player"], "mpv")


class LibraryCase(HandleStateCase):
    def video(self, relative: str) -> Path:
        path = self.library / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
        return path

    def handles(self) -> dict[str, dict[str, Any]]:
        return {entry["handle"]: entry for entry in host.get_handles()["handles"]}


class LibraryImportTests(LibraryCase):
    """The library on disk is <group>/<handle>/, with former handles nested inside."""

    def test_groups_and_handles_come_from_the_folder_layout(self) -> None:
        self.video("hard j/alice/abcdefghijklmnop.mp4")
        self.video("hard j/alice/alice-1234567890123.mp4")
        self.video("hard ch/Bob_2/Bob_2-1234567890999.mp4")
        self.video("hard j/loose-file.mp4")

        response = host.import_library()

        handles = self.handles()
        self.assertEqual(response["found"], 2)
        self.assertEqual(handles["alice"]["group"], "hard j")
        self.assertEqual(handles["alice"]["video_count"], 2)
        self.assertEqual(handles["Bob_2"]["group"], "hard ch")
        self.assertEqual(host.get_handles()["groups"], ["hard ch", "hard j"])

    def test_a_folder_nested_in_a_handle_is_its_former_handle(self) -> None:
        self.video("hard j/new_name/new_name-1234567890001.mp4")
        self.video("hard j/new_name/old_name/old_name-1234567890002.mp4")

        host.import_library()

        entry = self.handles()["new_name"]
        self.assertEqual(entry["aliases"], ["old_name"])
        self.assertEqual(entry["video_count"], 2)
        self.assertNotIn("old_name", self.handles())

    def test_a_folder_named_after_a_display_name_is_read_from_its_files(self) -> None:
        self.video("fem/Some Display Name/real_handle-1234567890001.mp4")
        self.video("fem/月瑶 Reels/61570702198230-1234567890002.mp4")

        response = host.import_library()

        entry = self.handles()["real_handle"]
        self.assertEqual(entry["name"], "Some Display Name")
        # A numeric prefix is a Facebook page id, not a handle.
        self.assertEqual(response["skipped"], ["fem/月瑶 Reels"])

    def test_a_handle_downloaded_into_the_root_is_not_taken_for_a_group(self) -> None:
        self.video("solo/solo-1234567890001.mp4")
        self.video("solo/former/former-1234567890002.mp4")

        host.import_library()

        entry = self.handles()["solo"]
        self.assertEqual(entry["group"], "")
        self.assertEqual(entry["aliases"], ["former"])
        self.assertNotIn("solo", host.get_handles()["groups"])

    def test_synology_metadata_and_the_trash_are_not_library_content(self) -> None:
        self.video("@eaDir/alice/x.mp4")
        self.video("_trash/hard j/alice/alice-1234567890001.mp4")
        self.video("hard j/alice/@eaDir/alice-1234567890002.mp4")
        self.video("hard j/alice/alice-1234567890003.mp4")

        response = host.import_library()

        self.assertEqual(response["found"], 1)
        self.assertEqual(self.handles()["alice"]["video_count"], 1)

    def test_importing_again_changes_nothing_and_keeps_what_was_checked(self) -> None:
        self.video("hard j/alice/alice-1234567890001.mp4")
        host.import_library()
        host.record_handle_scan("alice", ["https://x.com/alice/status/5"])

        response = host.import_library()

        self.assertEqual(response["added"], 0)
        self.assertEqual(response["archive_added"], 0)
        self.assertEqual(self.handles()["alice"]["pending_count"], 1)

    def test_a_creator_filed_under_two_groups_is_one_handle_with_both_folders(self) -> None:
        # Groups sort content, so the same creator can have a folder in several.
        self.video("dildo j/alice/a.mp4")
        self.video("hard j/alice/b.mp4")
        self.video("hard j/alice/c.mp4")

        response = host.import_library()

        self.assertEqual(response["in_several_groups"], 1)
        entry = self.handles()["alice"]
        self.assertEqual([folder["group"] for folder in entry["folders"]], ["dildo j", "hard j"])
        self.assertEqual(entry["video_count"], 3)
        self.assertEqual(host.import_library()["added"], 0)
        self.assertEqual(len(self.handles()["alice"]["folders"]), 2)

    def test_downloaded_videos_are_recorded_so_they_are_never_fetched_again(self) -> None:
        self.video("hard j/alice/alice-1234567890001.mp4")
        self.video("hard j/alice/old/old-1234567890002.mp4")
        self.video("hard j/alice/abcdefghijklmnop.mp4")

        response = host.import_library()

        self.assertEqual(response["archive_added"], 2)
        self.assertEqual(
            host.ARCHIVE_PATH.read_text().splitlines(),
            ["twitter 1234567890001", "twitter 1234567890002"],
        )

    def test_a_missing_share_is_reported_instead_of_emptying_the_list(self) -> None:
        self.library.rmdir()
        with self.assertRaises(host.MissingDownloadDir):
            host.import_library()


class HandleRenameTests(LibraryCase):
    """A creator who changes handle keeps one folder: the old one moves inside the new."""

    def setUp(self) -> None:
        super().setUp()
        self.write_jobs([])
        self.video("hard j/old_name/old_name-1234567890001.mp4")
        host.import_library()
        host.remember_handle("old_name", ["https://x.com/old_name/status/1"])

    def test_rename_nests_the_old_folder_under_the_new_handle(self) -> None:
        host.update_handle("old_name", "new_name", None)

        self.assertTrue((self.library / "hard j/new_name/old_name/old_name-1234567890001.mp4").is_file())
        self.assertFalse((self.library / "hard j/old_name").exists())
        entry = self.handles()["new_name"]
        self.assertEqual(entry["aliases"], ["old_name"])
        self.assertEqual(entry["group"], "hard j")
        self.assertEqual(entry["profile_url"], "https://x.com/new_name/media")
        self.assertNotIn("old_name", self.handles())

    def test_posts_downloaded_under_the_old_name_are_not_offered_again(self) -> None:
        host.update_handle("old_name", "new_name", None)

        response = host.record_handle_scan(
            "new_name", ["https://x.com/new_name/status/1", "https://x.com/new_name/status/2"]
        )

        self.assertEqual(response["handle"]["pending_count"], 1)

    def test_renaming_to_a_listed_handle_merges_the_two(self) -> None:
        self.video("hard j/new_name/new_name-1234567890009.mp4")
        host.import_library()

        host.update_handle("old_name", "new_name", None)

        self.assertTrue((self.library / "hard j/new_name/old_name/old_name-1234567890001.mp4").is_file())
        entry = self.handles()["new_name"]
        self.assertEqual(entry["video_count"], 2)
        self.assertEqual(entry["aliases"], ["old_name"])
        self.assertEqual(len(entry["folders"]), 1)

    def test_a_merge_keeps_each_folder_in_its_own_group(self) -> None:
        # The new handle only has a folder in another group, so the old videos
        # stay in theirs, under a folder for the new handle.
        self.video("white/new_name/new_name-1234567890009.mp4")
        host.import_library()

        host.update_handle("old_name", "new_name", None)

        self.assertTrue((self.library / "hard j/new_name/old_name/old_name-1234567890001.mp4").is_file())
        self.assertTrue((self.library / "white/new_name/new_name-1234567890009.mp4").is_file())
        entry = self.handles()["new_name"]
        self.assertEqual([folder["group"] for folder in entry["folders"]], ["white", "hard j"])

    def test_a_rename_applies_in_every_group_the_handle_is_filed_under(self) -> None:
        self.video("dildo j/old_name/x.mp4")
        host.import_library()

        host.update_handle("old_name", "new_name", None)

        self.assertTrue((self.library / "hard j/new_name/old_name").is_dir())
        self.assertTrue((self.library / "dildo j/new_name/old_name/x.mp4").is_file())
        self.assertEqual(
            sorted(folder["group"] for folder in self.handles()["new_name"]["folders"]),
            ["dildo j", "hard j"],
        )

    def test_only_the_folder_in_the_chosen_group_moves(self) -> None:
        self.video("dildo j/old_name/x.mp4")
        host.import_library()

        host.update_handle("old_name", None, "white", "hard j")

        self.assertTrue((self.library / "white/old_name/old_name-1234567890001.mp4").is_file())
        self.assertTrue((self.library / "dildo j/old_name/x.mp4").is_file())
        with self.assertRaises(ValueError):
            host.update_handle("old_name", None, "dildo j", "white")

    def test_new_videos_go_to_the_folder_in_the_group_they_were_asked_from(self) -> None:
        self.video("dildo j/old_name/x.mp4")
        host.import_library()
        host.record_handle_scan("old_name", ["https://x.com/old_name/status/50"])

        with unittest.mock.patch.object(
            host, "start_profile_download_jobs", return_value={"ok": True}
        ) as start:
            host.download_handle_pending("old_name", "hard j")

        self.assertEqual(start.call_args.args[2], str(self.library / "hard j"))

    def test_a_download_into_either_group_uses_the_folder_there(self) -> None:
        self.video("dildo j/old_name/x.mp4")
        host.import_library()
        for group in ("dildo j", "hard j"):
            self.assertEqual(
                host.known_handle_folder("old_name", str(self.library / group)), ("old_name", "old_name")
            )
        self.assertIsNone(host.known_handle_folder("old_name", str(self.library / "white")))

    def test_a_second_rename_keeps_every_former_handle(self) -> None:
        host.update_handle("old_name", "mid_name", None)
        host.update_handle("mid_name", "new_name", None)

        self.assertTrue(
            (self.library / "hard j/new_name/mid_name/old_name/old_name-1234567890001.mp4").is_file()
        )
        self.assertEqual(self.handles()["new_name"]["aliases"], ["mid_name", "old_name"])

    def test_moving_to_another_group_moves_the_folder(self) -> None:
        host.update_handle("old_name", None, "hard ch")

        self.assertTrue((self.library / "hard ch/old_name/old_name-1234567890001.mp4").is_file())
        self.assertEqual(self.handles()["old_name"]["group"], "hard ch")

    def test_nothing_moves_when_the_destination_is_taken(self) -> None:
        self.video("hard ch/old_name/other.mp4")

        with self.assertRaises(ValueError):
            host.update_handle("old_name", None, "hard ch")

        self.assertTrue((self.library / "hard j/old_name/old_name-1234567890001.mp4").is_file())
        self.assertEqual(self.handles()["old_name"]["group"], "hard j")

    def test_a_handle_with_downloads_in_flight_is_not_moved(self) -> None:
        self.write_jobs(
            [
                {
                    "id": "a" * 32,
                    "url": "https://x.com/old_name/status/9",
                    "status": "queued",
                    "download_dir": str(self.library / "hard j/old_name"),
                }
            ]
        )

        with self.assertRaises(ValueError):
            host.update_handle("old_name", "new_name", None)

        self.assertTrue((self.library / "hard j/old_name").is_dir())

    def test_a_group_cannot_point_outside_the_library(self) -> None:
        for group in ("../elsewhere", "a/b", "..", "_trash", "@eaDir"):
            with self.assertRaises(ValueError):
                host.update_handle("old_name", None, group)

    def test_a_download_from_a_former_handle_lands_in_the_current_folder(self) -> None:
        host.update_handle("old_name", "new_name", None)
        with unittest.mock.patch.object(host, "launch_next_queued_job", return_value={"started": True}):
            response = host.start_profile_download_jobs(
                "https://x.com/old_name/media",
                "toolbar",
                str(self.library / "hard j"),
                ["https://x.com/old_name/status/7"],
            )

        self.assertEqual(response["download_dir"], str(self.library / "hard j/new_name"))
        self.assertEqual(set(self.handles()), {"new_name"})


class AddHandleTests(LibraryCase):
    def test_a_handle_can_be_followed_before_anything_is_downloaded(self) -> None:
        host.add_handle("fresh", "hard j")

        entry = self.handles()["fresh"]
        self.assertEqual(entry["group"], "hard j")
        self.assertEqual(entry["known_count"], 0)

    def test_a_former_handle_is_not_added_a_second_time(self) -> None:
        self.video("hard j/new_name/old_name/x.mp4")
        host.import_library()

        with self.assertRaises(ValueError):
            host.add_handle("old_name", "hard j")


class DownloadArchiveTests(unittest.TestCase):
    def command(self, **kwargs: Any) -> list[str]:
        return host.build_command("https://x.com/a/status/1", dict(host.DEFAULT_CONFIG), "/data", **kwargs)

    def test_downloads_are_checked_against_the_archive(self) -> None:
        command = self.command()
        self.assertEqual(command[command.index("--download-archive") + 1], str(host.ARCHIVE_PATH))

    def test_a_download_asked_for_again_on_purpose_bypasses_the_archive(self) -> None:
        self.assertNotIn("--download-archive", self.command(use_archive=False))

    def test_a_download_missing_segments_fails_instead_of_saving_a_frozen_video(self) -> None:
        self.assertIn("--abort-on-unavailable-fragments", self.command())

    def test_a_skipped_video_is_not_reported_as_a_fresh_download(self) -> None:
        line = "[download] 2063957158568529920: has already been recorded in the archive"
        self.assertEqual(
            host.parse_progress_line(line), {"skipped": True, "status_detail": "Already downloaded"}
        )


class TrashDownloadTests(LibraryCase):
    def job(self, **fields: Any) -> None:
        self.write_jobs([{"id": "a" * 32, "url": "https://x.com/alice/status/1", "status": "complete", **fields}])

    def test_a_finished_download_goes_to_the_trash_and_leaves_the_dashboard(self) -> None:
        video = self.video("hard j/alice/alice-1234567890001.mp4")
        self.job(filename=str(video))

        response = host.trash_download("a" * 32)

        self.assertTrue(response["ok"])
        self.assertTrue((self.library / "_trash/hard j/alice/alice-1234567890001.mp4").is_file())
        self.assertIsNone(host.get_download_job("a" * 32))

    def test_a_file_outside_the_library_is_left_alone(self) -> None:
        outside = self.root / "elsewhere.mp4"
        outside.write_bytes(b"x")
        self.job(filename=str(outside))

        response = host.trash_download("a" * 32)

        self.assertFalse(response["ok"])
        self.assertTrue(outside.exists())
        self.assertIsNotNone(host.get_download_job("a" * 32))

    def test_a_download_in_flight_is_not_trashed(self) -> None:
        video = self.video("hard j/alice/part.mp4")
        self.job(filename=str(video), status="queued")

        self.assertFalse(host.trash_download("a" * 32)["ok"])
        self.assertTrue(video.exists())

    def test_library_messages_cannot_reach_outside_the_library(self) -> None:
        with self.assertRaises(ValueError):
            host.handle_library_message("play_library_file", {"path": "../../etc/passwd"})
        with self.assertRaises(ValueError):
            host.handle_library_message("get_library_report", {"kind": "everything"})
        self.assertIsNone(host.handle_library_message("download", {}))

    def test_thumbnail_keys_cannot_name_other_files(self) -> None:
        self.assertEqual(host.library_thumbnails(["../../x", "a" * 39, 5])["thumbs"], {})
