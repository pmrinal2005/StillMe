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
    CALL_CONNECT_TIMEOUT_S,
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
from .recovery import HEALTHY_AFTER_S, Backoff
from .sources import SourceSelector, priority_for
from .tracks import TrackInfo, accept_control_from, authorize_track
from .turns import TurnAdapter
from .stt_profile import SttChoice, choose_stt
from .usage import AgentMeter, SttMeter, TtsLedger, agent_report, should_stop, stt_report
from .wake import VOICE_RMS, PreRoll, WakeDetector, frame_rms
from .watchdog import Watchdog

logger = logging.getLogger("revoice.worker")

TOPIC_TRANSCRIPT = "revoice.transcript"
TOPIC_CONTROL = "revoice.control"
TOPIC_STATUS = "revoice.status"

# C #20: every one of these refers to ONE utterance and MUST carry its playbackAttemptId, so a late status of an old
# attempt can never be applied to the current one. (`ready` / `listening` / `paused` / `reconnecting` / `ended` are
# session-level and never carry one; `error` is a speech error only — STT trouble uses `reconnecting` / `paused`.)
SPEECH_STATUSES = frozenset({"speaking", "done", "cancelled", "uncertain", "rejected", "error"})
CONTROL_QUEUE_MAX = 64
WATCHDOG_TICK_S = 5.0
RESELECT_MIN_INTERVAL_S = 1.0  # a challenger's voice triggers a re-evaluation at most this often

STT_SAMPLE_RATE = 16_000
TTS_SAMPLE_RATE = 24_000
PHONE_PROMPT_VOICE = "aai-audrey"  # fixed LIBRARY voice — never a cloned voice for automated prompts
PHONE_PROMPT = (
    "This line connects to a ReVOICE assistive communication session. Your speech will be transcribed. "
    "Please enter your six digit pairing code."
)


class RoomMeta(BaseModel):
    """B16: the worker's private configuration. It arrives in the AGENT DISPATCH metadata (ctx.job.metadata), which is
    delivered to this job only. Room metadata is readable by every participant (the partner's browser) and is SEALED by
    the web app, so the worker never reads configuration from it.

    ownerIdentity = the owner's opaque, per-room LiveKit participant identity: control messages and the tabletop
                    track are accepted only from it. It is NOT the user id.
    ownerSub      = the owner's user id: what approvals are signed for (`sub`). Never used as a LiveKit identity.
    """

    ownerIdentity: str
    ownerSub: str
    conversationId: str
    generation: int = 0
    mode: str = "tabletop"
    voiceId: str
    outputLanguage: str = "english"
    inputLanguages: list[str] = []
    keyterms: list[str] = []
    contextPrompt: str | None = None
    maxSessionMinutes: int = 20
    sttProfile: str = "flagship"  # F: flagship | economy


class StopControl(BaseModel):
    type: str
    playbackAttemptId: str | None = None


class ListenControl(BaseModel):
    type: str
    enabled: bool


class GenerationControl(BaseModel):
    """F: the owner's device reconnected and the web app issued a NEW generation (monotonic). Old approvals become stale."""
    type: str
    generation: int


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


