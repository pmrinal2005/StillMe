"""B16/B17 worker side: configuration comes from the DISPATCH metadata; ownerSub (user id, what approvals are signed
for) and ownerIdentity (opaque per-room LiveKit identity, who may send control) are different things."""
from __future__ import annotations

import json
import time

import pytest

from revoice_worker.approval import Approval, ApprovalRejected, Expectation, MemoryReplayStore, code_points, sha256_hex, sign
from revoice_worker.gate import SpeechGate
from revoice_worker.main import is_owner_room_name, parse_meta
from revoice_worker.tracks import accept_control_from, authorize_track, TrackInfo

SECRET = "test-secret-0123456789abcdef0123456789"
ROOM = "rv-aaaaaaaaaaaaaaaaaaaaaaaa"
USER = "5b1d7a52-2a3c-4f6e-9a55-0c1f1e2d3c4b"  # the owner's user id (approval `sub`)
OPAQUE = "o-0123456789abcdef01234567"  # the owner's per-room LiveKit identity


def cfg(**over):
    base = {
        "ownerIdentity": OPAQUE, "ownerSub": USER, "conversationId": "c1", "generation": 0, "mode": "partner-link",
        "voiceId": "aai-audrey", "outputLanguage": "english", "inputLanguages": [], "keyterms": ["Dr. Okafor"],
        "contextPrompt": "medical appointment", "maxSessionMinutes": 20,
    }
    base.update(over)
    return json.dumps(base)


def test_parse_dispatch_metadata():
    m = parse_meta(cfg())
    assert m is not None
    assert (m.ownerIdentity, m.ownerSub) == (OPAQUE, USER)
    assert m.keyterms == ["Dr. Okafor"] and m.contextPrompt == "medical appointment"


@pytest.mark.parametrize("raw", [None, "", "not json", "{}", json.dumps({"ownerIdentity": USER, "conversationId": "c", "voiceId": "x"})])
def test_missing_or_legacy_config_is_refused(raw):
    # The legacy shape (no ownerSub) must NOT be accepted: it would fall back to treating the identity as the user id.
    assert parse_meta(raw) is None


def test_owner_room_name_guard():
    assert is_owner_room_name(ROOM)
    assert not is_owner_room_name("call-abc")
    assert not is_owner_room_name("lobby")


def _approval(sub: str, text: str = "Hello there") -> Approval:
    now = int(time.time() * 1000)
    unsigned = {
        "v": 1, "approvalId": "a" * 32, "playbackAttemptId": "b" * 32, "sub": sub, "conversationId": "c1", "roomName": ROOM,
        "generation": 0, "textHash": sha256_hex(text), "voiceId": "aai-audrey", "outputLanguage": "english",
        "chars": code_points(text), "iat": now, "exp": now + 60_000,
    }
    return Approval(**unsigned, sig=sign(SECRET, unsigned))


@pytest.mark.asyncio
async def test_gate_accepts_approval_signed_for_the_user_id():
    m = parse_meta(cfg())
    gate = SpeechGate(secret=SECRET, expect=Expectation(m.ownerSub, m.conversationId, ROOM, m.generation), replay=MemoryReplayStore())
    attempt = await gate.admit(_approval(USER), "Hello there")
    assert attempt.text == "Hello there"


@pytest.mark.asyncio
async def test_gate_rejects_approval_whose_sub_is_the_opaque_identity():
    # An approval minted for the LiveKit identity (not the user) is the wrong subject.
    m = parse_meta(cfg())
    gate = SpeechGate(secret=SECRET, expect=Expectation(m.ownerSub, m.conversationId, ROOM, m.generation), replay=MemoryReplayStore())
    with pytest.raises(ApprovalRejected) as e:
        await gate.admit(_approval(OPAQUE), "Hello there")
    assert e.value.reason == "wrong_user"


def test_control_only_from_the_opaque_owner_identity_never_the_user_id():
    assert accept_control_from(OPAQUE, "standard", OPAQUE)
    assert not accept_control_from(USER, "standard", OPAQUE)  # knowing the user id is not enough
    assert not accept_control_from("partner-abc123", "standard", OPAQUE)
    assert not accept_control_from(OPAQUE, "agent", OPAQUE)


def test_tabletop_track_is_the_opaque_owner_and_partner_never_is():
    t = lambda ident, role=None: TrackInfo(identity=ident, participant_kind="standard", role=role, track_kind="audio", source="microphone", local_worker_identity="agent-1")
    ok, _ = authorize_track(t(OPAQUE), mode="tabletop", owner=OPAQUE, bound_phone_identity=None)
    assert ok
    ok, _ = authorize_track(t("partner-1", "partner"), mode="tabletop", owner=OPAQUE, bound_phone_identity=None)
    assert not ok
    ok, _ = authorize_track(t("partner-1", "partner"), mode="partner-link", owner=OPAQUE, bound_phone_identity=None)
    assert ok
