"""Worker invariants — no network, no LiveKit server, no paid providers."""
from __future__ import annotations

import time

import pytest

from revoice_worker import config
from revoice_worker.approval import Approval, ApprovalRejected, Expectation, MemoryReplayStore, code_points, sha256_hex, sign, verify
from revoice_worker.gate import SpeechGate
from revoice_worker.log import sanitize
from revoice_worker.phone import DtmfCollector, allowed_call_minutes, sign_binding, verify_binding, worker_auth_header
from revoice_worker.tracks import TrackInfo, accept_control_from, authorize_track
from revoice_worker.turns import TurnAdapter
from revoice_worker.watchdog import Watchdog

SECRET = "test-secret-0123456789abcdef0123456789"
OWNER = "user-1"
EXP = Expectation(owner=OWNER, conversation_id="conv1", room_name="rv-aaaaaaaaaaaaaaaaaaaaaaaa", generation=0)


def make_approval(text: str, *, now: int | None = None, **over) -> Approval:
    now = now or int(time.time() * 1000)
    a = {
        "v": 1,
        "approvalId": "a" * 32,
        "playbackAttemptId": "b" * 32,
        "sub": OWNER,
        "conversationId": "conv1",
        "roomName": EXP.room_name,
        "generation": 0,
        "textHash": sha256_hex(text),
        "voiceId": "aai-audrey",
        "outputLanguage": "english",
        "chars": code_points(text),
        "iat": now,
        "exp": now + 60_000,
    }
    a.update(over)
    a["sig"] = sign(SECRET, a)
    return Approval.model_validate(a)


# ------------------------------------------------------------------ config invariants
def test_safe_defaults_hold():
    config.assert_safe_defaults()
    assert config.STT_MODEL == "universal-3-6-pro"
    assert config.TTS_MODEL == "assemblyai-tts-1"
    assert not config.LLM_ENABLED and not config.SPECULATIVE_TTS and not config.AUTONOMOUS_REPLIES
    assert not any(config.ADDONS.values())
    assert config.PHONE_MONTHLY_MINUTES_CAP == 40