def _attempt_of(raw: Any) -> str | None:
    """Best-effort playbackAttemptId of a (possibly malformed) speak control, so even a `rejected` status is
    attempt-scoped (C #20). Only returned when it looks like an id; never trusted for anything but routing a status."""
    try:
        a = raw["approval"]["playbackAttemptId"]
    except (KeyError, TypeError):
        return None
    return a if isinstance(a, str) and 0 < len(a) <= 64 else None


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
    bound_phone: str | None = None
    listening: bool = True
    speak_task: asyncio.Task | None = None
    stt_task: asyncio.Task | None = None
    stt_stream: Any = None
    stt_events: int = 0  # events delivered by the CURRENT stream (proof the provider is healthy)
    bg: set = field(default_factory=set)  # strong refs to fire-and-forget tasks
    wake_task: asyncio.Task | None = None
    recover_task: asyncio.Task | None = None
    _last_resel: float = 0.0
    sleep: Any = asyncio.sleep  # injectable for tests
    # C #22/#23: which authorized track is transcribed is decided by the selector; each candidate track has a pump.
    selector: SourceSelector = field(default_factory=SourceSelector)
    pumps: dict[str, asyncio.Task] = field(default_factory=dict)
    sel_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # C #24: wake-on-voice after an IDLE pause (energy detector + short in-memory pre-roll).
    wake: WakeDetector = field(default_factory=WakeDetector)
    preroll: PreRoll = field(default_factory=PreRoll)
    # C #25: bounded STT recovery.
    backoff: Backoff = field(default_factory=Backoff)
    recovering: bool = False
    # C #21: owner controls are processed strictly in arrival order by ONE consumer (Stop is handled synchronously).
    ctl_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=CONTROL_QUEUE_MAX))
    ctl_task: asyncio.Task | None = None
    echo: EchoGate = field(default_factory=EchoGate)
    voice: str = ""
    language: str = ""
    closing: bool = False
    # A1/A10 metering (content-free)
    stt_meter: SttMeter = field(default_factory=SttMeter)
    agent_meter: AgentMeter = field(default_factory=lambda: AgentMeter(started_at=time.monotonic()))
    tts_ledger: TtsLedger = field(default_factory=TtsLedger)
    stt_choice: SttChoice | None = None

    # ---------------- usage reports (A1 / A10)
    async def _report(self, payload: dict | None) -> None:
        if payload:
            await _post_app(self.env, "/api/worker/usage", payload)

    def _report_tts(self, approval_id: str, chars: int) -> None:
        """A1: settle the approval-time reservation (ref tts:<approvalId>) with what was actually synthesized."""
        payload = self.tts_ledger.report(approval_id, chars)
        if payload:
            asyncio.create_task(self._report(payload))

    async def _report_session(self, final: bool) -> None:
        """A10: connected STT minutes (authoritative when final) + LiveKit agent minutes for this room.

        F: the heartbeat's reply can carry {"stop": true}: the web app re-checked the RUNNING room against the shared limits
        (project day USD, lifetime protected reserve, this room's own reservation) and a limit is now exceeded.
        """
        now = time.monotonic()
        room = self.ctx.room.name
        profile = self.stt_choice.profile if self.stt_choice else self.meta.sttProfile
        resp = None
        payload = stt_report(room, self.stt_meter, now, final, profile)
        if self.env.app_url and self.env.approval_secret:
            resp = await _post_app(self.env, "/api/worker/usage", payload)
        await self._report(agent_report(room, self.meta.ownerSub, self.agent_meter, now))  # user id (spend attribution), not the opaque identity
        if not final:
            why = should_stop(resp)
            if why and not self.closing:
                log_event(evt="budget_stop", reason=why)
                self.watchdog.budget_exhausted = True
                await self.status("paused", reason=f"budget:{why}")

    # ---------------- publishing
    async def send(self, topic: str, msg: dict) -> None:
        try:
            await self.ctx.room.local_participant.publish_data(
                json.dumps(msg), reliable=True, topic=topic, destination_identities=[self.meta.ownerIdentity]
            )
        except Exception:  # noqa: BLE001
            pass

    async def status(self, type_: str, attempt: str | None = None, reason: str | None = None) -> None:
        if type_ in SPEECH_STATUSES and not attempt:
            log_event(evt="status_without_attempt", kind=type_)  # should never happen; surfaced in logs, not hidden
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
        # F: the profile picks the model. Economy = Universal-Streaming ($0.15/h); flagship = Universal-3.6 Pro ($0.45/h).
        choice = choose_stt(self.meta.sttProfile, self.meta.inputLanguages)
        self.stt_choice = choice
        if choice.downgraded_from:
            log_event(evt="stt_profile_downgrade", reason=choice.reason or "")
        kw: dict[str, Any] = dict(
            api_key=key,
            model=choice.model,
            sample_rate=STT_SAMPLE_RATE,
            base_url=self.env.stt_base_url,
            format_turns=True,
            vad_threshold=choice.vad_threshold,
        )
        if choice.profile == "flagship":
            kw["mode"] = "balanced"
            kw["language_codes"] = choice.language_codes or NOT_GIVEN
            kw["prompt"] = (self.meta.contextPrompt or "")[:300] or NOT_GIVEN
        if choice.use_keyterms:
            kw["keyterms_prompt"] = [k[:50] for k in self.meta.keyterms[:30]] or NOT_GIVEN
        self.stt = assemblyai.STT(**kw)
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
        self.ctl_task = asyncio.create_task(self._control_loop())
        room.on("track_published", lambda pub, p: self._consider(pub, p))
        room.on("track_subscribed", lambda track, pub, p: self._on_subscribed(track, pub, p))
        room.on("track_unsubscribed", lambda track, pub, p: self._on_unsubscribed(pub, p))
        room.on("track_unpublished", lambda pub, p: self._on_unpublished(pub, p))
        room.on("track_muted", lambda p, pub: self._on_mute(p, pub, True))
        room.on("track_unmuted", lambda p, pub: self._on_mute(p, pub, False))
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

    # ---------------- track authorization & source selection (C #22/#23)
    def _info(self, pub: Any, p: Any) -> TrackInfo:
        return TrackInfo(
            identity=p.identity,
            participant_kind=_kind(p),  # type: ignore[arg-type]
            role=(p.attributes or {}).get("role"),
            track_kind=_track_kind(pub),  # type: ignore[arg-type]
            source=_source(pub),  # type: ignore[arg-type]
            local_worker_identity=self.ctx.room.local_participant.identity,
        )

    def _authorize(self, pub: Any, p: Any) -> tuple[bool, str]:
        return authorize_track(
            self._info(pub, p),
            mode=self.meta.mode,  # type: ignore[arg-type]
            owner=self.meta.ownerIdentity,
            bound_phone_identity=self.bound_phone,
        )

    def _spawn(self, coro: Any) -> asyncio.Task:
        """create_task that keeps a strong reference (fire-and-forget tasks must not be garbage collected mid-flight)."""
        t = asyncio.create_task(coro)
        self.bg.add(t)
        t.add_done_callback(self.bg.discard)
        return t

    def _consider(self, pub: Any, p: Any) -> None:
        ok, reason = self._authorize(pub, p)
        log_event(evt="track_decision", status="subscribe" if ok else "ignore", reason=reason)
        if not ok:
            return
        pub.set_subscribed(True)
        if p.identity in self.selector.sources:
            # Already subscribed (e.g. a SIP participant that has JUST been bound): its priority changed -> re-rank now.
            self.selector.add(p.identity, priority_for(reason), time.monotonic())
            self._request_reselect()

    def _on_subscribed(self, track: Any, pub: Any, p: Any) -> None:
        ok, reason = self._authorize(pub, p)
        if not ok:  # defense in depth: never transcribe an unauthorized track
            pub.set_subscribed(False)
            return
        ident = p.identity
        self.selector.add(ident, priority_for(reason), time.monotonic())
        self.selector.set_muted(ident, bool(getattr(pub, "muted", False)))
        old = self.pumps.pop(ident, None)
        if old is not None:
            old.cancel()
        # EVERY authorized track gets a pump (frames are read locally); only the ACTIVE source's frames reach STT.
        self.pumps[ident] = self._spawn(self._pump_audio(ident, track))
        self._request_reselect()

    @staticmethod
    def _is_mic_audio(pub: Any) -> bool:
        return _track_kind(pub) == "audio" and _source(pub) == "microphone"

    def _on_unsubscribed(self, pub: Any, p: Any) -> None:
        if self._is_mic_audio(pub):
            self._drop_source(p.identity)

    def _on_unpublished(self, pub: Any, p: Any) -> None:
        if self._is_mic_audio(pub):
            self._drop_source(p.identity)

    def _on_mute(self, p: Any, pub: Any, muted: bool) -> None:
        if p.identity in self.selector.sources and self._is_mic_audio(pub):
            self.selector.set_muted(p.identity, muted)
            self._request_reselect()

    def _drop_source(self, identity: str) -> None:
        """The track / participant is gone: forget it and RESCAN (the other partner must not stay ignored forever)."""
        t = self.pumps.pop(identity, None)
        if t is not None:
            t.cancel()
        if self.selector.remove(identity):
            self._request_reselect()

    def _request_reselect(self) -> None:
        if self.closing:
            return
        self._last_resel = time.monotonic()
        self._spawn(self.reselect())

    def _maybe_reselect(self, now: float) -> None:
        if now - self._last_resel >= RESELECT_MIN_INTERVAL_S:
            self._request_reselect()

    async def reselect(self) -> None:
        async with self.sel_lock:
            if self.closing:
                return
            await self._reselect_locked()

    async def _reselect_locked(self) -> None:
        now = time.monotonic()
        sw = self.selector.reselect(now)
        if sw is None:
            return
        # The open turn belongs to the PREVIOUS speaker: close it with what was heard so it can never be
        # mixed with the next speaker's words, then restart STT for the new source.
        pending = self.adapter.flush()
        await self._close_stt("source_switch")
        if pending is not None:
            await self.send(TOPIC_TRANSCRIPT, pending.to_dict())
        self.preroll.drain()
        self.wake.reset()
        self.watchdog.set_source_active(sw.new is not None, now)
        if sw.new is not None and self.listening:
            self._open_stt()
        log_event(evt="source_switch", reason=sw.reason, status="none" if sw.new is None else "active")

    # ---------------- STT lifecycle (billed by connected duration)
    def _open_stt(self) -> Any:
        if self.stt_stream is not None or self.closing:
            return None
        s = self.stt.stream()
        self.stt_stream = s
        self.stt_meter.opened(time.monotonic())  # A10: billing starts when the socket connects
        self.adapter.closed = True  # new stream -> new turn ids continue monotonically
        self.stt_events = 0
        self.stt_task = asyncio.create_task(self._consume_stt(s))
        log_event(evt="stt_open")
        return s

    async def _close_stt(self, reason: str) -> None:
        s, self.stt_stream = self.stt_stream, None
        task, self.stt_task = self.stt_task, None
        if s is None:
            return
        self.stt_meter.closed(time.monotonic())  # A10
        try:
            s.end_input()
            await asyncio.wait_for(s.aclose(), timeout=3)
        except Exception:  # noqa: BLE001
            pass
        if task is not None and task is not asyncio.current_task():
            task.cancel()
        log_event(evt="stt_close", reason=reason)

    def _silence(self, frame: Any) -> Any:
        from livekit import rtc

        return rtc.AudioFrame(bytes(len(frame.data) * 2), frame.sample_rate, frame.num_channels, frame.samples_per_channel)

    async def _pump_audio(self, identity: str, track: Any) -> None:
        from livekit import rtc

        stream = rtc.AudioStream(track, sample_rate=STT_SAMPLE_RATE, num_channels=1)
        try:
            async for ev in stream:
                self._on_frame(identity, ev.frame)
        finally:
            await stream.aclose()

    def _on_frame(self, identity: str, frame: Any) -> None:
        """One 10 ms frame from ONE authorized track. Decides: ignore / feed selector / send to STT / wake detector."""
        now = time.monotonic()
        # B6 echo safety (ALL modes, architecture rule 5): while our synthesized voice plays — from this worker or
        # from the owner's device during HTTP-TTS fallback — plus a mode-aware tail, our own output is never
        # treated as partner input (no STT, no selector activity, no wake).
        silenced = self.echo.should_silence(now, gate_phase_speaking=self.gate.phase == "speaking")
        voiced = False if silenced else frame_rms(frame.data) >= VOICE_RMS
        if voiced:
            self.selector.voice(identity, now)
        if identity != self.selector.active:
            if voiced:
                self._maybe_reselect(now)  # a challenger spoke: maybe the incumbent went stale
            return
        s = self.stt_stream
        if s is not None:
            s.push_frame(self._silence(frame) if silenced else frame)
            return
        # No billed stream. Only an IDLE pause with an active source may wake on voice (user/error pauses never do).
        if not self.listening and self.watchdog.pause_reason == "idle" and self.watchdog.source_active and not self.closing:
            if silenced:
                self.wake.reset()
                self.preroll.drain()
                return
            self.preroll.add(frame, now)
            if self.wake.feed(frame_rms(frame.data), now) and (self.wake_task is None or self.wake_task.done()):
                self.wake_task = self._spawn(self._wake())

    async def _wake(self) -> None:
        """C #24: voice resumed after an IDLE pause -> reopen STT and replay the short in-memory pre-roll."""
        async with self.sel_lock:
            frames = self.preroll.drain()
            if self.closing or self.listening or self.watchdog.pause_reason != "idle" or self.selector.active is None:
                return
            self.wake.reset()
            self.listening = True
            self.watchdog.set_listening(True, time.monotonic())
            s = self._open_stt()
            if s is not None:
                for f in frames:
                    s.push_frame(f)
        await self.status("listening")
        log_event(evt="wake_on_voice")

    async def _consume_stt(self, s: Any) -> None:
        from livekit.agents import stt as lkstt

        kinds = {
            lkstt.SpeechEventType.START_OF_SPEECH: "start",
            lkstt.SpeechEventType.INTERIM_TRANSCRIPT: "interim",
            lkstt.SpeechEventType.PREFLIGHT_TRANSCRIPT: "preflight",
            lkstt.SpeechEventType.FINAL_TRANSCRIPT: "final",
        }
        failure: str | None = None
        try:
            async for ev in s:
                if s is self.stt_stream:
                    self.stt_events += 1
                    self.backoff.healthy()  # the provider is delivering: forget earlier failures
                k = kinds.get(ev.type)
                if not k:
                    continue
                text = ev.alternatives[0].text if ev.alternatives else ""
                msg = self.adapter.on_event(k, text)  # type: ignore[arg-type]
                if msg is None:
                    continue
                self.watchdog.partner_audio(time.monotonic())
                await self.send(TOPIC_TRANSCRIPT, msg.to_dict())
            if s is self.stt_stream and not self.closing:
                failure = "StreamEnded"  # the provider closed the stream under us (we did not close it)
        except asyncio.CancelledError:
            return
        except Exception as e:  # noqa: BLE001
            failure = type(e).__name__
        if failure is not None and s is self.stt_stream and not self.closing:
            await self._on_stt_failure(s, failure)

    async def _on_stt_failure(self, s: Any, code: str) -> None:
        """C #25: a dead socket is no longer billed; recover with bounded backoff instead of staying deaf."""
        log_event(evt="stt_error", code=code)
        if self.stt_stream is s:
            self.stt_stream = None
            self.stt_task = None
            self.stt_meter.closed(time.monotonic())  # A10
        self.adapter.closed = True
        if not self.recovering:
            self.recover_task = self._spawn(self._recover_stt())

    async def _recover_stt(self) -> None:
        if self.recovering or self.closing:
            return
        self.recovering = True
        try:
            while True:
                if self.closing or not self.listening or self.selector.active is None:
                    return
                delay = self.backoff.next_delay()
                if delay is None:
                    async with self.sel_lock:
                        self.listening = False
                        self.watchdog.set_listening(False, time.monotonic(), "error")  # needs an explicit Resume
                        self.preroll.drain()
                        self.wake.reset()
                    log_event(evt="stt_gave_up", reason="stt_failed")
                    await self.status("paused", reason="stt_failed")
                    return
                await self.status("reconnecting", reason=f"stt_retry_{self.backoff.attempts}_of_{self.backoff.max_attempts}")
                await self.sleep(delay)
                async with self.sel_lock:
                    if self.closing or not self.listening or self.selector.active is None:
                        return
                    stream = self._open_stt()
                if stream is None:
                    return  # someone else (an explicit Resume) already reopened it
                if await self._wait_healthy(stream):
                    self.backoff.healthy()
                    await self.status("listening")
                    return
        finally:
            self.recovering = False

    async def _wait_healthy(self, stream: Any) -> bool:
        waited = 0.0
        while waited < HEALTHY_AFTER_S:
            if self.closing or self.stt_stream is not stream:
                return False
            if self.stt_events > 0:
                return True
            await self.sleep(0.25)
            waited += 0.25
        return not self.closing and self.stt_stream is stream

    # ---------------- control (owner only) — C #21: strictly ordered, Stop overtakes
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
        if t == "stop":
            # Handled SYNCHRONOUSLY, never queued behind the Speak it cancels: the attempt is tombstoned (or the running
            # synthesis cancelled) before any queued Speak can be admitted.
            try:
                aid = StopControl.model_validate(raw).playbackAttemptId
            except ValidationError:
                return
            cur = self._stop_now(aid)
            self._spawn(self._announce_stop(cur, aid))
        elif t in ("speak", "listen", "end", "hello", "gate", "generation"):
            try:
                self.ctl_queue.put_nowait((t, raw))
            except asyncio.QueueFull:
                log_event(evt="control_queue_full", kind=str(t))
                if t == "speak":
                    self._spawn(self.status("rejected", attempt=_attempt_of(raw), reason="busy"))

    async def _control_loop(self) -> None:
        """The ONE consumer of the owner's non-Stop controls: speak/listen/end are handled in arrival order."""
        while not self.closing:
            t, raw = await self.ctl_queue.get()
            try:
                await self._handle_control(t, raw)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — one bad control must never kill the consumer
                log_event(evt="control_error", kind=str(t), code=type(e).__name__)

    async def _handle_control(self, t: str, raw: dict) -> None:
        if t == "speak":
            await self._speak(raw)
        elif t == "listen":
            try:
                enabled = ListenControl.model_validate(raw).enabled
            except ValidationError:
                return
            await self._set_listening(enabled)
        elif t == "end":
            await self.end("user")
        elif t == "hello":
            # B5: presence probe from the owner device. Answer only once fully set up.
            if self.source is not None and not self.closing:
                await self.status("ready")
        elif t == "generation":
            try:
                gen = GenerationControl.model_validate(raw).generation
            except ValidationError:
                return
            await self._bump_generation(gen)
        elif t == "gate":
            try:
                g = GateControl.model_validate(raw)
            except ValidationError:
                return
            self.echo.owner_gate(g.on, time.monotonic(), g.ttlMs)
            log_event(evt="owner_gate", status="on" if g.on else "off")

    async def _bump_generation(self, generation: int) -> None:
        """F: reconnect => NEW generation. MONOTONIC (a replayed/lower value is ignored). Approvals signed for the old
        generation are refused by the gate (`stale_generation`) and turn ids restart so old candidates go stale.
        The web app only signs approvals for the generation it issued, so a lying owner device cannot approve anything."""
        cur = self.gate.expect.generation
        if generation <= cur or generation > cur + 50:
            log_event(evt="generation_ignored", status="stale" if generation <= cur else "jump")
            return
        # An utterance that is still playing was approved for the OLD generation: stop it, never replay it.
        if self.gate.current is not None:
            cur_attempt = self._stop_now(None)
            self._spawn(self._announce_stop(cur_attempt, None))
        self.gate.bump_generation(generation)
        self.adapter.reset(generation)
        log_event(evt="generation_bump", status="ok")
        await self.status("listening" if self.listening else "paused", reason=None if self.listening else "user")

    async def _speak(self, raw: dict) -> None:
        try:
            ctl = SpeakControl.model_validate(raw)
        except ValidationError:
            await self.status("rejected", attempt=_attempt_of(raw), reason="malformed")
            return
        aid = ctl.approval.playbackAttemptId
        if len(ctl.text) > MAX_SPOKEN_CHARS:
            await self.status("rejected", attempt=aid, reason="too_long")
            return
        try:
            attempt = await self.gate.admit(ctl.approval, ctl.text)
        except ApprovalRejected as e:
            log_event(evt="approval_rejected", reason=e.reason)
            # A1: nothing was synthesized → release the approval-time reservation. Not for forged/malformed
            # approvals (their id is untrusted); the durable sweep still settles those rows.
            if e.reason not in ("bad_signature", "malformed"):
                self._report_tts(ctl.approval.approvalId, 0)
            if e.reason == "cancelled":
                await self.status("cancelled", attempt=aid)  # the owner already pressed Stop for this exact attempt
            else:
                await self.status("rejected", attempt=aid, reason=e.reason)
            if e.reason == "session_char_cap":
                await self.status("paused", reason="budget")
            return
        self.speak_task = asyncio.create_task(self._synthesize(attempt))

    async def _synthesize(self, attempt: Any) -> None:
        t0 = time.monotonic()
        sent = False  # A1: once the exact text is sent to the provider it is billed (conservative)
        failed_before_audio = False
        try:
            # Voice/language are fixed per TTS session: changing them retires pooled sockets
            # (a newly configured session), never a mid-session switch.
            if attempt.voice_id != self.voice or attempt.language != self.language:
                self.tts.update_options(voice=attempt.voice_id, language=attempt.language)
                self.voice, self.language = attempt.voice_id, attempt.language
            self.echo.start_speaking()
            await self.status("speaking", attempt=attempt.attempt_id)
            first = True
            sent = True
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
            failed_before_audio = outcome == "error"  # provider errors before first audio are not billed
            log_event(evt="tts_failed", attempt=attempt.attempt_id, code=type(e).__name__, status=outcome)
            if outcome:
                # 'uncertain' = some audio may have been heard. NEVER replayed automatically.
                await self.status(outcome, attempt=attempt.attempt_id, reason="synthesis_failed")
        finally:
            # A1: exactly one usage report per approval — done, cancelled or failed.
            self._report_tts(attempt.approval_id, attempt.chars if sent and not failed_before_audio else 0)

    def _stop_now(self, attempt_id: str | None) -> Any:
        """Synchronous half of Stop. Cancels the CURRENT attempt only when the Stop targets it (or names none); a Stop
        for another attempt tombstones that one and never disturbs the speech that is playing."""
        cur = self.gate.stop(attempt_id)
        if cur is not None:
            if self.speak_task and not self.speak_task.done():
                self.speak_task.cancel()  # cancels server synthesis (socket request aborted)
            if self.source:
                self.source.clear_queue()  # drop queued device audio immediately
            self.echo.stop_speaking(time.monotonic())
            log_event(evt="tts_stop", attempt=cur.attempt_id)
        return cur

    async def _announce_stop(self, cur: Any, attempt_id: str | None) -> None:
        if cur is not None:
            await self.status("cancelled", attempt=cur.attempt_id)
        elif attempt_id:
            await self.status("cancelled", attempt=attempt_id)  # acknowledge a pre-cancel (its Speak is refused later)

    async def _stop(self, attempt_id: str | None) -> None:
        await self._announce_stop(self._stop_now(attempt_id), attempt_id)

    async def _set_listening(self, enabled: bool) -> None:
        async with self.sel_lock:
            now = time.monotonic()
            self.listening = enabled
            self.watchdog.set_listening(enabled, now, "user")
            if enabled:
                self.backoff.healthy()  # an explicit Resume starts with a fresh recovery budget
                if self.selector.active is not None:
                    self._open_stt()
            else:
                self.preroll.drain()
                self.wake.reset()
                await self._close_stt("paused")  # disconnecting (not muting) stops session billing
        if enabled:
            await self.status("listening")
        else:
            await self.status("paused", reason="user")

    async def _idle_pause(self) -> None:
        """C #24: idle (nobody talked for IDLE_NO_AUDIO_S while a source was active). Closes the billed stream but keeps
        reading frames locally so the partner's next words wake us up (see _on_frame / _wake)."""
        async with self.sel_lock:
            now = time.monotonic()
            self.listening = False
            self.watchdog.set_listening(False, now, "idle")
            self.preroll.drain()
            self.wake.reset()
            await self._close_stt("idle")
        await self.status("paused", reason="idle")

    # ---------------- participants & phone binding
    def _on_joined(self, p: Any) -> None:
        if p.identity == self.meta.ownerIdentity:
            self.watchdog.owner_returned()
            # B5: the owner may have connected after our initial `ready` (which then went nowhere).
            if self.source is not None and not self.closing:
                self._spawn(self.status("ready"))
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
            self._consider(pub, p)  # phone priority (3) then takes the stream over from any partner/tabletop source

    def _on_left(self, p: Any) -> None:
        now = time.monotonic()
        if p.identity == self.meta.ownerIdentity:
            self.watchdog.owner_left(now)
        self._drop_source(p.identity)  # rescan: whoever remains is selected (the phone hanging up falls back)
        if p.identity == self.bound_phone:
            used = self.watchdog.phone_minutes_used(now)
            self.watchdog.phone_ended()
            self.bound_phone = None
            self._spawn(_post_app(self.env, "/api/phone/usage", {"room": self.ctx.room.name, "minutes": round(used, 2)}))
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
            await self.sleep(WATCHDOG_TICK_S)
            if self.stt_meter.heartbeat_due(time.monotonic()):
                self._spawn(self._report_session(final=False))  # A10 heartbeat (sweep fallback)
            await self.reselect()  # periodic re-evaluation (stale supersede, lost events)
            r = self.watchdog.check(time.monotonic())
            if r is None:
                continue
            if r == "idle_pause":
                await self._idle_pause()
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
        me = asyncio.current_task()
        for t in [*self.pumps.values(), self.ctl_task, self.wake_task, self.recover_task]:
            if t is not None and t is not me and not t.done():
                t.cancel()
        self.pumps.clear()
        await self._close_stt(reason)
        await self._hang_up_phone()
        # A10: authoritative final usage — connected STT minutes settle the room's reservation on any instance.
        try:
            await asyncio.wait_for(self._report_session(final=True), timeout=10)
        except Exception:  # noqa: BLE001 — the sweep commits the last heartbeat (+1 min) if this never lands
            pass
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
    tts: Any = None
    # D #45: EVERYTHING after this point is inside the try/finally. The wait for the caller used to sit above it, so when
    # nobody connected within CALL_CONNECT_TIMEOUT_S the TimeoutError escaped before cleanup began, the job crashed and the
    # call room was never deleted (it lingered, and a late caller could be dropped into an unattended room).
    try:
        try:
            caller = await asyncio.wait_for(
                ctx.wait_for_participant(kind=rtc.ParticipantKind.PARTICIPANT_KIND_SIP), timeout=CALL_CONNECT_TIMEOUT_S
            )
        except asyncio.TimeoutError:
            log_event(evt="phone_no_caller", seconds=CALL_CONNECT_TIMEOUT_S)
            return  # the finally below deletes the call room
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
        # Each cleanup step is independent: a failing TTS close must not stop the room from being deleted.
        if tts is not None:
            try:
                await tts.aclose()
            except Exception:  # noqa: BLE001
                pass
        try:
            await ctx.delete_room()
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------- entrypoint

