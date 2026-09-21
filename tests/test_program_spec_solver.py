"""Tests for the generic, athlete-agnostic scheduler (services/scheduling/solver.py).

This replaces weekly_planner_node.py's approach of an LLM redrafting the whole
schedule each check-in plus hand-written, Adrian-specific patch functions
(_fix_weekly_volume, _fix_legs_before_hard_runs) that only see the current
window and have no memory of prior weeks' compromises. The flagship test here
(TestRealDisruptionScenario) reproduces the exact real-world check-in that
motivated this work: on 2026-08-25 (a Tuesday), Adrian did his "Monday"
strength session a day late and asked the coach to shift the plan to match.
The live system's response lost 3 of 18 required strength sessions over the
next 6 weeks and left 2 unresolved 48h leg-spacing violations (see memory
project_leg_spacing_structural_limit and the plan this shipped under). Feeding
the identical disruption through this solver, with the athlete's real weekday
preferences expressed as data instead of Python, produces a fully compliant
6-week schedule — zero shortfalls, zero spacing violations. That gap is the
whole point of this module: the old failures were an artifact of a weak, local,
greedy repair algorithm, not an inherent conflict in the athlete's own rules.
"""
from collections import Counter
from datetime import date, timedelta

import pytest

from services.scheduling.program_spec import (
    DayPin,
    ProgramSessionType,
    ProgramSpec,
    RestPolicy,
    SpacingConstraint,
    WeeklyTarget,
)
from services.scheduling.solver import solve_schedule


def adrians_real_spec(min_rest_days_per_week: int = 0) -> ProgramSpec:
    """Mirrors athlete_profile.recurring_session_requests as queried live.

    From the 2026-08-25 data: A/C strength carry legs, B doesn't; 5 must-run
    sessions/week split into 2 key (tempo, VO2max) + 2 easy + strides;
    simplified here to 2 key + 2 easy (strides isn't spacing-relevant).
    """
    return ProgramSpec(
        session_types=[
            ProgramSessionType(key="strength-a", category=["leg-strength"], label="A", session_kind="strength", is_key=True),
            ProgramSessionType(key="strength-b", category=["leg-strength"], label="B", session_kind="strength", is_key=True),
            ProgramSessionType(key="strength-c", category=["upper-strength"], label="C", session_kind="strength", is_key=True),
            ProgramSessionType(key="tempo-run", category=["key-run"], label="Tempo", session_kind="run", is_key=True),
            ProgramSessionType(key="vo2max-run", category=["key-run"], label="VO2max", session_kind="run", is_key=True),
            ProgramSessionType(key="easy-run", category=["easy-run"], label="Easy", session_kind="run"),
            ProgramSessionType(key="rest", category=["rest"], label="Rest", session_kind="rest"),
        ],
        weekly_targets=[
            WeeklyTarget(session_type_key="strength-a", min_per_week=1, max_per_week=1),
            WeeklyTarget(session_type_key="strength-b", min_per_week=1, max_per_week=1),
            WeeklyTarget(session_type_key="strength-c", min_per_week=1, max_per_week=1),
            WeeklyTarget(session_type_key="tempo-run", min_per_week=1, max_per_week=1),
            WeeklyTarget(session_type_key="vo2max-run", min_per_week=1, max_per_week=1),
            WeeklyTarget(session_type_key="easy-run", min_per_week=2, max_per_week=2),
        ],
        spacing_constraints=[
            # 24h, not the original 48h — see spec_bootstrap.py::build_deterministic_leg_spacing_constraint
            # for why the threshold moved (a 2026-08-26 research pass found 48h unvalidated).
            SpacingConstraint(from_category="leg-strength", to_category="key-run", min_gap_hours=24, direction="before"),
        ],
        day_pins=[
            DayPin(session_type_key="strength-a", day_of_week="monday", flexibility="preferred"),
            DayPin(session_type_key="strength-b", day_of_week="wednesday", flexibility="preferred"),
            DayPin(session_type_key="strength-c", day_of_week="friday", flexibility="preferred"),
            DayPin(session_type_key="tempo-run", day_of_week="thursday", flexibility="preferred"),
            DayPin(session_type_key="vo2max-run", day_of_week="sunday", flexibility="preferred"),
        ],
        rest_policy=RestPolicy(min_rest_days_per_week=min_rest_days_per_week),
        horizon_weeks=6,
    )


