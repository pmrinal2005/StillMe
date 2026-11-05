"""A1 / A10 usage metering (content-free, pure logic — main.py does the I/O).

Streaming STT is billed by the time the socket is CONNECTED, not by wall-clock session length, so the worker
measures exactly that: every open/close of the AssemblyAI stream is an interval. The web app reserved the
whole session up front (ref = room); the worker's final report settles it authoritatively, and periodic
heartbeats let the durable sweep commit a sensible figure if the final report never arrives.

Agent minutes (LiveKit) are the job's wall-clock lifetime, reported per room and capped monthly by the web app.

Worker speech (A1): the web app reserved the approved characters at approval time (ref = tts:<approvalId>).
The worker reports what it actually sent for synthesis: 0 if rejected/failed before any audio (released),
otherwise the approved length (AssemblyAI bills the full request once synthesis starts).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

HEARTBEAT_S = 60.0
# Must match src/lib/spend-refs.ts (workerTtsRef) — the web app derives the ref from the approval id.
TTS_REF_PREFIX = "tts:"


def tts_ref(approval_id: str) -> str:
    return f"{TTS_REF_PREFIX}{approval_id}"


@dataclass
class SttMeter:
    """Accumulates connected STT time across open/close cycles (pause/resume, idle, track changes)."""

    total_s: float = 0.0
    opened_at: float | None = None
    _last_beat: float | None = None

    def opened(self, now: float) -> None:
        if self.opened_at is None:
            self.opened_at = now

    def closed(self, now: float) -> None:
        if self.opened_at is not None:
            self.total_s += max(0.0, now - self.opened_at)
            self.opened_at = None

    def connected_s(self, now: float) -> float:
        live = max(0.0, now - self.opened_at) if self.opened_at is not None else 0.0
        return self.total_s + live

    def minutes(self, now: float) -> float:
        return round(self.connected_s(now) / 60.0, 4)

    def billed_minutes(self, now: float) -> int:
        """Whole minutes to commit (rounded up; 0 if the stream never connected)."""
        s = self.connected_s(now)
        return 0 if s <= 0 else math.ceil(s / 60.0 - 1e-9)

    def heartbeat_due(self, now: float) -> bool:
        if self._last_beat is None or now - self._last_beat >= HEARTBEAT_S:
            self._last_beat = now
            return True
        return False


@dataclass
class AgentMeter:
    started_at: float

    def minutes(self, now: float) -> float:
        return round(max(0.0, now - self.started_at) / 60.0, 4)


@dataclass
class TtsLedger:
    """Exactly one usage report per approval (idempotent on our side; the web app is idempotent too)."""

    reported: set[str] = field(default_factory=set)

    def report(self, approval_id: str, chars: int) -> dict | None:
        if not approval_id or approval_id in self.reported:
            return None
        self.reported.add(approval_id)
        return {"kind": "tts", "approvalId": approval_id, "chars": max(0, int(chars))}


def stt_report(room: str, meter: SttMeter, now: float, final: bool) -> dict:
    return {"kind": "stt", "room": room, "minutes": meter.minutes(now), "final": final}


def agent_report(room: str, owner: str, meter: AgentMeter, now: float) -> dict:
    return {"kind": "agent", "room": room, "owner": owner[:96], "minutes": meter.minutes(now)}
