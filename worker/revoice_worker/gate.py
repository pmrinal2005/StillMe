"""Speech gate: the ONLY path from text to TTS inside the worker.

Invariants
 - Text reaches TTS only after `verify()` accepted a signed approval for that exact text.
   (No draft text ever enters TTS; we never "send and withhold Flush".)
 - One utterance at a time; a new speak while speaking is rejected (user must Stop first).
 - Stop cancels synthesis, clears queued device audio, and marks frames from that attempt as late.
 - A failure after audio started -> `uncertain`; it is NEVER replayed automatically.
 - Per-session TTS character cap (intersects with the web app ledgers / Supabase reservations).
 - Paused-for-budget refuses all new speech.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Literal

from .approval import Approval, ApprovalRejected, Expectation, ReplayStore, verify
from .config import SESSION_TTS_CHAR_CAP

Phase = Literal["idle", "speaking", "paused_for_budget"]


@dataclass
class Attempt:
    attempt_id: str
    approval_id: str
    text: str
    voice_id: str
    language: str
    chars: int
    started_at: float
    audio_started: bool = False
    cancelled: bool = False


@dataclass
class SpeechGate:
    secret: str
    expect: Expectation
    replay: ReplayStore
    char_cap: int = SESSION_TTS_CHAR_CAP
    chars_used: int = 0
    phase: Phase = "idle"
    current: Attempt | None = None
    cancelled_attempts: set[str] = field(default_factory=set)
    history: list[tuple[str, str]] = field(default_factory=list)  # (attempt_id, outcome) content-free

    async def admit(self, approval: Approval, text: str, now_ms: int | None = None) -> Attempt:
        """Verify + reserve. Raises ApprovalRejected with a reason on refusal."""
        if self.phase == "paused_for_budget":
            raise ApprovalRejected("paused_for_budget")
        if self.current is not None and not self.current.cancelled:
            raise ApprovalRejected("busy")
        if approval.playbackAttemptId in self.cancelled_attempts:
            raise ApprovalRejected("replayed")
        a = await verify(secret=self.secret, approval=approval, text=text, expect=self.expect, replay=self.replay, now_ms=now_ms)
        if self.chars_used + a.chars > self.char_cap:
            self.phase = "paused_for_budget"
            raise ApprovalRejected("session_char_cap")
        self.chars_used += a.chars
        self.current = Attempt(a.playbackAttemptId, a.approvalId, text, a.voiceId, a.outputLanguage, a.chars, time.monotonic())
        self.phase = "speaking"
        return self.current

    def accept_frame(self, attempt_id: str) -> bool:
        """Late frames from a cancelled/finished attempt are dropped."""
        cur = self.current
        if cur is None or cur.attempt_id != attempt_id or cur.cancelled:
            return False
        cur.audio_started = True
        return True

    def stop(self, attempt_id: str | None = None) -> Attempt | None:
        cur = self.current
        if cur is None or (attempt_id and attempt_id != cur.attempt_id):
            return None
        cur.cancelled = True
        self.cancelled_attempts.add(cur.attempt_id)
        self._finish("cancelled")
        return cur

    def finished(self, attempt_id: str) -> bool:
        cur = self.current
        if cur is None or cur.attempt_id != attempt_id or cur.cancelled:
            return False
        self._finish("done")
        return True

    def failed(self, attempt_id: str) -> Literal["uncertain", "error"] | None:
        cur = self.current
        if cur is None or cur.attempt_id != attempt_id:
            return None
        outcome: Literal["uncertain", "error"] = "uncertain" if cur.audio_started else "error"
        if not cur.audio_started:
            # nothing audible -> refund the session characters (provider does not bill pre-audio errors)
            self.chars_used = max(0, self.chars_used - cur.chars)
        self.cancelled_attempts.add(cur.attempt_id)  # same approval can never be replayed by the worker
        self._finish(outcome)
        return outcome

    def pause_for_budget(self) -> None:
        self.phase = "paused_for_budget"

    def bump_generation(self, generation: int) -> None:
        """Reconnect/new generation: outstanding approvals for the old generation become invalid."""
        self.expect = Expectation(self.expect.owner, self.expect.conversation_id, self.expect.room_name, generation)

    def _finish(self, outcome: str) -> None:
        if self.current:
            self.history.append((self.current.attempt_id, outcome))
            self.history = self.history[-50:]
        self.current = None
        if self.phase == "speaking":
            self.phase = "idle"
