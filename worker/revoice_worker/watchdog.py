"""Session watchdogs. Streaming STT is billed by connected duration, so every path that ends a
genuine conversation must close the stream: max session length, owner gone, idle (no partner audio),
budget exhaustion, explicit end, and per-call phone caps. Pure logic; the worker polls `check()`.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .config import IDLE_NO_AUDIO_S, OWNER_GONE_GRACE_S, SESSION_MAX_MINUTES

EndReason = Literal["timeout", "room_exit", "idle", "budget", "user", "phone_cap"]


@dataclass
class Watchdog:
    started_at: float
    max_minutes: int = SESSION_MAX_MINUTES
    owner_gone_since: float | None = None
    last_partner_audio: float | None = None
    listening: bool = True
    budget_exhausted: bool = False
    ended: EndReason | None = None
    phone_call_started: float | None = None
    phone_call_max_s: float | None = None

    def __post_init__(self) -> None:
        self.max_minutes = max(1, min(self.max_minutes, SESSION_MAX_MINUTES))
        if self.last_partner_audio is None:
            self.last_partner_audio = self.started_at

    def owner_left(self, now: float) -> None:
        self.owner_gone_since = self.owner_gone_since or now

    def owner_returned(self) -> None:
        self.owner_gone_since = None

    def partner_audio(self, now: float) -> None:
        self.last_partner_audio = now

    def set_listening(self, enabled: bool, now: float) -> None:
        self.listening = enabled
        if enabled:
            self.last_partner_audio = now  # idle timer restarts after an explicit resume

    def phone_bound(self, now: float, max_minutes: float) -> None:
        self.phone_call_started = now
        self.phone_call_max_s = max(0.0, max_minutes * 60)

    def phone_ended(self) -> None:
        self.phone_call_started = None
        self.phone_call_max_s = None

    def phone_minutes_used(self, now: float) -> float:
        return 0.0 if self.phone_call_started is None else (now - self.phone_call_started) / 60

    def check(self, now: float) -> EndReason | Literal["phone_cap", "idle_pause"] | None:
        """Returns a session-ending reason, 'phone_cap' (hang up the call only), 'idle_pause' (close STT only), or None."""
        if self.ended:
            return self.ended
        if self.budget_exhausted:
            return "budget"
        if now - self.started_at >= self.max_minutes * 60:
            return "timeout"
        if self.owner_gone_since is not None and now - self.owner_gone_since >= OWNER_GONE_GRACE_S:
            return "room_exit"
        if self.phone_call_started is not None and self.phone_call_max_s is not None and now - self.phone_call_started >= self.phone_call_max_s:
            return "phone_cap"
        if self.listening and self.last_partner_audio is not None and now - self.last_partner_audio >= IDLE_NO_AUDIO_S:
            return "idle_pause"
        return None
