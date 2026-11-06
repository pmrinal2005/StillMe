"""D #45 - the phone call room is ALWAYS deleted, whatever happens (drives the REAL run_call_room with fakes)."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace as NS

import pytest
from livekit import rtc
from livekit.plugins import assemblyai

from revoice_worker import main as M


class FakeRoom:
    def __init__(self):
        self.handlers = {}
        self.local_participant = NS(publish_track=self._publish)
        self.name = "call-abc"

    async def _publish(self, *a, **k):
        return None

    def on(self, ev, cb):
        self.handlers[ev] = cb


class FakeCtx:
    def __init__(self, caller=None, wait_forever=False):
        self.room = FakeRoom()
        self.caller = caller
        self.wait_forever = wait_forever
        self.deleted = 0
        removed = []
        self.removed = removed

        async def remove_participant(req):
            removed.append(req)

        self.api = NS(room=NS(remove_participant=remove_participant, update_participant=self._noop, move_participant=self._noop))

    async def _noop(self, *a, **k):
        return None

    async def wait_for_participant(self, kind=None):
        if self.wait_forever:
            await asyncio.sleep(3600)
        return self.caller

    async def delete_room(self):
        self.deleted += 1


class FakeTTS:
    closed = 0
    fail_close = False

    def __init__(self, *a, **k):
        pass

    def synthesize(self, text):
        raise RuntimeError("no network in tests")  # say() swallows provider failures

    async def aclose(self):
        FakeTTS.closed += 1
        if FakeTTS.fail_close:
            raise RuntimeError("close failed")


class FakeSource:
    def __init__(self, *a, **k):
        pass

    async def capture_frame(self, f):
        return None

    async def wait_for_playout(self):
        return None


@pytest.fixture(autouse=True)
def _fakes(monkeypatch):
    FakeTTS.closed = 0
    FakeTTS.fail_close = False
    monkeypatch.setattr(assemblyai, "TTS", FakeTTS)
    monkeypatch.setattr(rtc, "AudioSource", FakeSource)
    monkeypatch.setattr(rtc.LocalAudioTrack, "create_audio_track", staticmethod(lambda name, src: object()))


def env(enabled=True):
    return NS(phone_inbound_enabled=enabled, assembly_key="k", tts_base_url=None)


async def test_no_caller_within_the_timeout_deletes_the_call_room(monkeypatch):
    """The bug: TimeoutError escaped before the try/finally, so the room lingered and the job crashed."""
    monkeypatch.setattr(M, "CALL_CONNECT_TIMEOUT_S", 0.05)
    ctx = FakeCtx(wait_forever=True)
    await M.run_call_room(ctx, env())  # must NOT raise
    assert ctx.deleted == 1


async def test_phone_disabled_deletes_the_room():
    ctx = FakeCtx(caller=NS(identity="sip-1"))
    await M.run_call_room(ctx, env(enabled=False))
    assert ctx.deleted == 1


async def test_pairing_timeout_hangs_up_and_deletes(monkeypatch):
    monkeypatch.setattr(M, "PHONE_PAIR_TIMEOUT_S", 0.05)
    ctx = FakeCtx(caller=NS(identity="sip-1"))
    await M.run_call_room(ctx, env())
    assert len(ctx.removed) == 1  # the unpaired caller is removed
    assert ctx.deleted == 1
    assert FakeTTS.closed == 1


async def test_a_failing_tts_close_does_not_stop_room_deletion(monkeypatch):
    monkeypatch.setattr(M, "PHONE_PAIR_TIMEOUT_S", 0.05)
    FakeTTS.fail_close = True
    ctx = FakeCtx(caller=NS(identity="sip-1"))
    await M.run_call_room(ctx, env())
    assert FakeTTS.closed == 1
    assert ctx.deleted == 1


async def test_an_unexpected_error_still_deletes_the_room(monkeypatch):
    ctx = FakeCtx(caller=NS(identity="sip-1"))

    async def boom(*a, **k):
        raise RuntimeError("publish failed")

    ctx.room.local_participant = NS(publish_track=boom)
    with pytest.raises(RuntimeError):
        await M.run_call_room(ctx, env())
    assert ctx.deleted == 1


async def test_successful_pairing_moves_the_caller_and_still_deletes_the_call_room(monkeypatch):
    moved = []
    ctx = FakeCtx(caller=NS(identity="sip-1"))

    async def move(req):
        moved.append(req)

    ctx.api = NS(room=NS(remove_participant=ctx.api.room.remove_participant, update_participant=ctx._noop, move_participant=move))

    async def fake_post(env_, path, body):
        return {"ok": True, "room": "rv-" + "a" * 24, "binding": "{}"}

    monkeypatch.setattr(M, "_post_app", fake_post)
    task = asyncio.create_task(M.run_call_room(ctx, env()))
    for _ in range(200):
        if "sip_dtmf_received" in ctx.room.handlers:
            break
        await asyncio.sleep(0.01)
    for d in "123456":
        ctx.room.handlers["sip_dtmf_received"](NS(participant=NS(identity="sip-1"), digit=d))
    await asyncio.wait_for(task, 5)
    assert len(moved) == 1
    assert ctx.deleted == 1
