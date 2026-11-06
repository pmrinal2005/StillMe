"""F: choose the streaming-STT model + options for a profile (pure logic; main.py passes the result to assemblyai.STT).

flagship  Universal-3.6 Pro Realtime. Supports language steering, key terms and a context prompt.
economy   Universal-Streaming English (only English wanted) or Universal-Streaming Multilingual (en/es/de/fr/pt/it).
          It does NOT take the Pro-only options (`prompt`, `keyterms_prompt` is accepted by the streaming API but language
          steering is not), so those are dropped here instead of failing at socket connect.
A profile that cannot serve the requested languages (e.g. Hindi on economy) falls back to flagship and says so.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .config import (
    ECONOMY_MULTI_LANGUAGES,
    STT_MODEL,
    STT_MODEL_ECONOMY_EN,
    STT_MODEL_ECONOMY_MULTI,
    STT_PROFILES,
    STT_VAD_THRESHOLD,
)


@dataclass(frozen=True)
class SttChoice:
    profile: str  # the profile actually used (may differ from the requested one)
    model: str
    language_codes: list[str] = field(default_factory=list)
    use_prompt: bool = False  # context prompt (flagship only)
    use_keyterms: bool = True
    vad_threshold: float = STT_VAD_THRESHOLD
    downgraded_from: str | None = None  # set when `economy` was requested but could not be honoured
    reason: str | None = None


def _bare(code: str) -> str:
    return code.split("-")[0].split("_")[0].lower()


def choose_stt(requested: str | None, input_languages: list[str]) -> SttChoice:
    profile = requested if requested in STT_PROFILES else "flagship"
    langs = [_bare(c) for c in input_languages if c]
    if profile == "flagship":
        return SttChoice(profile="flagship", model=STT_MODEL, language_codes=list(dict.fromkeys(langs))[:4], use_prompt=True)
    # economy
    wanted = list(dict.fromkeys(langs))
    if not wanted or wanted == ["en"]:
        return SttChoice(profile="economy", model=STT_MODEL_ECONOMY_EN)
    if all(c in ECONOMY_MULTI_LANGUAGES for c in wanted):
        return SttChoice(profile="economy", model=STT_MODEL_ECONOMY_MULTI)
    unsupported = [c for c in wanted if c not in ECONOMY_MULTI_LANGUAGES]
    return SttChoice(
        profile="flagship",
        model=STT_MODEL,
        language_codes=wanted[:4],
        use_prompt=True,
        downgraded_from="economy",
        reason="economy_unsupported_language:" + ",".join(unsupported[:3]),
    )