def parse_meta(raw: str | None) -> RoomMeta | None:
    """Parse the dispatch metadata. Anything malformed (or the legacy shape without `ownerSub`) is refused."""
    if not raw:
        return None
    try:
        return RoomMeta.model_validate_json(raw)
    except ValidationError:
        return None


def is_owner_room_name(name: str) -> bool:
    return name.startswith("rv-")


async def entrypoint(ctx: Any) -> None:
    from livekit.agents import AutoSubscribe

    assert_safe_defaults()
    env = load_env()
    if not env.assembly_key or not env.approval_secret:
        raise RuntimeError("ASSEMBLYAI_API_KEY is required, plus REVOICE_APPROVAL_SECRET or LIVEKIT_API_SECRET (approval secret is derived from it)")
    # Subscribe to nothing by default: each track is authorized individually.
    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_NONE)
    # B16: configuration comes from the dispatch metadata (server-issued, job-private), NEVER from room metadata.
    meta = parse_meta(getattr(getattr(ctx, "job", None), "metadata", None))
    if meta is None:
        # No dispatch config => not an owner room. Only phone call rooms are allowed here.
        if ctx.room.name.startswith("call-"):
            await run_call_room(ctx, env)
        else:
            log_event(evt="room_refused", reason="no_dispatch_metadata")
        return
    if not is_owner_room_name(ctx.room.name):
        log_event(evt="room_refused", reason="bad_room_name")
        return
    gate = SpeechGate(
        secret=env.approval_secret,
        expect=Expectation(meta.ownerSub, meta.conversationId, ctx.room.name, meta.generation),  # approvals are signed for the USER id
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
