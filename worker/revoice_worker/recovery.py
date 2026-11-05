"""C #25 — STT error recovery: bounded exponential backoff (pure logic).

Before: any exception in the transcription consumer published one `error` status and left the worker deaf until the
owner happened to toggle listening. Now the worker retries with a bounded, jittered backoff, tells the owner what it
is doing (`reconnecting` statuses), and only after the attempts are exhausted gives up with an explicit, recoverable
`paused`/`stt_failed` state (the owner's Resume restarts it with a fresh budget of attempts).

Bounded on purpose: STT is billed by connected time and a flapping provider must not be hammered forever.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Callable

MAX_ATTEMPTS = 4
BASE_S = 1.0
CAP_S = 8.0
# A stream that stayed healthy this long counts as recovered even before the next transcript arrives.
HEALTHY_AFTER_S = 15.0


@dataclass
class Backoff:
    max_attempts: int = MAX_ATTEMPTS
    base_s: float = BASE_S
    cap_s: float = CAP_S
    jitter: float = 0.2
    rng: Callable[[], float] = field(default=random.random)
    attempts: int = 0

    def next_delay(self) -> float | None:
        """Delay before the next reconnect attempt, or None once the bound is reached."""
        if self.attempts >= self.max_attempts:
            return None
        d = min(self.cap_s, self.base_s * (2 ** self.attempts))
        self.attempts += 1
        return d * (1.0 + self.jitter * (self.rng() * 2 - 1))

    def healthy(self) -> None:
        """A transcript arrived (or the stream stayed up): forget past failures."""
        self.attempts = 0

    @property
    def exhausted(self) -> bool:
        return self.attempts >= self.max_attempts
