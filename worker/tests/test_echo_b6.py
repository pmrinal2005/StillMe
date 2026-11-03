"""B6 regression: the worker never transcribes its own synthesized output as partner input (rule 5).

Previously partner audio was silenced only in *tabletop* mode. In partner-link mode the owner's device
also played the voice next to the partner's phone, and the partner mic re-captured it.
"""
from __future__ import annotations

import pytest

from revoice_worker.echo import OWNER_GATE_MAX_S, EchoGate, echo_tail_s


@pytest.mark.parametrize("mode", ["tabletop", "partner-link", "remote"])
def test_partner_audio_silenced_while_worker_speaks_in_every_mode(mode: str) -> None:
    g = EchoGate(mode=mode)
    assert not g.should_silence(100.0)
    g.start_speaking()
    assert g.should_silence(100.0)
    # The SpeechGate phase alone also silences (covers the window before synthesis starts).
    assert EchoGate(mode=mode).should_silence(100.0, gate_phase_speaking=True)


def test_echo_tail_is_mode_aware_and_matches_web_constants() -> None:
    # Must mirror src/lib/audio-routing.ts echoTailMs()
    assert echo_tail_s("tabletop") == 0.35
    assert echo_tail_s("partner-link") == 0.8
    assert echo_tail_s("remote") == 0.8


def test_tail_after_speech_then_released() -> None:
    g = EchoGate(mode="partner-link")
    g.start_speaking()
    g.stop_speaking(now=10.0)
    assert g.should_silence(10.5)  # network playout tail
    assert not g.should_silence(10.81)


def test_owner_fallback_gate_silences_until_off_plus_tail() -> None:
    """B5 HTTP-TTS fallback plays on the owner device: the worker must still gate partner STT."""
    g = EchoGate(mode="partner-link")
    g.owner_gate(True, now=0.0, ttl_ms=60_000)
    assert g.should_silence(30.0)
    g.owner_gate(False, now=31.0)
    assert g.should_silence(31.5)
    assert not g.should_silence(32.0)


def test_owner_gate_is_bounded_so_a_lost_off_cannot_mute_the_partner_forever() -> None:
    g = EchoGate(mode="remote")
    g.owner_gate(True, now=0.0, ttl_ms=10_000_000)
    assert g.should_silence(OWNER_GATE_MAX_S - 1)
    assert not g.should_silence(OWNER_GATE_MAX_S + 1)
    g2 = EchoGate()
    g2.owner_gate(True, now=0.0)  # default TTL
    assert g2.should_silence(59.0)
    assert not g2.should_silence(61.0)


def test_main_module_no_longer_restricts_echo_gate_to_tabletop() -> None:
    import pathlib

    src = (pathlib.Path(__file__).resolve().parents[1] / "revoice_worker" / "main.py").read_text()
    assert 'self.meta.mode == "tabletop" and' not in src
    assert "self.echo.should_silence(" in src
    assert 't == "hello"' in src and 't == "gate"' in src  # B5 presence probe + B6 owner gate
