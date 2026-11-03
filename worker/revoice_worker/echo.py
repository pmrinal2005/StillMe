"""B6 — Echo gate: the worker never treats its own synthesized output as partner input (rule 5).

Previously partner audio was only silenced while speaking in *tabletop* mode. In partner-link mode
the synthetic voice also played on the owner's device next to the partner's phone, so the partner's
microphone captured it and it was transcribed as partner speech.

Now, in EVERY mode, partner audio sent to STT is replaced by silence while:
  1. the worker is synthesizing/playing approved speech, plus a mode-aware tail (network playout on
     a remote device lags the local capture, so partner-link/remote use a longer tail); or
  2. the owner's device asked for a gate because it is playing approved speech itself
     (B5 HTTP-TTS fallback). That gate is bounded by a TTL so a lost "off" can never mute the
     partner indefinitely.

Silence (not dropping frames) keeps the STT stream's timing intact. Pure logic; unit-tested.
"""
from __future__ import annotations

from dataclasses import dataclass

ECHO_TAIL_S = {"tabletop": 0.35, "partner-link": 0.8, "remote": 0.8}
OWNER_GATE_MAX_S = 120.0
OWNER_GATE_DEFAULT_S = 60.0


def echo_tail_s(mode: str) -> float:
    return ECHO_TAIL_S.get(mode, 0.8)


@dataclass
class EchoGate:
    mode: str = "tabletop"
    speaking: bool = False
    tail_until: float = 0.0
    owner_gate_until: float = 0.0

    def start_speaking(self) -> None:
        self.speaking = True

    def stop_speaking(self, now: float) -> None:
        """Our speech finished, failed or was stopped: keep gating for the echo tail."""
        self.speaking = False
        self.tail_until = max(self.tail_until, now + echo_tail_s(self.mode))

    def owner_gate(self, on: bool, now: float, ttl_ms: int | None = None) -> None:
        if on:
            ttl = OWNER_GATE_DEFAULT_S if ttl_ms is None else max(0.0, min(ttl_ms / 1000.0, OWNER_GATE_MAX_S))
            self.owner_gate_until = now + ttl
        else:
            # Owner playback ended: release after the same echo tail as our own speech.
            self.owner_gate_until = 0.0
            self.tail_until = max(self.tail_until, now + echo_tail_s(self.mode))

    def should_silence(self, now: float, *, gate_phase_speaking: bool = False) -> bool:
        return self.speaking or gate_phase_speaking or now < self.tail_until or now < self.owner_gate_until
