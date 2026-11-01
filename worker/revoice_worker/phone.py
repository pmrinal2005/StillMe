"""Inbound phone bridge (optional, US included number only). Pure helpers, testable without LiveKit.

Flow
  1. Owner (authenticated, with an ACTIVE session) creates a short-lived 6-digit pair code in the app.
  2. Partner calls the included number -> LiveKit dispatch rule puts the caller in a fresh call room
     and dispatches this worker there ("call-room" job).
  3. Worker collects the code via DTMF (never caller ID alone), POSTs it to /api/phone/bind with a
     worker HMAC. The app validates code + active session + monthly cap and returns the owner room,
     allowed minutes, and a signed binding.
  4. Worker sets the binding as a participant attribute (server API; SIP participants cannot edit
     their own attributes) and MOVES the caller into the owner room.
  5. The owner-room worker transcribes the SIP participant ONLY if the binding verifies for that
     room + identity + unexpired. No autonomous greeting in the cloned voice — the only automated
     prompt is a fixed, non-cloned library-voice instruction to enter the code.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time

from .config import PHONE_MAX_CALL_MINUTES, PHONE_MONTHLY_MINUTES_CAP

BIND_ATTR = "revoice.phone_binding"
PAIR_CODE_DIGITS = 6
MAX_CODE_ATTEMPTS = 3


def _h(secret: str, msg: str) -> str:
    return hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()


def binding_string(room: str, identity: str, exp_ms: int, max_minutes: float) -> str:
    """Must match phoneBindingString() in src/lib/phone.ts."""
    return f"phone:{room}:{identity}:{exp_ms}:{max_minutes:g}"


def sign_binding(secret: str, room: str, identity: str, exp_ms: int, max_minutes: float) -> str:
    sig = _h(secret, binding_string(room, identity, exp_ms, max_minutes))
    return json.dumps({"room": room, "identity": identity, "exp": exp_ms, "maxMinutes": max_minutes, "sig": sig}, separators=(",", ":"))


def verify_binding(secret: str, raw: str | None, *, room: str, identity: str, now_ms: int | None = None) -> float | None:
    """Returns allowed call minutes if the binding is valid for this room+identity, else None."""
    if not raw:
        return None
    try:
        b = json.loads(raw)
        exp = int(b["exp"])
        mm = float(b["maxMinutes"])
        sig = str(b["sig"])
    except (ValueError, KeyError, TypeError):
        return None
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    if b.get("room") != room or b.get("identity") != identity or now > exp:
        return None
    if not (0 < mm <= PHONE_MAX_CALL_MINUTES):
        return None
    if not hmac.compare_digest(_h(secret, binding_string(room, identity, exp, mm)), sig):
        return None
    return mm


def allowed_call_minutes(used_this_month: float, cap: float = PHONE_MONTHLY_MINUTES_CAP, per_call: float = PHONE_MAX_CALL_MINUTES) -> float:
    """Application cap: 40 of the 50 included minutes (10 headroom); integer minutes, 0 = refuse."""
    left = cap - used_this_month
    return float(max(0, int(min(per_call, left))))


class DtmfCollector:
    """Collects a fixed-length numeric code; '*' clears, '#' submits early. Bounded attempts."""

    def __init__(self, digits: int = PAIR_CODE_DIGITS, max_attempts: int = MAX_CODE_ATTEMPTS) -> None:
        self.digits = digits
        self.max_attempts = max_attempts
        self.buf = ""
        self.attempts = 0

    @property
    def exhausted(self) -> bool:
        return self.attempts >= self.max_attempts

    def push(self, d: str) -> str | None:
        if self.exhausted:
            return None
        if d == "*":
            self.buf = ""
            return None
        if d == "#":
            code, self.buf = self.buf, ""
            if len(code) == self.digits:
                self.attempts += 1
                return code
            return None
        if d.isdigit():
            self.buf += d
            if len(self.buf) == self.digits:
                code, self.buf = self.buf, ""
                self.attempts += 1
                return code
        return None


def worker_auth_header(secret: str, body: str, now_ms: int | None = None) -> str:
    """Worker -> web app request authentication. Must match verifyWorkerAuth() in src/lib/server/worker-auth.ts."""
    ts = now_ms if now_ms is not None else int(time.time() * 1000)
    return f"{ts}.{_h(secret, f'worker:{ts}:{body}')}"
