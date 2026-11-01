"""Narrow turn adapter: AssemblyAI streaming events -> ReVOICE transcript messages.

AssemblyAI re-transcribes the whole turn on every Turn message, so each update SUPERSEDES the
previous one. We REPLACE the turn text and bump a revision; we never append. Partials give
responsiveness; the end_of_turn (FINAL) transcript is authoritative.

Why an adapter at all: the LiveKit plugin surfaces INTERIM / PREFLIGHT / FINAL SpeechEvents but
not AssemblyAI's `turn_order`. We derive a stable turn id locally (a FINAL closes the turn; the
next non-empty partial opens a new one). This is the only metadata we need, so we do NOT open a
second paid transcription stream just to read extra fields.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

EventKind = Literal["start", "interim", "preflight", "final"]


@dataclass
class TurnMessage:
    """Mirrors TranscriptMessage in src/lib/contracts.ts."""

    generation: int
    turnId: int
    revision: int
    text: str
    endOfTurn: bool
    speechStarted: bool = False

    def to_dict(self) -> dict:
        d = {
            "type": "turn",
            "generation": self.generation,
            "turnId": self.turnId,
            "revision": self.revision,
            "text": self.text[:4000],
            "endOfTurn": self.endOfTurn,
        }
        if self.speechStarted:
            d["speechStarted"] = True
        return d


@dataclass
class TurnAdapter:
    generation: int = 0
    turn_id: int = 0
    revision: int = -1
    text: str = ""
    closed: bool = True  # no open turn yet
    _emitted_start_for: int = field(default=-1)

    def reset(self, generation: int) -> None:
        """New room generation (reconnect / resumed listening): ids restart, old candidates go stale."""
        self.generation = generation
        self.turn_id = 0
        self.revision = -1
        self.text = ""
        self.closed = True
        self._emitted_start_for = -1

    def _open_if_needed(self) -> None:
        if self.closed:
            if self.revision >= 0:  # a previous turn existed
                self.turn_id += 1
            self.revision = -1
            self.text = ""
            self.closed = False

    def on_event(self, kind: EventKind, text: str = "") -> TurnMessage | None:
        """Feed one STT event; returns a message to publish, or None if nothing changed."""
        text = (text or "").strip()
        if kind == "start":
            self._open_if_needed()
            if self._emitted_start_for == self.turn_id:
                return None
            self._emitted_start_for = self.turn_id
            return TurnMessage(self.generation, self.turn_id, max(self.revision, 0), self.text, False, speechStarted=True)

        if kind in ("interim", "preflight"):
            if not text:
                return None
            self._open_if_needed()
            if text == self.text:
                return None  # identical revision -> no churn, no new drafting
            self.revision += 1
            self.text = text
            return TurnMessage(self.generation, self.turn_id, self.revision, text, False)

        if kind == "final":
            if not text and self.closed:
                return None
            self._open_if_needed()
            self.revision += 1
            self.text = text or self.text
            self.closed = True
            msg = TurnMessage(self.generation, self.turn_id, self.revision, self.text, True)
            return msg
        return None
