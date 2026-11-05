"""C #20-#25 — drive the REAL OwnerRoom with fakes (no LiveKit server, no paid provider)."""
from __future__ import annotations

import array
import asyncio
import json
import time
from types import SimpleNamespace as NS

import pytest
from livekit import rtc

from revoice_worker import main as M
from revoice_worker.approval import Expectation, MemoryReplayStore
from revoice_worker.gate import SpeechGate
from revoice_worker.recovery import Backoff
from revoice_worker.watchdog import Watchdog
from tests.test_worker import EXP, SECRET, make_approval

OWNER_ID = "owner-opaque"


class FakeLocal:
    identity = "agent-1"

    def __init__(self):
        self.sent: list[tuple[str, dict]] = []

    async def publish_data(self, payload, reliable=True, topic="", destination_identities=None):
        self.sent.append((topic, json.loads(payload)))


class FakeStream:
    """Stand-in for an STT RecognizeStream: yields scripted events, can fail, records pushed frames."""

    def __init__(self, script=None, fail: Exception | None = None):
        self.script = list(script or [])
        self.fail = fail
        self.frames: list = []
        self.closed = False
        self.ended = False
        self._block = asyncio.Event()

    def push_frame(self, f):
        self.frames.append(f)

    def end_input(self):
        self.ended = True

    async def aclose(self):
        self.closed = True
        self._block.set()

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.script:
            return self.script.pop(0)
        if self.fail is not None:
            raise self.fail
        await self._block.wait()  # idle, healthy stream
        raise StopAsyncIteration


class FakeSTT:
    def __init__(self, streams):
        self.streams = list(streams)
        self.opened = 0

    def stream(self):
        self.opened += 1
        return self.streams.pop(0) if self.streams else FakeStream()


def room_obj(stt=None, mode="partner-link") -> M.OwnerRoom:
    local = FakeLocal()
    ctx = NS(room=NS(name=EXP.room_name, local_participant=local, remote_participants={}), shutdown=lambda r: None)
    meta = M.RoomMeta(ownerIdentity=OWNER_ID, ownerSub=EXP.owner, conversationId=EXP.conversation_id, voiceId="aai-audrey", mode=mode)
    gate = SpeechGate(secret=SECRET, expect=Expectation(EXP.owner, EXP.conversation_id, EXP.room_name, 0), replay=MemoryReplayStore())
    r = M.OwnerRoom(ctx=ctx, env=NS(app_url="", approval_secret=SECRET), meta=meta, gate=gate, watchdog=Watchdog(started_at=time.monotonic()))
    r.stt = stt or FakeSTT([])
    r.source = NS(clear_queue=lambda: None)
    r.backoff = Backoff(rng=lambda: 0.5, base_s=0.0, cap_s=0.0)
    async def fast(_s):
        await asyncio.sleep(0)
    r.sleep = fast
    return r


def packet(payload: dict, topic=M.TOPIC_CONTROL, identity=OWNER_ID):
    return NS(topic=topic, data=json.dumps(payload).encode(), participant=NS(identity=identity, kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD))


def statuses(r: M.OwnerRoom):
    return [m for t, m in r.ctx.room.local_participant.sent if t == M.TOPIC_STATUS]


async def settle(n=30):
    for _ in range(n):
        await asyncio.sleep(0)


def pub(kind=rtc.TrackKind.KIND_AUDIO, source=rtc.TrackSource.SOURCE_MICROPHONE, muted=False):
    return NS(kind=kind, source=source, muted=muted, set_subscribed=lambda v: None)


def partner(identity, role="partner", kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD):
    return NS(identity=identity, kind=kind, attributes={"role": role} if role else {}, track_publications={})


