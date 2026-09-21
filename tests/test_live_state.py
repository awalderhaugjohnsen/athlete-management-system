"""Tests for services/scheduling/live_state.py — pure functions turning live scheduled_days-
shaped rows into solve_schedule() inputs for a check-in. No Supabase; hand-built row fixtures.
"""
from datetime import date, timedelta
from typing import Any

from services.scheduling.live_state import compute_checkin_fixed_days, resolve_today_pin
from services.scheduling.program_spec import ProgramSessionType, ProgramSpec

SPEC = ProgramSpec(
    session_types=[
        ProgramSessionType(key="strength-a", category=["leg-strength"], label="A", session_kind="strength", is_key=True),
        ProgramSessionType(key="strength-c", category=["upper-strength"], label="C", session_kind="strength", is_key=True),
        ProgramSessionType(key="tempo-run", category=["key-run"], label="Tempo", session_kind="run", is_key=True),
        ProgramSessionType(key="easy-run", category=["easy-run"], label="Easy", session_kind="run", is_key=False),
        ProgramSessionType(key="rest", category=["rest"], label="Rest", session_kind="rest"),
    ],
)


class TestResolveTodayPin:
    def test_no_scheduled_day_gives_no_pin(self):
        assert resolve_today_pin(date(2026, 8, 25), None, None, SPEC) == {}

    def test_strength_day_resolves_via_slot(self):
        today = date(2026, 8, 25)
        row = {"session_type": "strength", "is_key": True}
        pin = resolve_today_pin(today, row, {"slot": "A"}, SPEC)
        assert pin == {today: "strength-a"}

    def test_strength_day_with_no_slot_row_gives_no_pin(self):
        today = date(2026, 8, 25)
        row = {"session_type": "strength", "is_key": True}
        assert resolve_today_pin(today, row, None, SPEC) == {}

    def test_strength_day_with_unknown_slot_gives_no_pin(self):
        today = date(2026, 8, 25)
        row = {"session_type": "strength", "is_key": True}
        assert resolve_today_pin(today, row, {"slot": "Z"}, SPEC) == {}

    def test_key_run_resolves_unambiguously(self):
        today = date(2026, 8, 25)
        row = {"session_type": "run", "is_key": True}
        assert resolve_today_pin(today, row, None, SPEC) == {today: "tempo-run"}

    def test_easy_run_resolves_unambiguously(self):
        today = date(2026, 8, 25)
        row = {"session_type": "run", "is_key": False}
        assert resolve_today_pin(today, row, None, SPEC) == {today: "easy-run"}

    def test_rest_day_resolves(self):
        today = date(2026, 8, 25)
        row = {"session_type": "rest", "is_key": False}
        assert resolve_today_pin(today, row, None, SPEC) == {today: "rest"}


class TestComputeCheckinFixedDays:
    """existing_scheduled_days is keyed by (date, time_slot) — 'day' is the unslotted,
    single-session-per-date convention (migration 045's default), used by every fixture here
    unless a test is specifically exercising allow_multi_session_days.
    """

    def _window(self):
        return [date(2026, 8, 24) + timedelta(days=i) for i in range(7)]

    def test_existing_days_carried_forward(self):
        window = self._window()
        existing: dict[tuple[date, str], dict[str, Any]] = {
            (window[0], "day"): {"session_type": "strength", "slot": "A"},
            (window[1], "day"): {"session_type": "run", "is_key": True},
        }
        fixed, fixed_slots = compute_checkin_fixed_days(window, existing, {}, SPEC)
        assert fixed == {window[0]: "strength-a", window[1]: "tempo-run"}
        assert fixed_slots == {}

    def test_override_wins_over_existing(self):
        window = self._window()
        existing = {(window[0], "day"): {"session_type": "strength", "slot": "A"}}
        overrides = {window[0]: "strength-c"}
        fixed, fixed_slots = compute_checkin_fixed_days(window, existing, overrides, SPEC)
        assert fixed == {window[0]: "strength-c"}
        assert fixed_slots == {}

    def test_override_outside_window_ignored(self):
        window = self._window()
        outside = date(2027, 1, 1)
        fixed, fixed_slots = compute_checkin_fixed_days(window, {}, {outside: "rest"}, SPEC)
        assert fixed == {}
        assert fixed_slots == {}

    def test_override_with_unknown_key_ignored(self):
        window = self._window()
        fixed, _fixed_slots = compute_checkin_fixed_days(window, {}, {window[0]: "not-a-real-key"}, SPEC)
        assert fixed == {}

    def test_new_tail_date_with_no_existing_row_left_undecided(self):
        window = self._window()
        fixed, fixed_slots = compute_checkin_fixed_days(window, {}, {}, SPEC)
        assert fixed == {}
        assert fixed_slots == {}

    def test_ambiguous_existing_row_left_undecided(self):
        # Two session types share session_kind='run', is_key=False? No — SPEC only has one
        # easy-run type; build a spec with a genuine ambiguity for this test.
        ambiguous_spec = ProgramSpec(
            session_types=[
                ProgramSessionType(key="easy-run-1", category=["a"], label="A", session_kind="run", is_key=False),
                ProgramSessionType(key="easy-run-2", category=["b"], label="B", session_kind="run", is_key=False),
            ],
        )
        window = self._window()
        existing = {(window[0], "day"): {"session_type": "run", "is_key": False}}
        fixed, _fixed_slots = compute_checkin_fixed_days(window, existing, {}, ambiguous_spec)
        assert fixed == {}

    def test_multi_session_days_puts_existing_rows_into_slot_pins_not_whole_day(self):
        """The actual fix: under allow_multi_session_days, an existing committed session must
        NOT become a whole-day pin — that would block the solver from placing anything else on
        the same date, silently defeating the point of turning the flag on.
        """
        multi_spec = ProgramSpec(session_types=SPEC.session_types, allow_multi_session_days=True)
        window = self._window()
        existing = {(window[0], "morning"): {"session_type": "strength", "slot": "A"}}
        fixed, fixed_slots = compute_checkin_fixed_days(window, existing, {}, multi_spec)
        assert fixed == {}
        assert fixed_slots == {(window[0], "morning"): "strength-a"}

    def test_multi_session_days_override_is_still_whole_day(self):
        """An override is always whole-day intent (the translation has no time_slot concept) —
        even under allow_multi_session_days it goes into pinned_events, not pinned_slot_events,
        so it correctly displaces every existing slot on that date.
        """
        multi_spec = ProgramSpec(session_types=SPEC.session_types, allow_multi_session_days=True)
        window = self._window()
        existing = {(window[0], "morning"): {"session_type": "strength", "slot": "A"}}
        overrides = {window[0]: "rest"}
        fixed, fixed_slots = compute_checkin_fixed_days(window, existing, overrides, multi_spec)
        assert fixed == {window[0]: "rest"}
        assert fixed_slots == {}
