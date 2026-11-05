"""Worker-side approval verification. MUST stay byte-compatible with src/lib/approval.ts.

A detected gap is not consent. Only an approval signed by the web app — bound to the room owner,
an exact NFC-normalized text hash, this conversation/room/generation, a voice, and a short expiry —
may cause speech. Rejects altered, stale, replayed, expired, wrong-room and wrong-user approvals.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import time
import unicodedata
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

from .config import MAX_SPOKEN_CHARS, OUTPUT_LANGUAGES

HEX64 = r"^[a-f0-9]{64}$"


class Approval(BaseModel):
    v: Literal[1]
    approvalId: str = Field(min_length=16, max_length=64)
    playbackAttemptId: str = Field(min_length=16, max_length=64)
    sub: str = Field(min_length=1, max_length=128)
    conversationId: str = Field(min_length=1, max_length=64)
    roomName: str | None = Field(default=None, max_length=128)
    generation: int = Field(ge=0)
    textHash: str = Field(pattern=HEX64)
    voiceId: str = Field(min_length=1, max_length=128)
    outputLanguage: Literal["english", "spanish", "german", "italian", "portuguese", "french"]
    chars: int = Field(ge=1)
    iat: int
    exp: int
    sig: str = Field(pattern=HEX64)


class SpeakControl(BaseModel):
    type: Literal["speak"]
    approval: Approval
    text: str = Field(min_length=1, max_length=MAX_SPOKEN_CHARS)


def normalize(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(normalize(text).encode("utf-8")).hexdigest()


def code_points(text: str) -> int:
    return len(normalize(text))


def canonical(a: dict[str, Any]) -> str:
    return "\n".join(
        [
            f"v={a['v']}",
            f"approvalId={a['approvalId']}",
            f"playbackAttemptId={a['playbackAttemptId']}",
            f"sub={a['sub']}",
            f"conversationId={a['conversationId']}",
            f"roomName={a.get('roomName') or ''}",
            f"generation={a['generation']}",
            f"textHash={a['textHash']}",
            f"voiceId={a['voiceId']}",
            f"outputLanguage={a['outputLanguage']}",
            f"chars={a['chars']}",
            f"iat={a['iat']}",
            f"exp={a['exp']}",
        ]
    )


def sign(secret: str, unsigned: dict[str, Any]) -> str:
    return hmac.new(secret.encode("utf-8"), canonical(unsigned).encode("utf-8"), hashlib.sha256).hexdigest()


class ApprovalRejected(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class ReplayStore(Protocol):
    async def consume(self, approval_id: str, expires_at_ms: int, user: str, text_hash: str) -> bool: ...


class MemoryReplayStore:
    def __init__(self) -> None:
        self._used: dict[str, int] = {}

    async def consume(self, approval_id: str, expires_at_ms: int, user: str = "", text_hash: str = "") -> bool:
        now = int(time.time() * 1000)
        for k, exp in list(self._used.items()):
            if exp + 60_000 < now:
                del self._used[k]
        if approval_id in self._used:
            return False
        self._used[approval_id] = expires_at_ms
        return True


@dataclass
class Expectation:
    owner: str
    conversation_id: str
    room_name: str
    generation: int


def signature_ok(secret: str, approval: Approval) -> bool:
    """Signature only (no replay consumption). Lets the gate trust an approval's ids before acting on them."""
    a = approval.model_dump()
    sig = a.pop("sig")
    return hmac.compare_digest(sign(secret, a), sig)


async def verify(*, secret: str, approval: Approval, text: str, expect: Expectation, replay: ReplayStore, now_ms: int | None = None) -> Approval:
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    a = approval.model_dump()
    sig = a.pop("sig")
    expected = sign(secret, a)
    if not hmac.compare_digest(expected, sig):
        raise ApprovalRejected("bad_signature")
    if not hmac.compare_digest(sha256_hex(text), approval.textHash):
        raise ApprovalRejected("altered_text")
    if code_points(text) != approval.chars:
        raise ApprovalRejected("altered_text")
    if now > approval.exp:
        raise ApprovalRejected("expired")
    if approval.sub != expect.owner:
        raise ApprovalRejected("wrong_user")
    if approval.conversationId != expect.conversation_id or (approval.roomName or "") != expect.room_name:
        raise ApprovalRejected("wrong_room")
    if approval.generation != expect.generation:
        raise ApprovalRejected("stale_generation")
    if approval.outputLanguage not in OUTPUT_LANGUAGES:
        raise ApprovalRejected("malformed")
    # Consume last so a rejected approval is not burned by an earlier failed check.
    if not await replay.consume(approval.approvalId, approval.exp, approval.sub, approval.textHash):
        raise ApprovalRejected("replayed")
    return approval


_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def safe_id(s: str) -> bool:
    return bool(_ID.match(s))
