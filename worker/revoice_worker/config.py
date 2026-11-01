"""Worker configuration. Mirrors src/lib/features.ts and src/lib/budget.ts.

Everything that could spend money or act without the user is OFF and not configurable here.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

STT_MODEL = "universal-3-6-pro"  # selected explicitly (plugin defaults have changed between releases)
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
OWNER_GONE_GRACE_S = 30
IDLE_NO_AUDIO_S = 5 * 60
PHONE_MONTHLY_MINUTES_CAP = 40
PHONE_MAX_CALL_MINUTES = 15
PHONE_PAIR_TIMEOUT_S = 60


def _opt(name: str) -> str | None:
    v = os.environ.get(name, "").strip()
    return v or None


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
        approval_secret=_opt("REVOICE_APPROVAL_SECRET"),
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