def spacing_violations(spec: ProgramSpec, assignments: dict[date, str]) -> list[tuple[date, date]]:
    leg_keys = {st.key for st in spec.session_types if "leg-strength" in st.category}
    key_run_keys = {st.key for st in spec.session_types if "key-run" in st.category}
    leg_days = sorted(d for d, k in assignments.items() if k in leg_keys)
    key_days = sorted(d for d, k in assignments.items() if k in key_run_keys)
    return [(leg, run) for leg in leg_days for run in key_days if run > leg and (run - leg).days * 24 < 24]


class TestRealDisruptionScenario:
    """The exact 2026-08-25 check-in, replayed through the new solver."""

    def _solve(self):
        spec = adrians_real_spec(min_rest_days_per_week=0)
        start = date(2026, 8, 25)  # the real check-in date, a Tuesday
        window = [start + timedelta(days=i) for i in range(42)]  # the real plan's 6-week window
        pinned = {start: "strength-a"}  # "did my Monday session today instead"
        return spec, window, solve_schedule(spec, window, pinned_events=pinned)

    def test_finds_a_feasible_schedule(self):
        _, _, result = self._solve()
        assert result.feasible

    def test_zero_spacing_violations(self):
        spec, _, result = self._solve()
        assert result.assignments is not None
        assert spacing_violations(spec, result.assignments) == []

    def test_zero_weekly_shortfalls_across_every_full_week(self):
        spec, window, result = self._solve()
        assert result.assignments is not None
        targets = {wt.session_type_key: wt.min_per_week for wt in spec.weekly_targets}
        for week_start in range(0, 42, 7):
            week_dates = window[week_start:week_start + 7]
            if week_dates[0].weekday() != 0:
                continue  # only check fully-contained Mon-Sun weeks
            counts = Counter(result.assignments[d] for d in week_dates)
            for key, min_required in targets.items():
                assert counts.get(key, 0) == min_required, f"{key} short in week of {week_dates[0]}"

    def test_honors_the_pinned_disruption(self):
        _, _, result = self._solve()
        assert result.assignments is not None
        assert result.assignments[date(2026, 8, 25)] == "strength-a"


class TestGenuineInfeasibility:
    """Real, provable conflicts — not artifacts of a weak search."""

    def test_seven_must_sessions_cannot_coexist_with_a_required_rest_day(self):
        spec = adrians_real_spec(min_rest_days_per_week=1)
        window = [date(2026, 8, 24) + timedelta(days=i) for i in range(7)]  # clean Mon-Sun week
        result = solve_schedule(spec, window)
        assert not result.feasible
        assert result.infeasible_reasons is not None
        assert any("rest_policy" in r for r in result.infeasible_reasons)

    def test_weekly_target_exceeding_window_length_is_infeasible(self):
        spec = ProgramSpec(
            session_types=[ProgramSessionType(key="x", category=["x"], label="X", session_kind="run")],
            weekly_targets=[WeeklyTarget(session_type_key="x", min_per_week=8, max_per_week=8)],
        )
        window = [date(2026, 8, 24) + timedelta(days=i) for i in range(7)]
        result = solve_schedule(spec, window)
        assert not result.feasible
        assert result.infeasible_reasons is not None
        assert any("weekly_target:x" in r for r in result.infeasible_reasons)

    def test_two_hard_pinned_days_too_close_together_is_infeasible(self):
        spec = ProgramSpec(
            session_types=[
                ProgramSessionType(key="leg", category=["leg"], label="Leg", session_kind="strength"),
                ProgramSessionType(key="key-run", category=["key-run"], label="Key Run", session_kind="run"),
            ],
            spacing_constraints=[
                SpacingConstraint(from_category="leg", to_category="key-run", min_gap_hours=48, direction="before")
            ],
        )
        window = [date(2026, 8, 24), date(2026, 8, 25)]  # Monday, Tuesday — 24h apart
        result = solve_schedule(
            spec, window, pinned_events={date(2026, 8, 24): "leg", date(2026, 8, 25): "key-run"}
        )
        assert not result.feasible
        assert result.infeasible_reasons is not None
        assert any("spacing" in r for r in result.infeasible_reasons)


