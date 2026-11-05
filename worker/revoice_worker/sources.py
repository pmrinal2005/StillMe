"""C #22/#23 — transcription SOURCE SELECTOR (pure logic; main.py does the I/O).

Exactly one authorized audio track is transcribed at a time (never two paid streams on one conversation), but
WHICH one must be a deliberate, re-evaluated decision — not "whoever subscribed first, forever":

  * priority takeover : a bound phone caller (3) outranks a partner browser (2), which outranks the owner's own
                        tabletop microphone (1). A higher-priority source takes over IMMEDIATELY.
  * stale supersede   : among equals the incumbent keeps the stream until it is *stale* — muted, or silent for
                        `stale_after_s` while a challenger has spoken more recently. A silent newcomer never steals.
  * rescan            : when the active source leaves, unpublishes or unsubscribes, the best remaining authorized
                        source is selected (previously the other partner was ignored forever → silence).
  * phone takes over  : a bound SIP participant wins over everything else for as long as it is connected; when the
                        call ends the selector falls back to the next best source.

Authorization (who MAY be transcribed) stays in tracks.authorize_track; this module only ranks authorized sources.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# authorize_track() reason -> priority
PRIORITY: dict[str, int] = {"phone_bound": 3, "partner": 2, "owner_tabletop": 1}
STALE_AFTER_S = 20.0


def priority_for(reason: str) -> int:
    return PRIORITY.get(reason, 0)


@dataclass
class Source:
    identity: str
    priority: int
    since: float
    last_voice: float = float("-inf")
    muted: bool = False


@dataclass
class Switch:
    old: str | None
    new: str | None
    reason: str


@dataclass
class SourceSelector:
    stale_after_s: float = STALE_AFTER_S
    sources: dict[str, Source] = field(default_factory=dict)
    active: str | None = None

    # ---- inputs
    def add(self, identity: str, priority: int, now: float) -> None:
        cur = self.sources.get(identity)
        if cur is None:
            self.sources[identity] = Source(identity, priority, now)
        else:
            cur.priority = priority  # e.g. a SIP participant that has just been bound

    def remove(self, identity: str) -> bool:
        existed = self.sources.pop(identity, None) is not None
        return existed

    def voice(self, identity: str, now: float) -> None:
        s = self.sources.get(identity)
        if s:
            s.last_voice = now

    def set_muted(self, identity: str, muted: bool) -> None:
        s = self.sources.get(identity)
        if s:
            s.muted = muted

    # ---- decision
    def _stale(self, s: Source, challenger: Source, now: float) -> bool:
        if s.muted and not challenger.muted:
            return True
        silent_for = now - max(s.last_voice, s.since)
        return silent_for >= self.stale_after_s and challenger.last_voice > s.last_voice

    def best(self, now: float) -> tuple[str | None, str]:
        """Pick the source that SHOULD be transcribed now, and why."""
        pool = [s for s in self.sources.values() if not s.muted] or list(self.sources.values())
        if not pool:
            return None, "no_source"
        top = max(s.priority for s in pool)
        tier = [s for s in pool if s.priority == top]
        inc = self.sources.get(self.active) if self.active else None
        if inc is not None and inc not in pool:
            inc = None  # muted incumbent while others are live -> treated as gone for this decision
        if inc is not None and inc.priority == top:
            challengers = [s for s in tier if s.identity != inc.identity]
            if not challengers:
                return inc.identity, "incumbent"
            champ = max(challengers, key=lambda s: (s.last_voice, -s.since))
            if self._stale(inc, champ, now):
                return champ.identity, "stale_supersede"
            return inc.identity, "incumbent"
        # No incumbent (first pick / it left / it was muted) or the incumbent is outranked: pick the best of the top tier —
        # most recent voice first, then the longest-present source (stable, deterministic).
        champ = max(tier, key=lambda s: (s.last_voice, -s.since))
        if inc is not None:
            return champ.identity, "priority_takeover"
        return champ.identity, "rescan" if self.active is not None or len(self.sources) > 1 else "initial"

    def reselect(self, now: float) -> Switch | None:
        """Re-evaluate. Returns a Switch if the active source changed (including becoming None)."""
        new, why = self.best(now)
        if new == self.active:
            return None
        old, self.active = self.active, new
        return Switch(old, new, why)

    def drop_active(self) -> None:
        """The active source's track is gone/unsubscribed from underneath us (not a selection decision)."""
        self.active = None
