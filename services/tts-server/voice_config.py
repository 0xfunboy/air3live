"""Trusted, per-service voice profiles; never load a caller-supplied URL/file."""

PRESETS = {
    "en": frozenset({"alba", "cosette", "fantine", "eponine", "azelma", "marius", "javert", "jean"}),
    "it": frozenset({"alba", "giovanni"}),
}


def configured_voices(environ):
    result = {}
    for language, allowed in PRESETS.items():
        voice = environ.get("AIR3_TTS_VOICE_" + language.upper(), "alba")
        if voice not in allowed:
            raise ValueError("UNAPPROVED_TTS_VOICE_" + language.upper())
        result[language] = voice
    return result