def test_worker_imports_no_llm_or_other_tts_plugins():
    """Inspect real code (AST), not docstrings: no AgentSession/Agent/LLM and no other STT/TTS vendors."""
    import ast
    import pathlib

    pkg = pathlib.Path(__file__).parents[1] / "revoice_worker"
    banned_names = {"AgentSession", "Agent", "llm", "LLM", "preemptive_generation"}
    banned_modules = ("openai", "deepgram", "cartesia", "elevenlabs", "groq", "anthropic", "google", "silero")
    for f in pkg.glob("*.py"):
        tree = ast.parse(f.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                assert node.id not in banned_names, f"{f.name}: {node.id}"
            elif isinstance(node, ast.Attribute):
                assert node.attr not in banned_names, f"{f.name}: .{node.attr}"
            elif isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                assert not any(b in mod for b in banned_modules), f"{f.name}: from {mod}"
                for alias in node.names:
                    assert alias.name not in banned_names and alias.name not in banned_modules, f"{f.name}: import {alias.name}"
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    assert not any(b in alias.name for b in banned_modules), f"{f.name}: import {alias.name}"


# ------------------------------------------------------------------ approval (cross-language)
async def test_valid_approval_and_replay_rejected():
    replay = MemoryReplayStore()
    a = make_approval("Hello there")
    await verify(secret=SECRET, approval=a, text="Hello there", expect=EXP, replay=replay)
    with pytest.raises(ApprovalRejected) as e:
        await verify(secret=SECRET, approval=a, text="Hello there", expect=EXP, replay=replay)
    assert e.value.reason == "replayed"


@pytest.mark.parametrize(
    "text,over,exp,reason",
    [
        ("Hello!", {}, EXP, "altered_text"),
        ("Hello", {"sub": "someone-else"}, EXP, "wrong_user"),
        ("Hello", {"roomName": "rv-bbbbbbbbbbbbbbbbbbbbbbbb"}, EXP, "wrong_room"),
        ("Hello", {"generation": 1}, EXP, "stale_generation"),
        ("Hello", {"exp": 1}, EXP, "expired"),
    ],
)
async def test_rejections(text, over, exp, reason):
    a = make_approval("Hello", **over)
    with pytest.raises(ApprovalRejected) as e:
        await verify(secret=SECRET, approval=a, text=text, expect=exp, replay=MemoryReplayStore())
    assert e.value.reason == reason


async def test_bad_signature():
    a = make_approval("Hello").model_copy(update={"voiceId": "aai-peter"})
    with pytest.raises(ApprovalRejected) as e:
        await verify(secret=SECRET, approval=a, text="Hello", expect=EXP, replay=MemoryReplayStore())
    assert e.value.reason == "bad_signature"


def test_canonical_matches_typescript_vector():
    """Same vector as tests/approval.test.ts → proves byte-compatible signing across languages."""
    a = {
        "v": 1, "approvalId": "0" * 32, "playbackAttemptId": "1" * 32, "sub": "u", "conversationId": "c",
        "roomName": None, "generation": 0, "textHash": sha256_hex("café"), "voiceId": "aai-audrey",
        "outputLanguage": "english", "chars": 4, "iat": 1000, "exp": 61000,
    }
    assert sha256_hex("cafe\u0301") == sha256_hex("café")  # NFC normalization
    # Exact values produced by src/lib/hash.ts + src/lib/approval.ts (Web Crypto) for this input.
    assert a["textHash"] == "850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e"
    assert sign("k", a) == "33f05d16d97a75a783bc1c109b45f4f74b7cd8c35dd347f5c433a0df207cce86"


# ------------------------------------------------------------------ speech gate
async def test_gate_never_speaks_without_valid_approval():
    g = SpeechGate(secret=SECRET, expect=EXP, replay=MemoryReplayStore())
    bad = make_approval("Yes")
    with pytest.raises(ApprovalRejected):
        await g.admit(bad, "No")  # altered text
    assert g.current is None and g.phase == "idle"


async def test_gate_one_at_a_time_and_stop_drops_late_frames():
    g = SpeechGate(secret=SECRET, expect=EXP, replay=MemoryReplayStore())
    att = await g.admit(make_approval("First"), "First")
    with pytest.raises(ApprovalRejected) as e:
        await g.admit(make_approval("Second", approvalId="c" * 32, playbackAttemptId="d" * 32), "Second")
    assert e.value.reason == "busy"
    assert g.accept_frame(att.attempt_id)
    g.stop()
    assert not g.accept_frame(att.attempt_id)  # late frame dropped
    assert g.phase == "idle"


async def test_gate_failure_after_audio_is_uncertain_and_not_replayable():
    replay = MemoryReplayStore()
    g = SpeechGate(secret=SECRET, expect=EXP, replay=replay)
    a = make_approval("Hello")
    att = await g.admit(a, "Hello")
    g.accept_frame(att.attempt_id)
    assert g.failed(att.attempt_id) == "uncertain"
    with pytest.raises(ApprovalRejected) as e:
        await g.admit(a, "Hello")  # same approval cannot be replayed automatically
    assert e.value.reason == "replayed"


async def test_gate_failure_before_audio_is_error_and_refunds_chars():
    g = SpeechGate(secret=SECRET, expect=EXP, replay=MemoryReplayStore())
    att = await g.admit(make_approval("Hello"), "Hello")
    assert g.chars_used == 5
    assert g.failed(att.attempt_id) == "error"
    assert g.chars_used == 0


async def test_gate_session_char_cap_pauses_for_budget():
    g = SpeechGate(secret=SECRET, expect=EXP, replay=MemoryReplayStore(), char_cap=4)
    with pytest.raises(ApprovalRejected) as e:
        await g.admit(make_approval("Hello"), "Hello")
    assert e.value.reason == "session_char_cap" and g.phase == "paused_for_budget"
    with pytest.raises(ApprovalRejected) as e2:
        await g.admit(make_approval("Hi", approvalId="e" * 32), "Hi")
    assert e2.value.reason == "paused_for_budget"


async def test_gate_generation_bump_invalidates_old_approvals():
    g = SpeechGate(secret=SECRET, expect=EXP, replay=MemoryReplayStore())
    a = make_approval("Hello")
    g.bump_generation(1)
    with pytest.raises(ApprovalRejected) as e:
        await g.admit(a, "Hello")
    assert e.value.reason == "stale_generation"


# ------------------------------------------------------------------ turn adapter
def test_turn_revisions_replace_not_append():
    t = TurnAdapter()
    m1 = t.on_event("interim", "Are you free")
    m2 = t.on_event("interim", "Are you free on Tuesday")
    assert m1 and m2 and m1.turnId == m2.turnId == 0
    assert (m1.revision, m2.revision) == (0, 1)
    assert m2.text == "Are you free on Tuesday"  # replaced, not "Are you free Are you free on Tuesday"
    assert t.on_event("interim", "Are you free on Tuesday") is None  # identical -> no churn
    f = t.on_event("final", "Are you free on Tuesday?")
    assert f and f.endOfTurn and f.revision == 2
    n = t.on_event("interim", "Okay")
    assert n and n.turnId == 1 and n.revision == 0


def test_turn_speech_started_once_and_reset():
    t = TurnAdapter()
    s = t.on_event("start")
    assert s and s.speechStarted
    assert t.on_event("start") is None
    t.on_event("final", "hi")
    t.reset(3)
    m = t.on_event("interim", "again")
    assert m and m.generation == 3 and m.turnId == 0
    assert m.to_dict()["type"] == "turn"


def test_empty_final_without_open_turn_ignored():
    assert TurnAdapter().on_event("final", "") is None


# ------------------------------------------------------------------ track authorization
def ti(identity, kind="standard", role=None, track="audio", source="microphone"):
    return TrackInfo(identity, kind, role, track, source, local_worker_identity="agent-xyz")


@pytest.mark.parametrize(
    "info,mode,ok",
    [
        (ti(OWNER), "tabletop", True),
        (ti("partner-1", role="partner"), "tabletop", False),
        (ti("partner-1", role="partner"), "partner-link", True),
        (ti(OWNER), "partner-link", False),
        (ti("rando"), "partner-link", False),  # no partner role
        (ti("agent-xyz", kind="agent"), "partner-link", False),  # our own synthesized output
        (ti("partner-1", role="partner", source="screenshare_audio"), "remote", False),
        (ti("partner-1", role="partner", track="video", source="camera"), "remote", False),
        (ti("sip-1", kind="sip"), "partner-link", False),  # unbound phone caller
    ],
)
def test_authorize_track(info, mode, ok):
    assert authorize_track(info, mode=mode, owner=OWNER, bound_phone_identity=None, already_transcribing=None)[0] is ok


def test_single_stream_and_bound_phone():
    assert authorize_track(ti("p2", role="partner"), mode="remote", owner=OWNER, bound_phone_identity=None, already_transcribing="p1") == (False, "single_stream")
    assert authorize_track(ti("sip-1", kind="sip"), mode="remote", owner=OWNER, bound_phone_identity="sip-1", already_transcribing=None)[0]


def test_control_only_from_owner():
    assert accept_control_from(OWNER, "standard", OWNER)
    assert not accept_control_from("partner-1", "standard", OWNER)
    assert not accept_control_from(OWNER, "sip", OWNER)


# ------------------------------------------------------------------ watchdog
def test_watchdog_paths():
    w = Watchdog(started_at=0, max_minutes=20)
    assert w.check(10) is None
    assert w.check(config.IDLE_NO_AUDIO_S + 1) == "idle_pause"
    w.set_listening(False, 400)
    assert w.check(1000) is None  # paused: no idle billing
    w.owner_left(1000)
    assert w.check(1000 + config.OWNER_GONE_GRACE_S) == "room_exit"
    w.owner_returned()
    assert w.check(20 * 60) == "timeout"
    w2 = Watchdog(started_at=0, max_minutes=999)
    assert w2.max_minutes == config.SESSION_MAX_MINUTES
    w2.budget_exhausted = True
    assert w2.check(1) == "budget"


def test_watchdog_phone_cap():
    w = Watchdog(started_at=0)
    w.phone_bound(0, 2)
    w.partner_audio(119)
    assert w.check(119) is None
    assert w.check(120) == "phone_cap"
    assert round(w.phone_minutes_used(90), 2) == 1.5


# ------------------------------------------------------------------ phone binding
def test_phone_binding_roundtrip_and_rejections():
    now = 1_000_000
    raw = sign_binding(SECRET, "rv-room", "sip-1", now + 60_000, 10)
    assert verify_binding(SECRET, raw, room="rv-room", identity="sip-1", now_ms=now) == 10
    assert verify_binding(SECRET, raw, room="rv-other", identity="sip-1", now_ms=now) is None
    assert verify_binding(SECRET, raw, room="rv-room", identity="sip-2", now_ms=now) is None
    assert verify_binding(SECRET, raw, room="rv-room", identity="sip-1", now_ms=now + 61_000) is None
    assert verify_binding("wrong", raw, room="rv-room", identity="sip-1", now_ms=now) is None
    assert verify_binding(SECRET, "not json", room="rv-room", identity="sip-1") is None
    assert verify_binding(SECRET, sign_binding(SECRET, "r", "i", now + 1, 99), room="r", identity="i", now_ms=now) is None


def test_phone_cap_math():
    assert allowed_call_minutes(0) == 15
    assert allowed_call_minutes(30) == 10
    assert allowed_call_minutes(39.5) == 0
    assert allowed_call_minutes(45) == 0


def test_dtmf_collector():
    c = DtmfCollector()
    assert [c.push(d) for d in "12345"] == [None] * 5
    assert c.push("6") == "123456"
    c.push("9"); c.push("*")
    assert c.buf == ""
    for _ in range(2):
        for d in "000000":
            c.push(d)
    assert c.exhausted and c.push("1") is None


def test_worker_auth_header_format():
    h = worker_auth_header(SECRET, '{"a":1}', now_ms=123)
    ts, sig = h.split(".")
    assert ts == "123" and len(sig) == 64


# ------------------------------------------------------------------ content-free logs
def test_log_sanitize_drops_content():
    out = sanitize({"evt": "tts", "text": "secret words", "transcript": "x", "chars": 5})
    assert "text" not in out and "transcript" not in out and out["chars"] == 5
