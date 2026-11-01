"""Content-free structured logging (mirrors src/lib/server/log.ts). Never transcripts, drafts,
approved text or audio. There is no switch to enable raw-content logging."""
from __future__ import annotations

import json
import logging
import time

_ALLOWED = {
    "evt", "attempt", "chars", "billed", "req", "tokens", "status", "reason", "ms", "room", "voice",
    "kind", "code", "provider", "minutes", "usd", "generation", "turn", "revision",
}
_log = logging.getLogger("revoice.events")


def sanitize(fields: dict) -> dict:
    out: dict = {"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    for k, v in fields.items():
        if k not in _ALLOWED:
            continue
        if isinstance(v, str):
            out[k] = v[:64]
        elif isinstance(v, (int, float, bool)) or v is None:
            out[k] = v
    return out


def log_event(**fields: object) -> None:
    _log.info(json.dumps(sanitize(fields)))
