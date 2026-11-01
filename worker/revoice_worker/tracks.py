"""Track authorization: the worker transcribes ONLY the authorized partner microphone.

Rules
 - Never an agent participant (this excludes our own synthesized output and any other agent).
 - Only audio tracks whose source is MICROPHONE (no screenshare audio, no unknown sources).
 - tabletop:      the owner's own device microphone hears the nearby partner.
 - partner-link / remote: standard participants with role=partner (invite-issued tokens), never the owner.
 - phone:         a SIP participant only when it has been bound to this owner session via a pair code.
 - At most ONE transcribed track at a time (no duplicate paid streams on the same conversation).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Mode = Literal["tabletop", "partner-link", "remote"]
Kind = Literal["standard", "agent", "sip", "other"]
Source = Literal["microphone", "camera", "screenshare", "screenshare_audio", "unknown"]


@dataclass(frozen=True)
class TrackInfo:
    identity: str
    participant_kind: Kind
    role: str | None  # LiveKit participant attribute set by the server-issued token
    track_kind: Literal["audio", "video"]
    source: Source
    local_worker_identity: str = ""


def authorize_track(t: TrackInfo, *, mode: Mode, owner: str, bound_phone_identity: str | None, already_transcribing: str | None) -> tuple[bool, str]:
    if t.track_kind != "audio":
        return False, "not_audio"
    if t.source != "microphone":
        return False, "not_microphone"
    if t.participant_kind == "agent" or (t.local_worker_identity and t.identity == t.local_worker_identity):
        return False, "agent_output"  # never transcribe synthesized speech
    if already_transcribing and already_transcribing != t.identity:
        return False, "single_stream"
    if t.participant_kind == "sip":
        if bound_phone_identity and t.identity == bound_phone_identity:
            return True, "phone_bound"
        return False, "phone_unbound"
    if t.participant_kind != "standard":
        return False, "unsupported_kind"
    if mode == "tabletop":
        return (t.identity == owner, "owner_tabletop" if t.identity == owner else "not_owner_tabletop")
    # partner-link / remote
    if t.identity == owner:
        return False, "owner_not_partner"
    if t.role != "partner":
        return False, "no_partner_role"
    return True, "partner"


def accept_control_from(identity: str, participant_kind: Kind, owner: str) -> bool:
    """Control (speak/stop/listen/end) is accepted only from the authenticated owner identity."""
    return participant_kind == "standard" and identity == owner
