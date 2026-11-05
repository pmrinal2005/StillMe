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

from .approval import Approval, ApprovalRejected, Expectation, ReplayStore, signature_ok, verify
from .config import SESSION_TTS_CHAR_CAP

Phase = Literal["idle", "speaking", "paused_for_budget"]

# C #21: a Stop can overtake the Speak it cancels (concurrent publishData calls are not ordered on the owner's
# device, and the worker admits asynchronously). Cancelled attempt ids are remembered so a LATE speak for that
# attempt is refused instead of speaking something the user already stopped.
TOMBSTONE_TTL_S = 300.0
TOMBSTONE_MAX = 200


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
    tombstones: dict[str, float] = field(default_factory=dict)  # attempt_id -> monotonic time of the pre-cancel
    history: list[tuple[str, str]] = field(default_factory=list)  # (attempt_id, outcome) content-free

    async def admit(self, approval: Approval, text: str, now_ms: int | None = None) -> Attempt:
        """Verify + reserve. Raises ApprovalRejected with a reason on refusal."""
        # C #21: checked FIRST — a pre-cancelled attempt must be refused even while another utterance is busy/paused.
        # The signature is verified before reporting `cancelled`, so a forged approval id is never trusted.
        if self.is_tombstoned(approval.playbackAttemptId):
            if not signature_ok(self.secret, approval):
                raise ApprovalRejected("bad_signature")
            raise ApprovalRejected("cancelled")
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

    def pre_cancel(self, attempt_id: str, now: float | None = None) -> None:
        """Tombstone an attempt that may not have been admitted yet (bounded in size and age)."""
        t = time.monotonic() if now is None else now
        self.tombstones[attempt_id] = t
        for k, at in list(self.tombstones.items()):
            if t - at > TOMBSTONE_TTL_S:
                del self.tombstones[k]
        while len(self.tombstones) > TOMBSTONE_MAX:
            self.tombstones.pop(next(iter(self.tombstones)))

    def is_tombstoned(self, attempt_id: str, now: float | None = None) -> bool:
        at = self.tombstones.get(attempt_id)
        if at is None:
            return False
        t = time.monotonic() if now is None else now
        if t - at > TOMBSTONE_TTL_S:
            del self.tombstones[attempt_id]
            return False
        return True

    def stop(self, attempt_id: str | None = None) -> Attempt | None:
        """Cancel the CURRENT attempt (if `attempt_id` is None or matches it). A Stop for a DIFFERENT attempt never
        touches the running one; it tombstones that attempt in case its Speak has not been admitted yet (C #21)."""
        cur = self.current
        if attempt_id and (cur is None or attempt_id != cur.attempt_id):
            self.pre_cancel(attempt_id)
            return None
        if cur is None:
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
