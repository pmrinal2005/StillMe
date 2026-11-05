"""C #21 tombstones, #24 wake-on-voice, #25 backoff — pure logic."""
from __future__ import annotations

import time

import pytest

from revoice_worker.approval import ApprovalRejected, Expectation, MemoryReplayStore
from revoice_worker.gate import TOMBSTONE_MAX, TOMBSTONE_TTL_S, SpeechGate
from revoice_worker.recovery import Backoff
from revoice_worker.turns import TurnAdapter
from revoice_worker.wake import PreRoll, WakeDetector, frame_rms
from revoice_worker.watchdog import Watchdog
from tests.test_worker import EXP, OWNER, SECRET, make_approval


def gate() -> SpeechGate:
    return SpeechGate(secret=SECRET, expect=EXP, replay=MemoryReplayStore())


# ---------------------------------------------------------------- #21 tombstones
async def test_stop_before_speak_is_refused_as_cancelled():
    g = gate()
    a = make_approval("Hello")
    assert g.stop(a.playbackAttemptId) is None  # nothing running: tombstone only
    with pytest.raises(ApprovalRejected) as e:
        await g.admit(a, "Hello")
    assert e.value.reason == "cancelled"
    assert g.current is None and g.chars_used == 0


async def test_tombstone_checked_even_when_another_utterance_is_busy():
    g = gate()
    a1 = make_approval("One", approvalId="1" * 32, playbackAttemptId="1" * 32)
    await g.admit(a1, "One")
    a2 = make_approval("Two", approvalId="2" * 32, playbackAttemptId="2" * 32)
    assert g.stop("2" * 32) is None  # Stop for the OTHER attempt must not touch the running one
    assert g.current and not g.current.cancelled
    with pytest.raises(ApprovalRejected) as e:
        await g.admit(a2, "Two")
    assert e.value.reason == "cancelled"  # not "busy"


async def test_forged_approval_for_tombstoned_id_is_bad_signature_not_cancelled():
    g = gate()
    a = make_approval("Hello")
    g.stop(a.playbackAttemptId)
    forged = a.model_copy(update={"sig": "0" * 64})
    with pytest.raises(ApprovalRejected) as e:
        await g.admit(forged, "Hello")
    assert e.value.reason == "bad_signature"


async def test_stop_without_id_cancels_current():
    g = gate()
    a = make_approval("Hello")
    await g.admit(a, "Hello")
    cur = g.stop(None)
    assert cur and cur.cancelled and g.phase == "idle"
    assert not g.accept_frame(a.playbackAttemptId)


async def test_matching_stop_cancels_running_attempt():
    g = gate()
    a = make_approval("Hello")
    await g.admit(a, "Hello")
    assert g.stop(a.playbackAttemptId) is not None
    assert g.history[-1][1] == "cancelled"


def test_tombstones_are_bounded_in_size_and_age():
    g = gate()
    for i in range(TOMBSTONE_MAX + 50):
        g.pre_cancel(f"id{i}", now=1000.0)
    assert len(g.tombstones) == TOMBSTONE_MAX
    assert g.is_tombstoned(f"id{TOMBSTONE_MAX + 49}", now=1001.0)
    assert not g.is_tombstoned(f"id{TOMBSTONE_MAX + 49}", now=1000.0 + TOMBSTONE_TTL_S + 1)
    g.pre_cancel("fresh", now=1000.0 + TOMBSTONE_TTL_S + 2)
    assert "id60" not in g.tombstones  # aged out on the next write


# ---------------------------------------------------------------- #24 wake
def test_frame_rms():
    import array

    assert frame_rms(b"") == 0.0
    loud = array.array("h", [1000, -1000] * 80).tobytes()
    assert round(frame_rms(loud)) == 1000
    assert frame_rms(array.array("h", [0] * 160).tobytes()) == 0.0


def test_wake_requires_sustained_voice_not_a_click():
    w = WakeDetector()
    assert not w.feed(5000, 0.00)  # a click...
    assert not w.feed(10, 0.01)
    assert not w.feed(5000, 0.50)  # ...then another much later: timer restarted
    t, fired = 1.0, False
    for i in range(40):
        fired = w.feed(5000, t + i * 0.01) or fired
    assert fired


def test_wake_tolerates_tiny_dips_inside_a_word():
    w = WakeDetector()
    fired = False
    for i in range(60):
        rms = 5000 if i % 7 else 100  # a dip every 70 ms (< gap)
        fired = w.feed(rms, i * 0.01) or fired
    assert fired


def test_wake_quiet_never_fires_and_reset_clears():
    w = WakeDetector()
    assert not any(w.feed(50, i * 0.01) for i in range(200))
    w.feed(5000, 0)
    w.reset()
    assert w._start is None


def test_preroll_is_bounded_and_drains():
    p = PreRoll(seconds=1.0)
    for i in range(300):
        p.add(i, i * 0.01)
    assert 95 <= len(p) <= 102
    frames = p.drain()
    assert frames[-1] == 299 and len(p) == 0 and p.drain() == []


def test_watchdog_idle_only_with_active_source_and_resume_semantics():
    w = Watchdog(started_at=0)
    from revoice_worker import config

    assert w.check(config.IDLE_NO_AUDIO_S + 5) is None  # nobody here yet
    w.set_source_active(True, 100)
    assert w.check(100 + config.IDLE_NO_AUDIO_S - 1) is None  # clock starts when the source appears
    assert w.check(100 + config.IDLE_NO_AUDIO_S) == "idle_pause"
    w.set_listening(False, 450, "idle")
    assert w.pause_reason == "idle" and w.check(500) is None
    w.set_listening(True, 600)
    assert w.pause_reason is None
    w.set_listening(False, 601, "user")
    assert w.pause_reason == "user"


# ---------------------------------------------------------------- #25 backoff
def test_backoff_is_exponential_capped_bounded_and_resettable():
    b = Backoff(rng=lambda: 0.5, base_s=1.0, cap_s=8.0, max_attempts=5)  # rng .5 -> zero jitter
    delays = [b.next_delay() for _ in range(5)]
    assert delays == [1.0, 2.0, 4.0, 8.0, 8.0]
    assert b.exhausted and b.next_delay() is None
    b.healthy()
    assert not b.exhausted and b.next_delay() == 1.0


def test_backoff_jitter_within_bounds():
    for r in (0.0, 1.0):
        b = Backoff(rng=lambda r=r: r)
        d = b.next_delay()
        assert 0.8 <= d <= 1.2


# ---------------------------------------------------------------- turn flush (source switch)
def test_turn_flush_closes_open_turn_and_next_speaker_starts_a_new_one():
    t = TurnAdapter()
    t.reset(0)
    t.on_event("interim", "hello there")
    m = t.flush()
    assert m and m.endOfTurn and m.text == "hello there" and m.turnId == 0
    assert t.flush() is None  # nothing open now
    n = t.on_event("interim", "other speaker")
    assert n and n.turnId == 1 and n.revision == 0


def test_flush_with_no_open_turn_is_none():
    t = TurnAdapter()
    t.reset(0)
    assert t.flush() is None