class TestBasicFeasibility:
    def test_simple_well_formed_spec_is_satisfied(self):
        spec = ProgramSpec(
            session_types=[
                ProgramSessionType(key="strength", category=["strength"], label="Strength", session_kind="strength"),
                ProgramSessionType(key="easy-run", category=["easy-run"], label="Easy Run", session_kind="run"),
                ProgramSessionType(key="rest", category=["rest"], label="Rest", session_kind="rest"),
            ],
            weekly_targets=[
                WeeklyTarget(session_type_key="strength", min_per_week=2, max_per_week=2),
                WeeklyTarget(session_type_key="easy-run", min_per_week=3, max_per_week=3),
            ],
            rest_policy=RestPolicy(min_rest_days_per_week=1),
        )
        window = [date(2026, 8, 24) + timedelta(days=i) for i in range(7)]
        result = solve_schedule(spec, window)
        assert result.feasible
        assert result.assignments is not None
        counts = Counter(result.assignments.values())
        assert counts["strength"] == 2
        assert counts["easy-run"] == 3
        assert counts["rest"] >= 1

    def test_fixed_day_pin_is_always_honored(self):
        spec = ProgramSpec(
            session_types=[
                ProgramSessionType(key="class", category=["class"], label="Spin Class", session_kind="cross"),
                ProgramSessionType(key="rest", category=["rest"], label="Rest", session_kind="rest"),
            ],
            weekly_targets=[WeeklyTarget(session_type_key="class", min_per_week=1, max_per_week=1)],
            day_pins=[DayPin(session_type_key="class", day_of_week="tuesday", flexibility="fixed")],
        )
        window = [date(2026, 8, 24) + timedelta(days=i) for i in range(7)]
        result = solve_schedule(spec, window)
        assert result.feasible
        assert result.assignments is not None
        assert result.assignments[date(2026, 8, 25)] == "class"  # the Tuesday in that window

    def test_window_with_duplicate_dates_raises(self):
        spec = ProgramSpec(
            session_types=[ProgramSessionType(key="x", category=["x"], label="X", session_kind="run")],
        )
        with pytest.raises(ValueError):
            solve_schedule(spec, [date(2026, 8, 24), date(2026, 8, 24)])


class TestMultiTagCategorySpacing:
    """category became list-valued so one session type can carry several muscle-group tags
    (see services/scheduling/muscle_groups.py) — confirms the solver treats a SpacingConstraint
    as a membership check (either tag on the session type binds it), and that 48h is the real
    floor: solver.py's day-granularity math (gap = calendar-day-diff * 24) makes any threshold
    <=24h a no-op for two different dates, since the smallest achievable positive gap already
    clears it. This is the actual fix for 'what stops the coach scheduling chest right after
    chest' — see spec_bootstrap.py::build_deterministic_recovery_spacing_constraints.

    Both dates are supplied via pinned_events so the check is a direct, deterministic test of
    the spacing math itself (no weekly_targets/day_pin machinery needed to force placement).
    """

    def _spec(self, min_gap_hours: int) -> ProgramSpec:
        return ProgramSpec(
            session_types=[
                ProgramSessionType(key="strength-a", category=["chest", "legs"], label="A", session_kind="strength", is_key=True),
                ProgramSessionType(key="strength-c", category=["chest", "back"], label="C", session_kind="strength", is_key=True),
            ],
            spacing_constraints=[
                SpacingConstraint(from_category="chest", to_category="chest", min_gap_hours=min_gap_hours, direction="either"),
            ],
        )

    def test_24h_or_under_does_not_actually_block_adjacent_days(self):
        """Documents the pre-fix bug: a <=24h threshold is a mathematical no-op under
        day-granularity gap math, so both sessions can land on adjacent days.
        """
        monday, tuesday = date(2026, 8, 24), date(2026, 8, 25)
        result = solve_schedule(
            self._spec(min_gap_hours=24), [monday, tuesday],
            pinned_events={monday: "strength-a", tuesday: "strength-c"},
        )
        assert result.feasible

    def test_48h_blocks_two_chest_sessions_on_adjacent_days(self):
        monday, tuesday = date(2026, 8, 24), date(2026, 8, 25)
        result = solve_schedule(
            self._spec(min_gap_hours=48), [monday, tuesday],
            pinned_events={monday: "strength-a", tuesday: "strength-c"},
        )
        assert not result.feasible
        assert any("chest" in reason for reason in (result.infeasible_reasons or []))

    def test_48h_allows_two_chest_sessions_two_days_apart(self):
        monday, wednesday = date(2026, 8, 24), date(2026, 8, 26)
        result = solve_schedule(
            self._spec(min_gap_hours=48), [monday, wednesday],
            pinned_events={monday: "strength-a", wednesday: "strength-c"},
        )
        assert result.feasible


