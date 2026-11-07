"""Worker configuration. Mirrors src/lib/features.ts and src/lib/budget.ts.

Everything that could spend money or act without the user is OFF and not configurable here.
"""
from __future__ import annotations

import hashlib
import hmac
import os
from dataclasses import dataclass

STT_MODEL = "universal-3-6-pro"  # selected explicitly (plugin defaults have changed between releases)
# F: streaming-STT profiles. `flagship` = Universal-3.6 Pro Realtime ($0.45/h, 32 languages, language steering / keyterms /
# prompt). `economy` = Universal-Streaming ($0.15/h): English-only or the 6-language multilingual model.
STT_PROFILES = ("flagship", "economy")
STT_MODEL_ECONOMY_EN = "universal-streaming-english"
STT_MODEL_ECONOMY_MULTI = "universal-streaming-multilingual"
# Languages the economy MULTILINGUAL model covers (ISO 639-1). Anything else needs the flagship profile.
ECONOMY_MULTI_LANGUAGES = ("en", "es", "de", "fr", "pt", "it")
# F: voice-activity threshold handed to the provider (0..1). Higher = less sensitive to room noise / the owner's own speaker.
# Kept moderate: too high clips quiet speakers, which matters more for this audience than a few false starts.
STT_VAD_THRESHOLD = 0.5
TTS_MODEL = "assemblyai-tts-1"
OUTPUT_LANGUAGES = ("english", "spanish", "german", "italian", "portuguese", "french")
MAX_SPOKEN_CHARS = 1000

# Hard invariants (tests/test_config.py). There is intentionally no env switch for these.
LLM_ENABLED = False  # no LLM inside the worker; Groq suggestions are drafted by the web app only
LLM_GATEWAY_ENABLED = False
AUTONOMOUS_REPLIES = False
SPECULATIVE_TTS = False
PREEMPTIVE_GENERATION = False
RECORDING_ENABLED = False
RAW_CONTENT_LOGGING = False
OUTBOUND_PSTN = False
EMERGENCY_CALLING = False

# Add-ons stay disabled until pricing/compatibility are verified for the actual account.
ADDONS = {
    "streaming_diarization": False,
    "medical_mode": False,
    "guardrails": False,
    "speech_understanding": False,
    "tts_word_boundaries": False,
    "enhanced_noise_cancellation": False,
}

# Application limits (intersect with web-app ledgers and Supabase reservations).
SESSION_MAX_MINUTES = 20
SESSION_TTS_CHAR_CAP = 5000
# Owner-gone grace by conversation mode. MUST equal OWNER_GONE_GRACE_S in src/lib/session-policy.ts.
# tabletop: the owner's device IS the microphone, so 30 s is plenty. partner-link / remote: the partner keeps talking while the
# owner's phone is locked / switches network / reloads, so the worker waits 2 minutes before it ends the room.
OWNER_GONE_GRACE_BY_MODE = {"tabletop": 30, "partner-link": 120, "remote": 120}
OWNER_GONE_GRACE_S = OWNER_GONE_GRACE_BY_MODE["tabletop"]  # legacy name (tabletop value)


def owner_gone_grace_s(mode: str | None) -> int:
    return OWNER_GONE_GRACE_BY_MODE.get(mode or "tabletop", OWNER_GONE_GRACE_BY_MODE["tabletop"])


IDLE_NO_AUDIO_S = 5 * 60
PHONE_MONTHLY_MINUTES_CAP = 40
PHONE_MAX_CALL_MINUTES = 15
PHONE_PAIR_TIMEOUT_S = 60
# D #45: how long a freshly dispatched call room waits for the SIP caller to appear before it is torn down.
CALL_CONNECT_TIMEOUT_S = 30


def _opt(name: str) -> str | None:
    v = os.environ.get(name, "").strip()
    return v or None


# B2: MUST match src/lib/server/env.ts (APPROVAL_SECRET_LABEL / APPROVAL_SECRET_SOURCES / deriveApprovalSecret).
APPROVAL_SECRET_LABEL = "revoice/approval-secret/v1"
APPROVAL_SECRET_SOURCES = ("LIVEKIT_API_SECRET", "ASSEMBLYAI_API_KEY")


def derive_approval_secret(provider_secret: str) -> str:
    return hmac.new(provider_secret.encode("utf-8"), APPROVAL_SECRET_LABEL.encode("utf-8"), hashlib.sha256).hexdigest()


def resolve_approval_secret() -> tuple[str | None, str]:
    """Same resolution order as the web app, so web and worker always agree on the HMAC secret.

    1. REVOICE_APPROVAL_SECRET  2. derived from LIVEKIT_API_SECRET  3. derived from ASSEMBLYAI_API_KEY.
    There is deliberately NO random fallback (a per-process secret could never verify web approvals).
    """
    explicit = _opt("REVOICE_APPROVAL_SECRET")
    if explicit:
        return explicit, "explicit"
    for name in APPROVAL_SECRET_SOURCES:
        v = _opt(name)
        if v:
            return derive_approval_secret(v), f"derived:{name}"
    return None, "missing"


@dataclass(frozen=True)
class Env:
    assembly_key: str | None
    region: str
    approval_secret: str | None
    agent_name: str
    app_url: str | None
    supabase_url: str | None
    supabase_service_key: str | None
    phone_inbound_enabled: bool

    @property
    def stt_base_url(self) -> str:
        return "wss://streaming.eu.assemblyai.com" if self.region == "eu" else "wss://streaming.assemblyai.com"

    @property
    def tts_base_url(self) -> str:
        return "wss://tts.eu.assemblyai.com" if self.region == "eu" else "wss://tts.us.assemblyai.com"


def load_env() -> Env:
    return Env(
        assembly_key=_opt("ASSEMBLYAI_API_KEY"),
        region="eu" if _opt("ASSEMBLYAI_REGION") == "eu" else "us",
        approval_secret=resolve_approval_secret()[0],
        agent_name=_opt("LIVEKIT_AGENT_NAME") or "revoice-worker",
        app_url=(_opt("REVOICE_APP_URL") or "").rstrip("/") or None,
        supabase_url=_opt("SUPABASE_URL") or _opt("NEXT_PUBLIC_SUPABASE_URL"),
        supabase_service_key=_opt("SUPABASE_SERVICE_ROLE_KEY"),
        phone_inbound_enabled=_opt("REVOICE_PHONE_INBOUND_ENABLED") == "true",
    )


def assert_safe_defaults() -> None:
    if LLM_ENABLED or LLM_GATEWAY_ENABLED:
        raise RuntimeError("The worker must not run an LLM")
    if AUTONOMOUS_REPLIES or SPECULATIVE_TTS or PREEMPTIVE_GENERATION:
        raise RuntimeError("Autonomous replies / speculative TTS must remain disabled")
    if RECORDING_ENABLED or RAW_CONTENT_LOGGING:
        raise RuntimeError("Recording and raw-content logging must remain disabled")
    if OUTBOUND_PSTN or EMERGENCY_CALLING:
        raise RuntimeError("Outbound PSTN and emergency calling must remain disabled")
    if any(ADDONS.values()):
        raise RuntimeError("Add-ons must remain disabled until verified")
