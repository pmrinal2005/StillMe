"""C #22/#23 — source selector: priority takeover, stale supersede, rescan, phone takes over."""
from __future__ import annotations

from revoice_worker.sources import STALE_AFTER_S, SourceSelector, priority_for


def sel() -> SourceSelector:
    return SourceSelector()


def test_priorities():
    assert priority_for("phone_bound") > priority_for("partner") > priority_for("owner_tabletop") > priority_for("nope") == 0


def test_first_source_becomes_active():
    s = sel()
    s.add("p1", 2, 0)
    sw = s.reselect(0)
    assert sw and sw.new == "p1" and sw.old is None and s.active == "p1"
    assert s.reselect(1) is None  # stable


def test_silent_newcomer_never_steals_from_incumbent():
    s = sel()
    s.add("p1", 2, 0)
    s.reselect(0)
    s.voice("p1", 1)
    s.add("p2", 2, 5)
    assert s.reselect(6) is None and s.active == "p1"
    assert s.reselect(5 + STALE_AFTER_S + 100) is None  # p2 never spoke -> still not a challenger


def test_stale_incumbent_superseded_only_by_a_speaking_challenger():
    s = sel()
    s.add("p1", 2, 0)
    s.reselect(0)
    s.voice("p1", 1)
    s.add("p2", 2, 2)
    s.voice("p2", 30)
    assert s.reselect(10) is None  # p1 spoke 9s ago: not stale yet
    sw = s.reselect(1 + STALE_AFTER_S + 1)
    assert sw and sw.new == "p2" and sw.reason == "stale_supersede"


def test_muted_incumbent_is_superseded_by_unmuted_peer():
    s = sel()
    s.add("p1", 2, 0)
    s.reselect(0)
    s.add("p2", 2, 1)
    s.set_muted("p1", True)
    sw = s.reselect(2)
    assert sw and sw.new == "p2"
    s.set_muted("p1", False)
    assert s.reselect(3) is None  # p2 is now the incumbent, p1 is silent -> no flapping


def test_rescan_when_active_leaves_and_when_nothing_left():
    s = sel()
    s.add("p1", 2, 0)
    s.add("p2", 2, 1)
    s.reselect(2)
    first = s.active
    other = "p2" if first == "p1" else "p1"
    assert s.remove(first)
    sw = s.reselect(3)
    assert sw and sw.new == other and sw.old == first
    s.remove(other)
    sw = s.reselect(4)
    assert sw and sw.new is None and s.active is None


def test_phone_takes_over_immediately_and_hands_back_on_hangup():
    s = sel()
    s.add("partner", 2, 0)
    s.voice("partner", 5)
    s.reselect(5)
    s.add("sip", 3, 6)
    sw = s.reselect(6)
    assert sw and sw.new == "sip" and sw.reason == "priority_takeover"
    s.remove("sip")
    sw = s.reselect(7)
    assert sw and sw.new == "partner"


def test_priority_upgrade_of_existing_source_takes_over():
    s = sel()
    s.add("a", 2, 0)
    s.add("sip", 0, 0)  # SIP participant present but not yet bound
    s.reselect(1)
    assert s.active == "a"
    s.add("sip", 3, 2)  # now bound
    sw = s.reselect(2)
    assert sw and sw.new == "sip"


def test_owner_tabletop_loses_to_partner():
    s = sel()
    s.add("owner", 1, 0)
    s.reselect(0)
    s.add("partner", 2, 1)
    sw = s.reselect(1)
    assert sw and sw.new == "partner"


def test_drop_active_forces_rescan_without_removing():
    s = sel()
    s.add("p1", 2, 0)
    s.reselect(0)
    s.drop_active()
    sw = s.reselect(1)
    assert sw and sw.new == "p1"


def test_all_muted_still_picks_one():
    s = sel()
    s.add("p1", 2, 0)
    s.add("p2", 2, 0)
    s.set_muted("p1", True)
    s.set_muted("p2", True)
    assert s.best(1)[0] in ("p1", "p2")