class TestMultiSessionPerDay:
    """allow_multi_session_days=True: more than one session can share a calendar day, and
    SpacingConstraint's gap-hours math becomes genuinely sub-day-resolution — the whole point
    of the time_slot model (see solver.py's module docstring for why the old day-granularity
    approximation made any spacing threshold at or below 24h a structural no-op).
    """

    def test_default_spec_never_populates_slot_assignments(self):
        spec = ProgramSpec(
            session_types=[ProgramSessionType(key="x", category=["x"], label="X", session_kind="run")],
        )
        assert spec.allow_multi_session_days is False
        window = [date(2026, 8, 24)]
        result = solve_schedule(spec, window)
        assert result.feasible
        assert result.assignments is not None
        assert result.slot_assignments is None

    def test_pinned_slot_events_requires_the_opt_in_flag(self):
        spec = ProgramSpec(
            session_types=[ProgramSessionType(key="x", category=["x"], label="X", session_kind="run")],
        )
        with pytest.raises(ValueError):
            solve_schedule(
                spec, [date(2026, 8, 24)],
                pinned_slot_events={(date(2026, 8, 24), "morning"): "x"},
            )

    def test_two_independent_same_day_sessions_are_placed(self):
        d = date(2026, 8, 24)
        spec = ProgramSpec(
            session_types=[
                ProgramSessionType(key="easy-run", category=["run-easy"], label="Easy", session_kind="run"),
                ProgramSessionType(key="strength", category=["leg-strength"], label="Strength", session_kind="strength"),
            ],
            day_pins=[
                DayPin(session_type_key="easy-run", fixed_date=d, time_slot="morning", flexibility="fixed"),
                DayPin(session_type_key="strength", fixed_date=d, time_slot="afternoon", flexibility="fixed"),
            ],
            allow_multi_session_days=True,
        )
        result = solve_schedule(spec, [d])
        assert result.feasible
        assert result.assignments is None
        assert result.slot_assignments is not None
        assert result.slot_assignments[(d, "morning")] == "easy-run"
        assert result.slot_assignments[(d, "afternoon")] == "strength"

    def test_spacing_constraint_violated_by_slots_too_close_within_a_day(self):
        # morning=7h, midday=12h -> 5h apart, under a 6h floor.
        d = date(2026, 8, 24)
        spec = ProgramSpec(
            session_types=[
                ProgramSessionType(key="strength", category=["leg-strength"], label="S", session_kind="strength"),
                ProgramSessionType(key="run", category=["key-run"], label="R", session_kind="run", is_key=True),
            ],
            spacing_constraints=[
                SpacingConstraint(from_category="leg-strength", to_category="key-run", min_gap_hours=6, direction="before"),
            ],
            day_pins=[
                DayPin(session_type_key="strength", fixed_date=d, time_slot="morning", flexibility="fixed"),
                DayPin(session_type_key="run", fixed_date=d, time_slot="midday", flexibility="fixed"),
            ],
            allow_multi_session_days=True,
        )
        result = solve_schedule(spec, [d])
        assert not result.feasible
        assert result.infeasible_reasons is not None
        assert any("spacing" in r for r in result.infeasible_reasons)

    def test_spacing_constraint_satisfied_by_slots_far_enough_apart_within_a_day(self):
        # morning=7h, afternoon=15h -> 8h apart, clears a 6h floor.
        d = date(2026, 8, 24)
        spec = ProgramSpec(
            session_types=[
                ProgramSessionType(key="strength", category=["leg-strength"], label="S", session_kind="strength"),
                ProgramSessionType(key="run", category=["key-run"], label="R", session_kind="run", is_key=True),
            ],
            spacing_constraints=[
                SpacingConstraint(from_category="leg-strength", to_category="key-run", min_gap_hours=6, direction="before"),
            ],
            day_pins=[
                DayPin(session_type_key="strength", fixed_date=d, time_slot="morning", flexibility="fixed"),
                DayPin(session_type_key="run", fixed_date=d, time_slot="afternoon", flexibility="fixed"),
            ],
            allow_multi_session_days=True,
        )
        result = solve_schedule(spec, [d])
        assert result.feasible
        assert result.slot_assignments is not None
        assert result.slot_assignments[(d, "morning")] == "strength"
        assert result.slot_assignments[(d, "afternoon")] == "run"

    def test_weekly_target_counts_across_all_slots_of_a_day(self):
        # Two easy-run sessions the same day (morning + evening) should count as 2 toward a
        # weekly target of 2, in a week with no other run days.
        monday = date(2026, 8, 24)
        window = [monday + timedelta(days=i) for i in range(7)]
        spec = ProgramSpec(
            session_types=[
                ProgramSessionType(key="easy-run", category=["run-easy"], label="Easy", session_kind="run"),
                ProgramSessionType(key="rest", category=["rest"], label="Rest", session_kind="rest"),
            ],
            weekly_targets=[WeeklyTarget(session_type_key="easy-run", min_per_week=2, max_per_week=2)],
            day_pins=[
                DayPin(session_type_key="easy-run", fixed_date=monday, time_slot="morning", flexibility="fixed"),
                DayPin(session_type_key="easy-run", fixed_date=monday, time_slot="evening", flexibility="fixed"),
            ],
            allow_multi_session_days=True,
        )
        result = solve_schedule(spec, window)
        assert result.feasible
        assert result.slot_assignments is not None
        week_easy_runs = sum(
            1 for (d, _slot), key in result.slot_assignments.items()
            if monday <= d < monday + timedelta(days=7) and key == "easy-run"
        )
        assert week_easy_runs == 2

    def test_rest_day_requires_every_slot_free_not_just_one(self):
        # A day with even one real (non-rest) session anywhere in it doesn't count toward
        # min_rest_days_per_week — generalizes the single-session model's all-or-nothing rest
        # day to "nothing but FREE/rest-kind occupies this day".
        monday = date(2026, 8, 24)
        window = [monday + timedelta(days=i) for i in range(7)]
        spec = ProgramSpec(
            session_types=[
                ProgramSessionType(key="strength", category=["strength"], label="S", session_kind="strength"),
                ProgramSessionType(key="rest", category=["rest"], label="Rest", session_kind="rest"),
            ],
            rest_policy=RestPolicy(min_rest_days_per_week=7),  # every single day must be pure rest
            day_pins=[
                DayPin(session_type_key="strength", fixed_date=monday, time_slot="morning", flexibility="fixed"),
            ],
            allow_multi_session_days=True,
        )
        result = solve_schedule(spec, window)
        assert not result.feasible
        assert result.infeasible_reasons is not None
        assert any("rest_policy" in r for r in result.infeasible_reasons)

    def test_whole_day_pin_forbids_any_other_session_that_date(self):
        # pinned_events (not pinned_slot_events) fixes the WHOLE date even under
        # allow_multi_session_days — no cells get created for it at all.
        d = date(2026, 8, 24)
        spec = ProgramSpec(
            session_types=[
                ProgramSessionType(key="race", category=["race"], label="Race", session_kind="run", is_key=True),
                ProgramSessionType(key="strength", category=["strength"], label="S", session_kind="strength"),
            ],
            allow_multi_session_days=True,
        )
        result = solve_schedule(spec, [d], pinned_events={d: "race"})
        assert result.feasible
        assert result.slot_assignments == {(d, "day"): "race"}


