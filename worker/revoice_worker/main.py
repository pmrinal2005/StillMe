"""ReVOICE LiveKit worker — a human-gated speech relay built on rtc primitives.

Deliberately NOT used: AgentSession, Agent, any LLM, preemptive generation, speculative TTS,
automatic replies, recording. The worker does exactly four things:
  1. subscribes ONLY to the authorized partner microphone track and transcribes it (AssemblyAI BYOK,
     universal-3-6-pro selected explicitly), publishing superseding turn revisions to the owner;
  2. on a signed owner approval for exact text, synthesizes it (AssemblyAI BYOK TTS, pooled/prewarmed
     sockets that rotate before their 1-hour lifetime) into its own audio track;
  3. stops immediately on Stop (cancel synthesis, clear queued audio, drop late frames);
  4. closes provider streams on pause, idle, timeout, owner exit, budget exhaustion and room end.

Run:  python -m revoice_worker.main start     (LiveKit Cloud / self-hosted)
      python -m revoice_worker.main dev       (local development)
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ValidationError

from .approval import ApprovalRejected, Expectation, MemoryReplayStore, SpeakControl
from .config import (
    MAX_SPOKEN_CHARS,
    OUTPUT_LANGUAGES,
    PHONE_PAIR_TIMEOUT_S,
    STT_MODEL,
    TTS_MODEL,
    assert_safe_defaults,
    load_env,
)
from .echo import EchoGate
from .gate import SpeechGate
from .log import log_event
from .phone import BIND_ATTR, DtmfCollector, verify_binding, worker_auth_header
from .tracks import TrackInfo, accept_control_from, authorize_track
from .turns import TurnAdapter
from .watchdog import Watchdog

logger = logging.getLogger("revoice.worker")

TOPIC_TRANSCRIPT = "revoice.transcript"
TOPIC_CONTROL = "revoice.control"
TOPIC_STATUS = "revoice.status"

STT_SAMPLE_RATE = 16_000
TTS_SAMPLE_RATE = 24_000
PHONE_PROMPT_VOICE = "aai-audrey"  # fixed LIBRARY voice — never a cloned voice for automated prompts
PHONE_PROMPT = (
    "This line connects to a ReVOICE assistive communication session. Your speech will be transcribed. "
    "Please enter your six digit pairing code."
)


class RoomMeta(BaseModel):
    ownerIdentity: str
    conversationId: str
    generation: int = 0
    mode: str = "tabletop"
    voiceId: str
    outputLanguage: str = "english"
    inputLanguages: list[str] = []
    keyterms: list[str] = []
    contextPrompt: str | None = None
    maxSessionMinutes: int = 20


class StopControl(BaseModel):
    type: str
    playbackAttemptId: str | None = None


class ListenControl(BaseModel):
    type: str
    enabled: bool


class GateControl(BaseModel):
    """B6: owner device is playing approved speech itself (HTTP-TTS fallback) -> treat partner audio as echo."""
    type: str
    on: bool
    ttlMs: int | None = None


# --------------------------------------------------------------------------- helpers

def _kind(p: Any) -> str:
    from livekit import rtc

    k = getattr(p, "kind", None)
    return {
        rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD: "standard",
        rtc.ParticipantKind.PARTICIPANT_KIND_AGENT: "agent",
        rtc.ParticipantKind.PARTICIPANT_KIND_SIP: "sip",
    }.get(k, "other")


def _source(pub: Any) -> str:
    from livekit import rtc

    return {
        rtc.TrackSource.SOURCE_MICROPHONE: "microphone",
        rtc.TrackSource.SOURCE_CAMERA: "camera",
        rtc.TrackSource.SOURCE_SCREENSHARE: "screenshare",
        rtc.TrackSource.SOURCE_SCREENSHARE_AUDIO: "screenshare_audio",
    }.get(getattr(pub, "source", None), "unknown")


def _track_kind(pub: Any) -> str:
    from livekit import rtc

    return "audio" if getattr(pub, "kind", None) == rtc.TrackKind.KIND_AUDIO else "video"


async def _post_app(env: Any, path: str, payload: dict) -> dict | None:
    """Content-free worker -> web-app call, HMAC-authenticated."""
    if not env.app_url or not env.approval_secret:
        return None
    import aiohttp

    body = json.dumps(payload, separators=(",", ":"))
    headers = {"content-type": "application/json", "x-revoice-worker": worker_auth_header(env.approval_secret, body)}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{env.app_url}{path}", data=body, headers=headers, timeout=aiohttp.ClientTimeout(total=8)) as r:
                return await r.json() if r.status < 500 else None
    except Exception:  # noqa: BLE001 — network failure must not crash the job
        return None


# --------------------------------------------------------------------------- owner room

@dataclass
class OwnerRoom:
    ctx: Any
    env: Any
    meta: RoomMeta
    gate: SpeechGate
    watchdog: Watchdog
    adapter: TurnAdapter = field(default_factory=TurnAdapter)
    stt: Any = None
    tts: Any = None
    source: Any = None
    transcribing: str | None = None
    bound_phone: str | None = None
    listening: bool = True
    speak_task: asyncio.Task | None = None
    stt_task: asyncio.Task | None = None
    audio_task: asyncio.Task | None = None
    stt_stream: Any = None
    echo: EchoGate = field(default_factory=EchoGate)
    voice: str = ""
    language: str = ""
    closing: bool = False

    # ---------------- publishing
    async def send(self, topic: str, msg: dict) -> None:
        try:
            await self.ctx.room.local_participant.publish_data(
                json.dumps(msg), reliable=True, topic=topic, destination_identities=[self.meta.ownerIdentity]
            )
        except Exception:  # noqa: BLE001
            pass

    async def status(self, type_: str, attempt: str | None = None, reason: str | None = None) -> None:
        m: dict[str, Any] = {"type": type_}
        if attempt:
            m["playbackAttemptId"] = attempt
        if reason:
            m["reason"] = reason[:200]
        await self.send(TOPIC_STATUS, m)

    # ---------------- setup
    async def start(self) -> None:
        from livekit import rtc
        from livekit.agents import NOT_GIVEN
        from livekit.plugins import assemblyai

        key = self.env.assembly_key
        # BYOK: charges go to the owner's AssemblyAI account, never LiveKit Inference.
        self.stt = assemblyai.STT(
            api_key=key,
            model=STT_MODEL,
            sample_rate=STT_SAMPLE_RATE,
            base_url=self.env.stt_base_url,
            format_turns=True,
            mode="balanced",
            language_codes=self.meta.inputLanguages[:4] or NOT_GIVEN,
            keyterms_prompt=[k[:50] for k in self.meta.keyterms[:30]] or NOT_GIVEN,
            prompt=(self.meta.contextPrompt or "")[:300] or NOT_GIVEN,
        )
        self.voice = self.meta.voiceId
        self.language = self.meta.outputLanguage if self.meta.outputLanguage in OUTPUT_LANGUAGES else "english"
        self.tts = assemblyai.TTS(
            api_key=key,
            voice=self.voice,
            language=self.language,
            model=TTS_MODEL,
            sample_rate=TTS_SAMPLE_RATE,
            word_timestamps=False,  # add-on stays off
            base_url=self.env.tts_base_url,
        )
        self.tts.prewarm()  # warm pooled socket; NO text is sent until an approval verifies

        self.source = rtc.AudioSource(TTS_SAMPLE_RATE, 1, queue_size_ms=400)
        track = rtc.LocalAudioTrack.create_audio_track("revoice-voice", self.source)
        opts = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
        await self.ctx.room.local_participant.publish_track(track, opts)

        room = self.ctx.room
        room.on("track_published", lambda pub, p: self._consider(pub, p))
        room.on("track_subscribed", lambda track, pub, p: self._on_subscribed(track, pub, p))
        room.on("track_unsubscribed", lambda track, pub, p: self._on_unsubscribed(p))
        room.on("data_received", self._on_data)
        room.on("participant_connected", self._on_joined)
        room.on("participant_disconnected", self._on_left)
        room.on("participant_attributes_changed", lambda changed, p: self._on_attrs(p))
        for p in room.remote_participants.values():
            self._on_joined(p)
            for pub in p.track_publications.values():
                self._consider(pub, p)
        if self.meta.ownerIdentity not in room.remote_participants:
            self.watchdog.owner_left(time.monotonic())
        self.echo.mode = self.meta.mode
        await self.status("ready")
        log_event(evt="room_ready", room=room.name, kind=self.meta.mode)

    # ---------------- track authorization
    def _info(self, pub: Any, p: Any) -> TrackInfo:
        return TrackInfo(
            identity=p.identity,
            participant_kind=_kind(p),  # type: ignore[arg-type]
            role=(p.attributes or {}).get("role"),
            track_kind=_track_kind(pub),  # type: ignore[arg-type]
            source=_source(pub),  # type: ignore[arg-type]
            local_worker_identity=self.ctx.room.local_participant.identity,
        )

    def _consider(self, pub: Any, p: Any) -> None:
        ok, reason = authorize_track(
            self._info(pub, p),
            mode=self.meta.mode,  # type: ignore[arg-type]
            owner=self.meta.ownerIdentity,
            bound_phone_identity=self.bound_phone,
            already_transcribing=self.transcribing,
        )
        log_event(evt="track_decision", status="subscribe" if ok else "ignore", reason=reason)
        if ok:
            pub.set_subscribed(True)

    def _on_subscribed(self, track: Any, pub: Any, p: Any) -> None:
        ok, _ = authorize_track(
            self._info(pub, p), mode=self.meta.mode, owner=self.meta.ownerIdentity,  # type: ignore[arg-type]
            bound_phone_identity=self.bound_phone, already_transcribing=self.transcribing,
        )
        if not ok:  # defense in depth: never transcribe an unauthorized track
            pub.set_subscribed(False)
            return
        self.transcribing = p.identity
        self.audio_task = asyncio.create_task(self._pump_audio(track))
        if self.listening:
            self._open_stt()

    def _on_unsubscribed(self, p: Any) -> None:
        if p.identity == self.transcribing:
            self.transcribing = None
            if self.audio_task:
                self.audio_task.cancel()
            asyncio.create_task(self._close_stt("track_gone"))

    # ---------------- STT lifecycle (billed by connected duration)
    def _open_stt(self) -> None:
        if self.stt_stream is not None or self.closing:
            return
        self.stt_stream = self.stt.stream()
        self.adapter.closed = True  # new stream -> new turn ids continue monotonically
        self.stt_task = asyncio.create_task(self._consume_stt(self.stt_stream))
        log_event(evt="stt_open")

    async def _close_stt(self, reason: str) -> None:
        s, self.stt_stream = self.stt_stream, None
        if s is None:
            return
        try:
            s.end_input()
            await asyncio.wait_for(s.aclose(), timeout=3)
        except Exception:  # noqa: BLE001
            pass
        if self.stt_task:
            self.stt_task.cancel()
        log_event(evt="stt_close", reason=reason)

    async def _pump_audio(self, track: Any) -> None:
        from livekit import rtc

        stream = rtc.AudioStream(track, sample_rate=STT_SAMPLE_RATE, num_channels=1)
        try:
            async for ev in stream:
                s = self.stt_stream
                if s is None:
                    continue  # paused: frames are dropped, nothing is sent or billed
                frame = ev.frame
                # B6 echo safety (ALL modes, architecture rule 5): while our synthesized voice plays — from
                # this worker or from the owner's device during HTTP-TTS fallback — plus a mode-aware tail,
                # send silence so our own output is never transcribed as partner input.
                if self.echo.should_silence(time.monotonic(), gate_phase_speaking=self.gate.phase == "speaking"):
                    frame = rtc.AudioFrame(bytes(len(frame.data) * 2), frame.sample_rate, frame.num_channels, frame.samples_per_channel)
                s.push_frame(frame)
        finally:
            await stream.aclose()

    async def _consume_stt(self, s: Any) -> None:
        from livekit.agents import stt as lkstt

        kinds = {
            lkstt.SpeechEventType.START_OF_SPEECH: "start",
            lkstt.SpeechEventType.INTERIM_TRANSCRIPT: "interim",
            lkstt.SpeechEventType.PREFLIGHT_TRANSCRIPT: "preflight",
            lkstt.SpeechEventType.FINAL_TRANSCRIPT: "final",
        }
        try:
            async for ev in s:
                k = kinds.get(ev.type)
                if not k:
                    continue
                text = ev.alternatives[0].text if ev.alternatives else ""
                msg = self.adapter.on_event(k, text)  # type: ignore[arg-type]
                if msg is None:
                    continue
                self.watchdog.partner_audio(time.monotonic())
                await self.send(TOPIC_TRANSCRIPT, msg.to_dict())
        except asyncio.CancelledError:
            pass
        except Exception as e:  # noqa: BLE001
            log_event(evt="stt_error", code=type(e).__name__)
            await self.status("error", reason="stt_unavailable")
            self.stt_stream = None

    # ---------------- control (owner only)
    def _on_data(self, packet: Any) -> None:
        if packet.topic != TOPIC_CONTROL or packet.participant is None:
            return
        if not accept_control_from(packet.participant.identity, _kind(packet.participant), self.meta.ownerIdentity):  # type: ignore[arg-type]
            log_event(evt="control_rejected", reason="not_owner")
            return
        try:
            raw = json.loads(packet.data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return
        t = raw.get("type") if isinstance(raw, dict) else None
        if t == "speak":
            asyncio.create_task(self._speak(raw))
        elif t == "stop":
            try:
                asyncio.create_task(self._stop(StopControl.model_validate(raw).playbackAttemptId))
            except ValidationError:
                pass
        elif t == "listen":
            try:
                asyncio.create_task(self._set_listening(ListenControl.model_validate(raw).enabled))
            except ValidationError:
                pass
        elif t == "end":
            asyncio.create_task(self.end("user"))
        elif t == "hello":
            # B5: presence probe from the owner device. Answer only once fully set up.
            if self.source is not None and not self.closing:
                asyncio.create_task(self.status("ready"))
        elif t == "gate":
            try:
                g = GateControl.model_validate(raw)
                self.echo.owner_gate(g.on, time.monotonic(), g.ttlMs)
                log_event(evt="owner_gate", status="on" if g.on else "off")
            except ValidationError:
                pass

    async def _speak(self, raw: dict) -> None:
        try:
            ctl = SpeakControl.model_validate(raw)
        except ValidationError:
            await self.status("rejected", reason="malformed")
            return
        if len(ctl.text) > MAX_SPOKEN_CHARS:
            await self.status("rejected", reason="too_long")
            return
        try:
            attempt = await self.gate.admit(ctl.approval, ctl.text)
        except ApprovalRejected as e:
            log_event(evt="approval_rejected", reason=e.reason)
            await self.status("rejected", attempt=ctl.approval.playbackAttemptId, reason=e.reason)
            if e.reason == "session_char_cap":
                await self.status("paused", reason="budget")
            return
        self.speak_task = asyncio.create_task(self._synthesize(attempt))

    async def _synthesize(self, attempt: Any) -> None:
        t0 = time.monotonic()
        try:
            # Voice/language are fixed per TTS session: changing them retires pooled sockets
            # (a newly configured session), never a mid-session switch.
            if attempt.voice_id != self.voice or attempt.language != self.language:
                self.tts.update_options(voice=attempt.voice_id, language=attempt.language)
                self.voice, self.language = attempt.voice_id, attempt.language
            self.echo.start_speaking()
            await self.status("speaking", attempt=attempt.attempt_id)
            first = True
            async with self.tts.synthesize(attempt.text) as stream:  # exact approved text only
                async for ev in stream:
                    if not self.gate.accept_frame(attempt.attempt_id):
                        return  # cancelled: drop late frames
                    if first:
                        log_event(evt="tts_first_audio", attempt=attempt.attempt_id, ms=int((time.monotonic() - t0) * 1000))
                        first = False
                    await self.source.capture_frame(ev.frame)
            await self.source.wait_for_playout()
            self.echo.stop_speaking(time.monotonic())
            if self.gate.finished(attempt.attempt_id):
                log_event(evt="tts_done", attempt=attempt.attempt_id, chars=attempt.chars, ms=int((time.monotonic() - t0) * 1000))
                await self.status("done", attempt=attempt.attempt_id)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            self.echo.stop_speaking(time.monotonic())
            outcome = self.gate.failed(attempt.attempt_id)
            log_event(evt="tts_failed", attempt=attempt.attempt_id, code=type(e).__name__, status=outcome)
            if outcome:
                # 'uncertain' = some audio may have been heard. NEVER replayed automatically.
                await self.status(outcome, attempt=attempt.attempt_id, reason="synthesis_failed")

    async def _stop(self, attempt_id: str | None) -> None:
        cur = self.gate.stop(attempt_id)
        if self.speak_task and not self.speak_task.done():
            self.speak_task.cancel()  # cancels server synthesis (socket request aborted)
        if self.source:
            self.source.clear_queue()  # drop queued device audio immediately
        self.echo.stop_speaking(time.monotonic())
        if cur:
            log_event(evt="tts_stop", attempt=cur.attempt_id)
            await self.status("cancelled", attempt=cur.attempt_id)

    async def _set_listening(self, enabled: bool) -> None:
        self.listening = enabled
        self.watchdog.set_listening(enabled, time.monotonic())
        if enabled and self.transcribing:
            self._open_stt()
            await self.status("listening")
        elif not enabled:
            await self._close_stt("paused")  # disconnecting (not muting) stops session billing
            await self.status("paused", reason="user")

    # ---------------- participants & phone binding
    def _on_joined(self, p: Any) -> None:
        if p.identity == self.meta.ownerIdentity:
            self.watchdog.owner_returned()
            # B5: the owner may have connected after our initial `ready` (which then went nowhere).
            if self.source is not None and not self.closing:
                asyncio.create_task(self.status("ready"))
        if _kind(p) == "sip":
            self._on_attrs(p)

    def _on_attrs(self, p: Any) -> None:
        if _kind(p) != "sip" or self.bound_phone:
            return
        mm = verify_binding(self.env.approval_secret or "", (p.attributes or {}).get(BIND_ATTR), room=self.ctx.room.name, identity=p.identity)
        if mm is None:
            log_event(evt="phone_unbound_rejected")
            return
        self.bound_phone = p.identity
        self.watchdog.phone_bound(time.monotonic(), mm)
        log_event(evt="phone_bound", minutes=mm)
        for pub in p.track_publications.values():
            self._consider(pub, p)

    def _on_left(self, p: Any) -> None:
        now = time.monotonic()
        if p.identity == self.meta.ownerIdentity:
            self.watchdog.owner_left(now)
        if p.identity == self.bound_phone:
            used = self.watchdog.phone_minutes_used(now)
            self.watchdog.phone_ended()
            self.bound_phone = None
            asyncio.create_task(_post_app(self.env, "/api/phone/usage", {"room": self.ctx.room.name, "minutes": round(used, 2)}))
            log_event(evt="phone_ended", minutes=round(used, 2))

    async def _hang_up_phone(self) -> None:
        from livekit import api

        ident = self.bound_phone
        if not ident:
            return
        try:
            await self.ctx.api.room.remove_participant(api.RoomParticipantIdentity(room=self.ctx.room.name, identity=ident))
        except Exception:  # noqa: BLE001
            pass

    # ---------------- watchdog loop & shutdown
    async def run_watchdog(self) -> None:
        while not self.closing:
            await asyncio.sleep(5)
            r = self.watchdog.check(time.monotonic())
            if r is None:
                continue
            if r == "idle_pause":
                await self._close_stt("idle")
                self.listening = False
                self.watchdog.set_listening(False, time.monotonic())
                await self.status("paused", reason="idle")
            elif r == "phone_cap":
                await self._hang_up_phone()
            else:
                await self.end(r)
                return

    async def end(self, reason: str) -> None:
        if self.closing:
            return
        self.closing = True
        await self._stop(None)
        await self._close_stt(reason)
        await self._hang_up_phone()
        await self.status("ended", reason=reason)
        log_event(evt="session_end", reason=reason)
        try:
            if self.tts:
                await self.tts.aclose()
        except Exception:  # noqa: BLE001
            pass
        try:
            await self.ctx.delete_room()  # room closure ends every provider stream
        except Exception:  # noqa: BLE001
            pass
        self.ctx.shutdown(reason)


# --------------------------------------------------------------------------- phone call room

async def run_call_room(ctx: Any, env: Any) -> None:
    """Included-number inbound call lands here first. Pair via DTMF code, then move into owner room."""
    from livekit import api, rtc
    from livekit.plugins import assemblyai

    if not env.phone_inbound_enabled:
        log_event(evt="phone_disabled")
        await ctx.delete_room()
        return
    caller = await asyncio.wait_for(ctx.wait_for_participant(kind=rtc.ParticipantKind.PARTICIPANT_KIND_SIP), timeout=30)
    source = rtc.AudioSource(TTS_SAMPLE_RATE, 1)
    track = rtc.LocalAudioTrack.create_audio_track("revoice-prompt", source)
    await ctx.room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    tts = assemblyai.TTS(api_key=env.assembly_key, voice=PHONE_PROMPT_VOICE, language="english", model=TTS_MODEL, word_timestamps=False, base_url=env.tts_base_url)

    async def say(text: str) -> None:  # fixed system prompts only, library voice
        try:
            async with tts.synthesize(text) as s:
                async for ev in s:
                    await source.capture_frame(ev.frame)
            await source.wait_for_playout()
        except Exception:  # noqa: BLE001
            pass

    collector = DtmfCollector()
    codes: asyncio.Queue[str] = asyncio.Queue()

    def on_dtmf(ev: Any) -> None:
        if ev.participant is None or ev.participant.identity != caller.identity:
            return
        code = collector.push(ev.digit)
        if code:
            codes.put_nowait(code)

    ctx.room.on("sip_dtmf_received", on_dtmf)
    await say(PHONE_PROMPT)
    deadline = time.monotonic() + PHONE_PAIR_TIMEOUT_S
    try:
        while not collector.exhausted or not codes.empty():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                code = await asyncio.wait_for(codes.get(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            res = await _post_app(env, "/api/phone/bind", {"code": code, "identity": caller.identity, "callRoom": ctx.room.name})
            if res and res.get("ok"):
                dest, binding = res["room"], res["binding"]
                await ctx.api.room.update_participant(
                    api.UpdateParticipantRequest(room=ctx.room.name, identity=caller.identity, attributes={BIND_ATTR: binding})
                )
                await ctx.api.room.move_participant(
                    api.MoveParticipantRequest(room=ctx.room.name, identity=caller.identity, destination_room=dest)
                )
                log_event(evt="phone_paired")
                return
            reason = (res or {}).get("error", "unavailable")
            log_event(evt="phone_pair_failed", reason=str(reason))
            if reason == "phone_cap":
                await say("The monthly phone allowance for this service has been used. Goodbye.")
                break
            await say("That code was not accepted. Please try again." if not collector.exhausted else "Sorry, pairing failed. Goodbye.")
        await ctx.api.room.remove_participant(api.RoomParticipantIdentity(room=ctx.room.name, identity=caller.identity))
    finally:
        await tts.aclose()
        await ctx.delete_room()


# --------------------------------------------------------------------------- entrypoint

def parse_meta(raw: str | None) -> RoomMeta | None:
    if not raw:
        return None
    try:
        return RoomMeta.model_validate_json(raw)
    except ValidationError:
        return None


async def entrypoint(ctx: Any) -> None:
    from livekit.agents import AutoSubscribe

    assert_safe_defaults()
    env = load_env()
    if not env.assembly_key or not env.approval_secret:
        raise RuntimeError("ASSEMBLYAI_API_KEY is required, plus REVOICE_APPROVAL_SECRET or LIVEKIT_API_SECRET (approval secret is derived from it)")
    # Subscribe to nothing by default: each track is authorized individually.
    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_NONE)
    meta = parse_meta(ctx.room.metadata)
    if meta is None:
        # No server-set metadata => not an owner room. Only phone call rooms are allowed here.
        if ctx.room.name.startswith("call-"):
            await run_call_room(ctx, env)
        else:
            log_event(evt="room_refused", reason="no_metadata")
        return
    gate = SpeechGate(
        secret=env.approval_secret,
        expect=Expectation(meta.ownerIdentity, meta.conversationId, ctx.room.name, meta.generation),
        replay=MemoryReplayStore(),
    )
    owner = OwnerRoom(ctx=ctx, env=env, meta=meta, gate=gate, watchdog=Watchdog(started_at=time.monotonic(), max_minutes=meta.maxSessionMinutes))
    ctx.add_shutdown_callback(lambda *_: owner.end("room_exit"))
    await owner.start()
    await owner.run_watchdog()


def main() -> None:
    from livekit.agents import WorkerOptions, cli

    env = load_env()
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=env.agent_name))


if __name__ == "__main__":
    main()
