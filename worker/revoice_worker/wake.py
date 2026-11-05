"""C #24 — wake-on-voice + short pre-roll (pure logic; main.py does the I/O).

After an IDLE pause the worker closes the billed STT socket. Previously nothing ever reopened it: the partner started
talking again and ReVOICE stayed deaf until the owner pressed Resume. Now the pump of the ACTIVE source keeps reading
frames locally (nothing is sent to AssemblyAI, nothing is billed) and a tiny energy detector decides when someone is
speaking again; the worker then reopens STT and replays a short pre-roll so the first words are not lost.

Privacy: the pre-roll lives in memory only, only while idle-paused, is at most PREROLL_S long and is dropped on resume,
user pause, source change and session end. A USER pause never auto-resumes. Our own synthesized voice never wakes us
(the caller passes `silenced` frames to `reset()` instead of `feed()`).
"""
from __future__ import annotations

from array import array
from collections import deque
from dataclasses import dataclass, field
from typing import Any

VOICE_RMS = 450.0  # int16 RMS above this counts as voice (the browser applies noise suppression before publishing)
WAKE_SUSTAIN_S = 0.30  # voice must persist this long (a click or door slam must not reopen a billed stream)
WAKE_GAP_S = 0.12  # natural dips inside a word do not restart the sustain timer
PREROLL_S = 1.0


def frame_rms(data: Any) -> float:
    """RMS of an int16 PCM buffer (memoryview / bytes / array). 0.0 for empty input."""
    try:
        import numpy as np

        a = np.frombuffer(data, dtype=np.int16)
        if a.size == 0:
            return 0.0
        return float(np.sqrt(np.mean(a.astype(np.float64) ** 2)))
    except ImportError:  # pragma: no cover — numpy ships with livekit, kept for completeness
        a2 = array("h")
        a2.frombytes(bytes(data))
        if not a2:
            return 0.0
        return (sum(x * x for x in a2) / len(a2)) ** 0.5


@dataclass
class WakeDetector:
    threshold: float = VOICE_RMS
    sustain_s: float = WAKE_SUSTAIN_S
    gap_s: float = WAKE_GAP_S
    _start: float | None = None
    _last: float | None = None

    def feed(self, rms: float, now: float) -> bool:
        """One frame's energy. True once voice has been sustained for `sustain_s`."""
        if rms < self.threshold:
            return False
        if self._start is None or self._last is None or now - self._last > self.gap_s:
            self._start = now
        self._last = now
        return now - self._start >= self.sustain_s

    def reset(self) -> None:
        self._start = None
        self._last = None


@dataclass
class PreRoll:
    seconds: float = PREROLL_S
    _frames: deque = field(default_factory=deque)

    def add(self, frame: Any, now: float) -> None:
        self._frames.append((now, frame))
        while self._frames and now - self._frames[0][0] > self.seconds:
            self._frames.popleft()

    def drain(self) -> list[Any]:
        out = [f for _, f in self._frames]
        self._frames.clear()
        return out

    def __len__(self) -> int:
        return len(self._frames)
