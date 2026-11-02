import unittest
from voice_config import configured_voices


class VoiceConfigurationTests(unittest.TestCase):
    def test_legacy_defaults_unchanged(self):
        self.assertEqual(configured_voices({}), {"en": "alba", "it": "alba"})

    def test_isolated_english_voice_does_not_change_italian(self):
        self.assertEqual(configured_voices({"AIR3_TTS_VOICE_EN": "cosette"}), {"en": "cosette", "it": "alba"})

    def test_no_remote_urls_paths_or_unknown_names(self):
        for value in ["https://example.invalid/voice.wav", "/tmp/voice.wav", "", "unknown", "alba\n"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                configured_voices({"AIR3_TTS_VOICE_EN": value})


if __name__ == "__main__":
    unittest.main()