class TestProgramSpecValidation:
    """A malformed spec should fail at construction.

    Before it ever reaches the solver — these are the cross-field checks in
    program_spec.py.
    """

    def _base_kwargs(self, **overrides):
        kwargs = {
            "session_types": [ProgramSessionType(key="a", category=["cat-a"], label="A", session_kind="strength")],
        }
        kwargs.update(overrides)
        return kwargs

    def test_weekly_target_referencing_unknown_session_type_rejected(self):
        with pytest.raises(ValueError):
            ProgramSpec(**self._base_kwargs(
                weekly_targets=[WeeklyTarget(session_type_key="does-not-exist", min_per_week=1, max_per_week=1)]
            ))

    def test_spacing_constraint_referencing_unknown_category_rejected(self):
        with pytest.raises(ValueError):
            ProgramSpec(**self._base_kwargs(
                spacing_constraints=[SpacingConstraint(from_category="cat-a", to_category="nope", min_gap_hours=24)]
            ))

    def test_duplicate_session_type_keys_rejected(self):
        with pytest.raises(ValueError):
            ProgramSpec(session_types=[
                ProgramSessionType(key="a", category=["c"], label="A", session_kind="strength"),
                ProgramSessionType(key="a", category=["c"], label="A again", session_kind="strength"),
            ])

    def test_weekly_target_max_below_min_rejected(self):
        with pytest.raises(ValueError):
            WeeklyTarget(session_type_key="a", min_per_week=3, max_per_week=1)

    def test_day_pin_needs_exactly_one_anchor(self):
        with pytest.raises(ValueError):
            DayPin(session_type_key="a", day_of_week="monday", fixed_date=date(2026, 8, 24))
        with pytest.raises(ValueError):
            DayPin(session_type_key="a")
