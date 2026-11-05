"""A1 / A10 metering: connected STT minutes, agent minutes, one TTS report per approval."""
from revoice_worker.usage import AgentMeter, SttMeter, TtsLedger, agent_report, stt_report, tts_ref


def test_stt_meter_counts_only_connected_time_across_pause_resume():
    m = SttMeter()
    m.opened(0)
    m.closed(90)  # 1.5 min connected
    # paused for 10 minutes: not billed
    m.opened(690)
    m.closed(720)  # +0.5 min
    assert m.connected_s(10_000) == 120
    assert m.minutes(10_000) == 2.0
    assert m.billed_minutes(10_000) == 2


def test_stt_meter_live_interval_and_rounding_up():
    m = SttMeter()
    m.opened(100)
    assert m.billed_minutes(100) == 0
    assert m.billed_minutes(101) == 1  # started minute is billed
    assert m.billed_minutes(160) == 1
    assert m.billed_minutes(161) == 2


def test_stt_meter_never_connected_is_zero_and_double_open_is_idempotent():
    m = SttMeter()
    assert m.billed_minutes(1e6) == 0
    m.opened(0)
    m.opened(50)  # second open while open must not reset the start
    m.closed(60)
    m.closed(500)  # second close is a no-op
    assert m.connected_s(1e6) == 60


def test_heartbeat_cadence():
    m = SttMeter()
    assert m.heartbeat_due(0) is True
    assert m.heartbeat_due(30) is False
    assert m.heartbeat_due(60) is True


def test_reports_are_content_free_and_shaped_for_api_worker_usage():
    m = SttMeter()
    m.opened(0)
    m.closed(30)
    r = stt_report("rv-" + "a" * 24, m, 100, final=True)
    assert r == {"kind": "stt", "room": "rv-" + "a" * 24, "minutes": 0.5, "final": True}
    a = agent_report("rv-" + "a" * 24, "user-1", AgentMeter(started_at=0), 120)
    assert a == {"kind": "agent", "room": "rv-" + "a" * 24, "owner": "user-1", "minutes": 2.0}


def test_tts_ledger_reports_once_per_approval():
    t = TtsLedger()
    assert t.report("a" * 32, 12) == {"kind": "tts", "approvalId": "a" * 32, "chars": 12}
    assert t.report("a" * 32, 12) is None  # done + finally must not double-report
    assert t.report("b" * 32, -5) == {"kind": "tts", "approvalId": "b" * 32, "chars": 0}
    assert t.report("", 3) is None


def test_tts_ref_matches_web_convention():
    # src/lib/spend-refs.ts: workerTtsRef = (id) => `tts:${id}`
    assert tts_ref("abc") == "tts:abc"
