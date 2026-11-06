"""Opt-in LIVE check of the worker's AssemblyAI path (never runs in CI / pytest).

    ASSEMBLYAI_API_KEY=... python worker/scripts/live_check.py

Uses the SAME pinned LiveKit AssemblyAI plugin + settings as revoice_worker.main:
  plugin TTS (approved text) -> 16 kHz PCM -> plugin STT stream (universal-3-6-pro) -> TurnAdapter
and asserts the C-series turn semantics on REAL provider events:
  * every update SUPERSEDES the previous one (revision strictly increases, one turn id)
  * exactly one final (endOfTurn) message, with the authoritative text
Spend: ~70 TTS characters + ~15 s of streaming STT (well under the $2 phase-0 envelope).
"""
from __future__ import annotations

import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from livekit import rtc  # noqa: E402
from livekit.agents import NOT_GIVEN, stt as lkstt  # noqa: E402
from livekit.agents.utils import http_context  # noqa: E402
from livekit.plugins import assemblyai  # noqa: E402

from revoice_worker.config import STT_MODEL, TTS_MODEL  # noqa: E402
from revoice_worker.turns import TurnAdapter  # noqa: E402

KEY = os.environ.get("ASSEMBLYAI_API_KEY", "").strip()
SENTENCE = "Are you free for dinner on Friday? I was thinking about seven o clock."
RATE = 16000
fails = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global fails
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{' - ' + detail if detail else ''}")
    if not ok:
        fails += 1


async def synth() -> bytes:
    tts = assemblyai.TTS(api_key=KEY, voice="aai-sara", language="english", model=TTS_MODEL, sample_rate=RATE, word_timestamps=False)
    pcm = bytearray()
    async with tts.synthesize(SENTENCE) as stream:
        async for ev in stream:
            pcm += ev.frame.data.tobytes()
    await tts.aclose()
    return bytes(pcm)


async def main() -> int:
    if not KEY:
        print("ASSEMBLYAI_API_KEY is required (environment variable).")
        return 2
    print("1) worker TTS (plugin, assemblyai-tts-1)")
    t0 = time.monotonic()
    pcm = await synth()
    check("synthesized audio", len(pcm) > RATE * 2, f"{len(pcm)} bytes in {int((time.monotonic() - t0) * 1000)} ms")

    print("2) worker STT (plugin, universal-3-6-pro) -> TurnAdapter")
    stt = assemblyai.STT(api_key=KEY, model=STT_MODEL, sample_rate=RATE, format_turns=True, mode="balanced",
                         language_codes=NOT_GIVEN, keyterms_prompt=NOT_GIVEN, prompt=NOT_GIVEN)
    adapter = TurnAdapter()
    adapter.reset(0)
    msgs = []
    kinds = {
        lkstt.SpeechEventType.START_OF_SPEECH: "start",
        lkstt.SpeechEventType.INTERIM_TRANSCRIPT: "interim",
        lkstt.SpeechEventType.PREFLIGHT_TRANSCRIPT: "preflight",
        lkstt.SpeechEventType.FINAL_TRANSCRIPT: "final",
    }
    stream = stt.stream()

    async def consume() -> None:
        async for ev in stream:
            k = kinds.get(ev.type)
            if not k:
                continue
            m = adapter.on_event(k, ev.alternatives[0].text if ev.alternatives else "")
            if m is not None:
                msgs.append(m)

    task = asyncio.create_task(consume())
    spf = RATE // 100  # 10 ms frames, paced in real time like a live track
    pcm += bytes(RATE * 2 * 2)  # 2 s of trailing silence so the endpoint fires
    for i in range(0, len(pcm) - spf * 2 + 1, spf * 2):
        stream.push_frame(rtc.AudioFrame(pcm[i:i + spf * 2], RATE, 1, spf))
        await asyncio.sleep(0.008)
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=12)
    except asyncio.TimeoutError:
        pass
    stream.end_input()
    try:
        await asyncio.wait_for(task, timeout=6)
    except asyncio.TimeoutError:
        task.cancel()
    await stream.aclose()
    await stt.aclose()

    turn_msgs = [m for m in msgs if m.text]
    finals = [m for m in turn_msgs if m.endOfTurn]
    check("received transcript updates", len(turn_msgs) >= 1, f"{len(turn_msgs)} messages")
    ids = {m.turnId for m in turn_msgs}
    revs = [m.revision for m in turn_msgs]
    check("revisions strictly increase within the stream", revs == sorted(set(revs)), f"revisions={revs}")
    check("at least one final (endOfTurn) message", len(finals) >= 1, f"turns={sorted(ids)} finals={len(finals)}")
    if finals:
        text = finals[-1].text.lower()
        words = ("free", "dinner", "friday", "seven", "7")
        hit = [w for w in words if w in text]
        check("final text is the authoritative transcript", len(hit) >= 3, repr(finals[-1].text))
    return fails


async def run() -> int:
    # Outside an agent job the plugins need an explicit shared HTTP session.
    async with http_context.open():
        return await main()


if __name__ == "__main__":
    rc = asyncio.run(run())
    print(f"\n{'ALL PASSED' if rc == 0 else f'{rc} FAILED'}")
    sys.exit(1 if rc else 0)