def frame(rms_val: int, n=160):
    # a real rtc.AudioFrame.data is an int16 memoryview (len == samples), so the fake must be one too
    return NS(data=memoryview(array.array("h", [rms_val, -rms_val] * (n // 2))), sample_rate=16000, num_channels=1, samples_per_channel=n)


def add_source(r, ident, priority=2, now=None):
    r.selector.add(ident, priority, time.monotonic() if now is None else now)


# ------------------------------------------------------------------ #21 serialized controls, Stop overtakes
async def test_stop_that_overtakes_its_speak_prevents_speech_and_reports_cancelled_with_attempt():
    r = room_obj()
    r.ctl_task = asyncio.create_task(r._control_loop())
    a = make_approval("Hello")
    spoken = []
    r._synthesize = lambda attempt: spoken.append(attempt) or asyncio.sleep(0)  # must never be called
    r._on_data(packet({"type": "speak", "approval": json.loads(a.model_dump_json()), "text": "Hello"}))
    r._on_data(packet({"type": "stop", "playbackAttemptId": a.playbackAttemptId}))  # arrives right behind, handled synchronously
    await settle()
    r.closing = True
    r.ctl_task.cancel()
    assert spoken == []
    st = statuses(r)
    assert st and all(s.get("playbackAttemptId") == a.playbackAttemptId for s in st if s["type"] in M.SPEECH_STATUSES)
    assert {s["type"] for s in st} == {"cancelled"}


async def test_controls_are_processed_in_arrival_order():
    r = room_obj()
    order = []

    async def handle(t, raw):
        order.append(raw.get("n"))
        await asyncio.sleep(0)

    r._handle_control = handle
    r.ctl_task = asyncio.create_task(r._control_loop())
    for i in range(5):
        r._on_data(packet({"type": "listen", "enabled": bool(i % 2), "n": i}))
    await settle(80)
    r.closing = True
    r.ctl_task.cancel()
    assert order == [0, 1, 2, 3, 4]


async def test_non_owner_control_is_ignored_and_queue_overflow_rejects_with_attempt():
    r = room_obj()
    r._on_data(packet({"type": "end"}, identity="partner-1"))
    assert r.ctl_queue.empty()
    a = make_approval("Hello")
    body = {"type": "speak", "approval": json.loads(a.model_dump_json()), "text": "Hello"}
    for _ in range(M.CONTROL_QUEUE_MAX):
        r.ctl_queue.put_nowait(("listen", {"type": "listen", "enabled": True}))
    r._on_data(packet(body))
    await settle()
    st = statuses(r)
    assert st[-1]["type"] == "rejected" and st[-1]["playbackAttemptId"] == a.playbackAttemptId


async def test_every_speech_status_carries_the_attempt_id_even_for_malformed_speaks():
    r = room_obj()
    a = make_approval("Hello")
    bad = json.loads(a.model_dump_json())
    await r._speak({"type": "speak", "approval": bad, "text": ""})  # malformed (empty text) but carries an id
    await r._speak({"type": "speak", "approval": {**bad, "sub": "someone-else"}, "text": "Hello"})  # bad signature
    st = statuses(r)
    assert len(st) == 2
    assert all(s["type"] == "rejected" and s["playbackAttemptId"] == a.playbackAttemptId for s in st)
    assert M._attempt_of({"approval": {}}) is None and M._attempt_of(None) is None and M._attempt_of({"approval": {"playbackAttemptId": "x" * 99}}) is None


async def test_stop_for_unknown_attempt_does_not_disturb_running_speech():
    r = room_obj()
    a = make_approval("Hello")
    await r.gate.admit(a, "Hello")
    cur = r._stop_now("z" * 32)
    assert cur is None and r.gate.current and not r.gate.current.cancelled
    await r._announce_stop(cur, "z" * 32)
    assert statuses(r)[-1] == {"type": "cancelled", "playbackAttemptId": "z" * 32}


# ------------------------------------------------------------------ #22/#23 selection wiring
async def test_second_partner_is_transcribed_after_first_leaves():
    r = room_obj(FakeSTT([FakeStream(), FakeStream()]))
    add_source(r, "p1")
    add_source(r, "p2")
    await r.reselect()
    first = r.selector.active
    other = "p2" if first == "p1" else "p1"
    assert r.stt.opened == 1
    r._drop_source(first)
    await settle()
    assert r.selector.active == other and r.stt.opened == 2  # rescan -> the other partner is no longer ignored


async def test_only_the_active_source_reaches_stt_and_challenger_does_not_steal_silently():
    r = room_obj(FakeSTT([FakeStream()]))
    add_source(r, "p1")
    await r.reselect()
    add_source(r, "p2")
    s = r.stt_stream
    r._on_frame("p1", frame(2000))
    r._on_frame("p2", frame(2000))
    assert len(s.frames) == 1


async def test_phone_takes_over_and_open_turn_is_flushed_not_mixed():
    r = room_obj(FakeSTT([FakeStream(), FakeStream()]))
    add_source(r, "partner", 2)
    await r.reselect()
    r.adapter.reset(0)
    r.adapter.on_event("interim", "half a sentence")
    add_source(r, "sip", 3)
    await r.reselect()
    assert r.selector.active == "sip" and r.stt.opened == 2
    turns = [m for t, m in r.ctx.room.local_participant.sent if t == M.TOPIC_TRANSCRIPT]
    assert turns and turns[-1]["endOfTurn"] is True and turns[-1]["text"] == "half a sentence"


async def test_echo_gate_silences_frames_and_blocks_selector_activity():
    r = room_obj(FakeSTT([FakeStream()]))
    add_source(r, "p1")
    await r.reselect()
    r.echo.start_speaking()
    r._on_frame("p1", frame(5000))
    pushed = r.stt_stream.frames[-1]
    assert not any(bytes(pushed.data))  # replaced by silence (all-zero buffer)
    assert r.selector.sources["p1"].last_voice == float("-inf")  # our own voice is never "partner voice"


# ------------------------------------------------------------------ #24 idle pause + wake-on-voice
async def idle_paused_room():
    r = room_obj(FakeSTT([FakeStream(), FakeStream()]))
    add_source(r, "p1")
    await r.reselect()
    await r._idle_pause()
    assert r.stt_stream is None and not r.listening and r.watchdog.pause_reason == "idle"
    return r


async def test_idle_pause_closes_billing_then_voice_wakes_and_replays_preroll():
    r = await idle_paused_room()
    assert statuses(r)[-1] == {"type": "paused", "reason": "idle"}
    t0 = time.monotonic()
    # a click first: must NOT reopen the billed stream
    r._on_frame("p1", frame(5000))
    await settle()
    assert r.stt_stream is None
    for i in range(60):
        r._on_frame("p1", frame(5000))
        await asyncio.sleep(0.006)
        if r.stt_stream is not None:
            break
    await settle()
    assert r.stt_stream is not None and r.listening and r.watchdog.pause_reason is None
    assert len(r.stt_stream.frames) >= 1  # pre-roll replayed so the first words are not lost
    assert statuses(r)[-1]["type"] == "listening"
    assert time.monotonic() - t0 < 5


async def test_user_pause_never_auto_resumes_on_voice():
    r = room_obj(FakeSTT([FakeStream()]))
    add_source(r, "p1")
    await r.reselect()
    await r._set_listening(False)
    assert r.watchdog.pause_reason == "user"
    for _ in range(80):
        r._on_frame("p1", frame(5000))
        await asyncio.sleep(0.005)
    await settle()
    assert r.stt_stream is None and not r.listening and len(r.preroll) == 0


async def test_wake_ignores_our_own_synthesized_voice():
    r = await idle_paused_room()
    r.echo.start_speaking()
    for _ in range(80):
        r._on_frame("p1", frame(5000))
        await asyncio.sleep(0.005)
    await settle()
    assert r.stt_stream is None


async def test_wake_only_from_the_active_source():
    r = await idle_paused_room()
    add_source(r, "p2")
    for _ in range(80):
        r._on_frame("p2", frame(5000))
        await asyncio.sleep(0.005)
    await settle()
    assert r.stt_stream is None or r.selector.active == "p2"  # a silent/other source cannot wake the active stream


async def test_resume_after_user_pause_reopens_stt_and_resets_backoff():
    r = room_obj(FakeSTT([FakeStream(), FakeStream()]))
    add_source(r, "p1")
    await r.reselect()
    r.backoff.attempts = 3
    await r._set_listening(False)
    await r._set_listening(True)
    assert r.stt_stream is not None and r.backoff.attempts == 0
    assert statuses(r)[-1] == {"type": "listening"}


async def test_no_source_means_listening_true_but_no_stt_and_idle_clock_idle():
    r = room_obj()
    await r._set_listening(False)
    await r._set_listening(True)
    assert r.stt_stream is None and r.stt.opened == 0
    assert r.watchdog.check(time.monotonic() + 10_000) in (None, "timeout")  # never idle_pause without a source


# ------------------------------------------------------------------ #25 STT recovery
async def test_stt_failure_recovers_with_status_and_resumes():
    dead = FakeStream(fail=RuntimeError("socket closed"))
    alive = FakeStream(script=[NS(type=None, alternatives=[])])  # one benign event -> proves health
    r = room_obj(FakeSTT([dead, alive]))
    add_source(r, "p1")
    await r.reselect()
    for _ in range(200):
        await asyncio.sleep(0)
        if r.stt.opened == 2 and not r.recovering:
            break
    st = [s["type"] for s in statuses(r)]
    assert "reconnecting" in st and st[-1] == "listening"
    assert r.stt_stream is alive and r.backoff.attempts == 0
    assert "error" not in st  # `error` is a speech-only status now


async def test_stt_gives_up_after_bounded_attempts_then_explicit_resume_restarts():
    streams = [FakeStream(fail=RuntimeError("down")) for _ in range(M.Backoff().max_attempts + 3)]
    r = room_obj(FakeSTT(streams))
    r.backoff = Backoff(rng=lambda: 0.5, base_s=0.0, cap_s=0.0, max_attempts=3)
    add_source(r, "p1")
    await r.reselect()
    for _ in range(400):
        await asyncio.sleep(0)
        if not r.listening:
            break
    assert not r.listening and r.watchdog.pause_reason == "error"
    assert statuses(r)[-1] == {"type": "paused", "reason": "stt_failed"}
    assert r.stt.opened == 1 + 3  # the first open + exactly max_attempts retries
    assert r.stt_stream is None
    # an error pause never auto-wakes on voice
    for _ in range(80):
        r._on_frame("p1", frame(5000))
        await asyncio.sleep(0.003)
    assert r.stt_stream is None
    r.stt.streams = [FakeStream()]
    await r._set_listening(True)
    assert r.stt_stream is not None and r.backoff.attempts == 0


async def test_stream_ended_by_provider_counts_as_failure_but_our_own_close_does_not():
    r = room_obj(FakeSTT([FakeStream(script=[]), FakeStream()]))
    add_source(r, "p1")
    await r.reselect()
    await r._close_stt("paused")  # our own close: no recovery
    await settle()
    assert r.stt.opened == 1 and "reconnecting" not in [s["type"] for s in statuses(r)]


async def test_end_cancels_background_tasks_and_closes_stt():
    r = room_obj(FakeSTT([FakeStream()]))
    r.ctx.delete_room = lambda: asyncio.sleep(0)
    r.ctx.api = NS()
    r.tts = None
    r.ctl_task = asyncio.create_task(r._control_loop())
    add_source(r, "p1")
    await r.reselect()
    s = r.stt_stream
    await r.end("user")
    assert r.closing and s.closed and r.stt_stream is None and r.ctl_task.cancelled() or r.ctl_task.done()
    assert statuses(r)[-1]["type"] == "ended"
