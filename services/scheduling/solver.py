"""Generic, athlete-agnostic scheduler.

Given ANY ProgramSpec, find a placement of session types across a date window
that satisfies every rule, or prove it can't be done and say exactly which
rules conflict.

This replaces weekly_planner_node.py's approach of asking an LLM to draft a
whole multi-week schedule from scratch and then patching known failure modes
with hand-written, Adrian-specific Python (_fix_weekly_volume,
_fix_legs_before_hard_runs) that only sees the current window and has no memory
of prior weeks' compromises. Those functions are, in effect, an incomplete,
hand-rolled constraint solver; this module is a real one (Google OR-Tools
CP-SAT), driven entirely by ProgramSpec data instead of hardcoded assumptions.

Every rule (a weekly count target, a spacing constraint, the rest-day minimum)
is added to the model gated behind an "assumption" literal. When the model is
feasible, gating is a no-op — the assumptions are simply satisfied. When it's
infeasible, CP-SAT's SufficientAssumptionsForInfeasibility() returns exactly
which of those gated rules are jointly unsatisfiable, which is how
ScheduleResult.infeasible_reasons gets built. See services/scheduling/
program_spec.py for what a rule is allowed to say, and
tests/test_program_spec_solver.py for the regression test that reproduces the
2026-08-25 real-world failure as a proven infeasibility instead of a silent
per-week warning.

Two scheduling models live here, selected by spec.allow_multi_session_days:
- False (default): the original one-session-per-calendar-day model, entirely
  unchanged — every existing spec keeps byte-identical behavior.
- True: a 4-slot-per-day model (morning/midday/afternoon/evening), letting a
  date hold more than one session and making SpacingConstraint's gap-hours
  math genuinely sub-day-resolution instead of a 0-or-24h-per-day-boundary
  approximation. See the plan this shipped under (multi-session-per-day
  scheduling) for why: a same-calendar-day conflict used to be structurally
  impossible under the old model, which made any spacing threshold at or
  below 24h a mathematical no-op regardless of its configured value.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from ortools.sat.python import cp_model

from services.scheduling.program_spec import ProgramSpec

FREE = "__free__"

# The 4 real time-of-day buckets, in chronological order, plus their representative hour for
# gap-hours math. 'day' (used for whole-day-fixed dates, which have no sibling slots on their
# own date to compare against) isn't a real slot — it defaults to the midday hour as a "center
# of day" anchor for cross-date comparisons, the only kind that matters for it.
SLOTS: tuple[str, ...] = ("morning", "midday", "afternoon", "evening")
SLOT_HOUR: dict[str, int] = {"morning": 7, "midday": 12, "afternoon": 15, "evening": 19}


@dataclass
class ScheduleResult:
    feasible: bool
    assignments: dict[date, str] | None = None
    """date -> session_type_key, or FREE for an intentionally unscheduled day. Only set when
    feasible AND the spec used the default single-session-per-day model."""
    slot_assignments: dict[tuple[date, str], str] | None = None
    """(date, time_slot) -> session_type_key, or FREE. Only set when feasible AND
    spec.allow_multi_session_days=True — a date can appear more than once, once per occupied
    slot. Whole-day-fixed dates appear once with slot='day'."""
    infeasible_reasons: list[str] | None = None
    """Human-readable descriptions of the conflicting rules. Only set when not
    feasible."""


def _week_monday(d: date) -> date:
    iso_year, iso_week, _ = d.isocalendar()
    return date.fromisocalendar(iso_year, iso_week, 1)


def _fully_known_weeks(known_dates: set[date]) -> dict[date, list[date]]:
    """Maps each Monday whose full Mon-Sun week is entirely covered.

    Only weeks entirely covered by known_dates are included, mapped to that
    week's 7 dates. Partial boundary weeks (e.g. a window that starts
    mid-week) are deliberately excluded — weekly_targets and rest_policy
    shouldn't be judged against a week we don't fully see.
    """
    weeks: dict[date, list[date]] = {}
    for d in known_dates:
        monday = _week_monday(d)
        if monday in weeks:
            continue
        full_week = [monday + timedelta(days=i) for i in range(7)]
        if all(day in known_dates for day in full_week):
            weeks[monday] = full_week
    return weeks


def _gap_hours(d1: date, d2: date) -> int:
    return abs((d2 - d1).days) * 24


def _cell_hour(cell: tuple[date, str]) -> datetime:
    d, slot = cell
    return datetime.combine(d, time(hour=SLOT_HOUR.get(slot, SLOT_HOUR["midday"])))


def _gap_hours_slotted(c1: tuple[date, str], c2: tuple[date, str]) -> int:
    return abs(int((_cell_hour(c2) - _cell_hour(c1)).total_seconds() // 3600))


def _spacing_orderings(direction: str, from_cat: str, to_cat: str) -> list[tuple[str, str]]:
    """Returns (earlier_category, later_category) pairs to forbid within the gap."""
    orderings: list[tuple[str, str]] = []
    if direction in ("before", "either"):
        orderings.append((from_cat, to_cat))
    if direction in ("after", "either"):
        orderings.append((to_cat, from_cat))
    return orderings


def solve_schedule(
    spec: ProgramSpec,
    window_dates: list[date],
    completed_ledger: dict[date, str] | None = None,
    pinned_events: dict[date, str] | None = None,
    pinned_slot_events: dict[tuple[date, str], str] | None = None,
    time_limit_seconds: float = 10.0,
) -> ScheduleResult:
    """Finds a feasible session-type placement, or proves there isn't one.

    completed_ledger: known session_type_key for dates outside (or inside,
    e.g. today's already-performed session) window_dates — supplies context so
    weekly windows overlapping the boundary are judged correctly, and so
    already-happened days aren't re-decided.
    pinned_events: dates forced to a specific session_type_key regardless of
    what the solver would otherwise choose (e.g. a race day) — the WHOLE date
    is fixed to this one type, even under allow_multi_session_days (no other
    session can share that date). Same mechanism as completed_ledger, kept as
    a separate parameter for caller clarity.
    pinned_slot_events: forces a specific (date, time_slot) cell to a specific
    session_type_key — only meaningful when spec.allow_multi_session_days is
    True (raises otherwise, since there's no slot-bucketed model to pin into).
    """
    if not window_dates:
        raise ValueError("window_dates must be non-empty")
    if len(set(window_dates)) != len(window_dates):
        raise ValueError("window_dates must not contain duplicates")
    if pinned_slot_events and not spec.allow_multi_session_days:
        raise ValueError(
            "pinned_slot_events requires spec.allow_multi_session_days=True — there's no "
            "slot-bucketed model to pin a specific (date, time_slot) cell into otherwise."
        )

    fixed_whole_day: dict[date, str] = {**(completed_ledger or {}), **(pinned_events or {})}

    if not spec.allow_multi_session_days:
        return _solve_single_session_per_day(spec, window_dates, fixed_whole_day, time_limit_seconds)
    return _solve_multi_session_per_day(
        spec, window_dates, fixed_whole_day, pinned_slot_events or {}, time_limit_seconds
    )


def _solve_single_session_per_day(
    spec: ProgramSpec,
    window_dates: list[date],
    fixed: dict[date, str],
    time_limit_seconds: float,
) -> ScheduleResult:
    """The original model: exactly one session_type_key (or FREE) per calendar day. Unchanged
    from before allow_multi_session_days existed — every spec that doesn't opt in gets
    byte-identical behavior.
    """
    window_set = set(window_dates)
    known_dates = window_set | set(fixed.keys())

    model = cp_model.CpModel()
    type_keys = [st.key for st in spec.session_types]
    category_of = {st.key: st.category for st in spec.session_types}
    rest_keys = [st.key for st in spec.session_types if st.session_kind == "rest"]

    day_vars: dict[date, dict[str, cp_model.IntVar]] = {}
    for d in window_dates:
        if d in fixed:
            continue
        day_vars[d] = {key: model.new_bool_var(f"x_{d.isoformat()}_{key}") for key in type_keys}
        day_vars[d][FREE] = model.new_bool_var(f"x_{d.isoformat()}_{FREE}")
        model.add_exactly_one(list(day_vars[d].values()))

    def type_indicator(d: date, key: str):
        if d in fixed:
            return 1 if fixed[d] == key else 0
        return day_vars[d][key]

    def category_indicator(d: date, category: str):
        """category_of[k] is a list of tags a session type carries — a session type
        counts toward `category` if it's a member, not an exact match, since one
        session (e.g. a strength slot touching chest AND legs) can carry several.
        """
        keys = [k for k in type_keys if category in category_of[k]]
        if not keys:
            return 0
        if d in fixed:
            return 1 if fixed[d] in keys else 0
        return sum(day_vars[d][k] for k in keys)

    assumptions: list[cp_model.IntVar] = []
    reasons_by_index: dict[int, str] = {}
    constant_violations: list[str] = []

    def add_gated(expr_le, bound: int, label: str) -> None:
        """Adds `expr_le <= bound` gated behind a fresh assumption literal.

        That lets an infeasible solve report this specific rule as a suspect.
        If expr_le is already a plain int (every contributing date is fixed —
        no variables involved), there's nothing left for the solver to search
        over: check it directly and, if violated, it's an unconditional
        conflict — no assignment of the remaining free days can fix it.
        """
        if isinstance(expr_le, int):
            if expr_le > bound:
                constant_violations.append(f"{label} (violated by fixed/history data alone)")
            return
        lit = model.new_bool_var(f"assume_{len(assumptions)}")
        model.add(expr_le <= bound).only_enforce_if(lit)
        assumptions.append(lit)
        reasons_by_index[lit.index] = label

    def add_weekly_and_rest_constraints() -> None:
        for monday, week_dates in _fully_known_weeks(known_dates).items():
            relevant_dates = [d for d in week_dates if d in window_set or d in fixed]
            for wt in spec.weekly_targets:
                total = sum(type_indicator(d, wt.session_type_key) for d in relevant_dates)
                add_gated(total, wt.max_per_week, f"weekly_target:{wt.session_type_key}:max<={wt.max_per_week} week-of-{monday}")
                add_gated(-total, -wt.min_per_week, f"weekly_target:{wt.session_type_key}:min>={wt.min_per_week} week-of-{monday}")

            if spec.rest_policy.min_rest_days_per_week > 0:
                rest_total = sum(type_indicator(d, k) for d in week_dates for k in rest_keys) if rest_keys else 0
                add_gated(
                    -rest_total,
                    -spec.rest_policy.min_rest_days_per_week,
                    f"rest_policy:min>={spec.rest_policy.min_rest_days_per_week} week-of-{monday}",
                )

    def add_spacing_constraints() -> None:
        known_sorted = sorted(known_dates)
        for sc in spec.spacing_constraints:
            for earlier_cat, later_cat in _spacing_orderings(sc.direction, sc.from_category, sc.to_category):
                for i, d1 in enumerate(known_sorted):
                    for d2 in known_sorted[i + 1:]:
                        if _gap_hours(d1, d2) >= sc.min_gap_hours:
                            break
                        total = category_indicator(d1, earlier_cat) + category_indicator(d2, later_cat)
                        add_gated(
                            total,
                            1,
                            f"spacing:{earlier_cat}->{later_cat}:>={sc.min_gap_hours}h between {d1} and {d2}",
                        )

    def add_day_pin_constraints() -> list[cp_model.IntVar]:
        preferred_terms: list[cp_model.IntVar] = []
        for pin in spec.day_pins:
            pin_dates = [
                d for d in window_dates
                if d not in fixed and (
                    (pin.day_of_week and d.strftime("%A").lower() == pin.day_of_week) or
                    (pin.fixed_date and d == pin.fixed_date)
                )
            ]
            if pin.flexibility == "fixed":
                for d in pin_dates:
                    model.add(day_vars[d][pin.session_type_key] == 1)
            else:
                preferred_terms.extend(day_vars[d][pin.session_type_key] for d in pin_dates)
        return preferred_terms

    add_weekly_and_rest_constraints()
    add_spacing_constraints()
    preferred_terms = add_day_pin_constraints()
    if preferred_terms:
        model.maximize(sum(preferred_terms))

    if constant_violations:
        # Fixed/history data alone already breaks a rule — no assignment of
        # the remaining free days can fix that, so there's nothing to solve.
        return ScheduleResult(feasible=False, infeasible_reasons=sorted(set(constant_violations)))

    if assumptions:
        model.add_assumptions(assumptions)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_seconds
    status = solver.solve(model)

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        assignments: dict[date, str] = dict(fixed)
        for d in window_dates:
            if d in fixed:
                continue
            for key, var in day_vars[d].items():
                if solver.value(var):
                    assignments[d] = key
                    break
        return ScheduleResult(feasible=True, assignments=assignments)

    if status == cp_model.INFEASIBLE:
        culprits = solver.sufficient_assumptions_for_infeasibility()
        reasons = [reasons_by_index[i] for i in culprits if i in reasons_by_index]
        if not reasons:
            reasons = ["infeasible — could not isolate a specific conflicting rule"]
        return ScheduleResult(feasible=False, infeasible_reasons=sorted(set(reasons)))

    return ScheduleResult(
        feasible=False,
        infeasible_reasons=[f"solver returned unexpected status: {solver.status_name(status)}"],
    )


def _solve_multi_session_per_day(
    spec: ProgramSpec,
    window_dates: list[date],
    fixed_whole_day: dict[date, str],
    fixed_slots: dict[tuple[date, str], str],
    time_limit_seconds: float,
) -> ScheduleResult:
    """4-slot-per-day model: each date gets up to 4 independently-assignable cells
    (morning/midday/afternoon/evening), each exactly one session_type_key (or FREE). A
    whole-day-fixed date (fixed_whole_day) gets no cells at all — it's a single fixed point,
    same as the single-session model, and nothing else can share that date.
    """
    window_set = set(window_dates)
    known_dates = window_set | set(fixed_whole_day.keys()) | {d for d, _slot in fixed_slots}

    model = cp_model.CpModel()
    type_keys = [st.key for st in spec.session_types]
    category_of = {st.key: st.category for st in spec.session_types}
    rest_keys = [st.key for st in spec.session_types if st.session_kind == "rest"]

    cell_vars: dict[tuple[date, str], dict[str, cp_model.IntVar]] = {}
    for d in window_dates:
        if d in fixed_whole_day:
            continue
        for slot in SLOTS:
            cell = (d, slot)
            if cell in fixed_slots:
                continue
            cell_vars[cell] = {
                key: model.new_bool_var(f"x_{d.isoformat()}_{slot}_{key}") for key in type_keys
            }
            cell_vars[cell][FREE] = model.new_bool_var(f"x_{d.isoformat()}_{slot}_{FREE}")
            model.add_exactly_one(list(cell_vars[cell].values()))

    def cell_type_indicator(cell: tuple[date, str], key: str):
        d, _slot = cell
        if d in fixed_whole_day:
            return 1 if fixed_whole_day[d] == key else 0
        if cell in fixed_slots:
            return 1 if fixed_slots[cell] == key else 0
        return cell_vars[cell][key]

    def cell_category_indicator(cell: tuple[date, str], category: str):
        keys = [k for k in type_keys if category in category_of[k]]
        if not keys:
            return 0
        d, _slot = cell
        if d in fixed_whole_day:
            return 1 if fixed_whole_day[d] in keys else 0
        if cell in fixed_slots:
            return 1 if fixed_slots[cell] in keys else 0
        return sum(cell_vars[cell][k] for k in keys)

    def day_type_total(d: date, key: str):
        """Sum across all 4 slots — weekly targets/rest policy are slot-agnostic counts."""
        if d in fixed_whole_day:
            return 1 if fixed_whole_day[d] == key else 0
        return sum(cell_type_indicator((d, s), key) for s in SLOTS)

    assumptions: list[cp_model.IntVar] = []
    reasons_by_index: dict[int, str] = {}
    constant_violations: list[str] = []

    def add_gated(expr_le, bound: int, label: str) -> None:
        if isinstance(expr_le, int):
            if expr_le > bound:
                constant_violations.append(f"{label} (violated by fixed/history data alone)")
            return
        lit = model.new_bool_var(f"assume_{len(assumptions)}")
        model.add(expr_le <= bound).only_enforce_if(lit)
        assumptions.append(lit)
        reasons_by_index[lit.index] = label

    def add_weekly_and_rest_constraints() -> None:
        for monday, week_dates in _fully_known_weeks(known_dates).items():
            relevant_dates = [
                d for d in week_dates
                if d in window_set or d in fixed_whole_day or any((d, s) in fixed_slots for s in SLOTS)
            ]
            for wt in spec.weekly_targets:
                total = sum(day_type_total(d, wt.session_type_key) for d in relevant_dates)
                add_gated(total, wt.max_per_week, f"weekly_target:{wt.session_type_key}:max<={wt.max_per_week} week-of-{monday}")
                add_gated(-total, -wt.min_per_week, f"weekly_target:{wt.session_type_key}:min>={wt.min_per_week} week-of-{monday}")

            if spec.rest_policy.min_rest_days_per_week > 0 and rest_keys:
                # A day counts as "rest" only if nothing but FREE/rest-kind occupies it — the
                # generalization of the single-session model's "this day's category is rest",
                # now that a day can hold several sessions and isn't automatically all-or-
                # nothing. Needs a real auxiliary boolean per day (CP-SAT has no native
                # "AND of expressions" usable directly in a linear sum).
                rest_day_bools: list[cp_model.IntVar | int] = []
                for d in week_dates:
                    if d in fixed_whole_day:
                        rest_day_bools.append(1 if fixed_whole_day[d] in rest_keys else 0)
                        continue
                    non_rest_non_free = sum(
                        cell_type_indicator((d, s), k)
                        for s in SLOTS for k in type_keys if k not in rest_keys
                    )
                    is_rest = model.new_bool_var(f"is_rest_{d.isoformat()}")
                    model.add(non_rest_non_free == 0).only_enforce_if(is_rest)
                    model.add(non_rest_non_free > 0).only_enforce_if(is_rest.Not())
                    rest_day_bools.append(is_rest)
                add_gated(
                    -sum(rest_day_bools),
                    -spec.rest_policy.min_rest_days_per_week,
                    f"rest_policy:min>={spec.rest_policy.min_rest_days_per_week} week-of-{monday}",
                )

    def add_spacing_constraints() -> None:
        all_cells: list[tuple[date, str]] = []
        for d in sorted(known_dates):
            if d in fixed_whole_day:
                all_cells.append((d, "day"))
            else:
                all_cells.extend((d, s) for s in SLOTS)

        for sc in spec.spacing_constraints:
            for earlier_cat, later_cat in _spacing_orderings(sc.direction, sc.from_category, sc.to_category):
                for i, c1 in enumerate(all_cells):
                    for c2 in all_cells[i + 1:]:
                        if _gap_hours_slotted(c1, c2) >= sc.min_gap_hours:
                            # all_cells is chronologically sorted (by date, then by slot hour
                            # within a date), so once the gap clears the threshold every later
                            # c2 clears it too.
                            break
                        total = cell_category_indicator(c1, earlier_cat) + cell_category_indicator(c2, later_cat)
                        add_gated(
                            total,
                            1,
                            f"spacing:{earlier_cat}->{later_cat}:>={sc.min_gap_hours}h between {c1} and {c2}",
                        )

    def add_day_pin_constraints() -> list[cp_model.IntVar]:
        preferred_terms: list[cp_model.IntVar] = []
        for pin in spec.day_pins:
            pin_dates = [
                d for d in window_dates
                if d not in fixed_whole_day and (
                    (pin.day_of_week and d.strftime("%A").lower() == pin.day_of_week) or
                    (pin.fixed_date and d == pin.fixed_date)
                )
            ]
            for d in pin_dates:
                slots = [pin.time_slot] if pin.time_slot else list(SLOTS)
                cells = [(d, s) for s in slots if (d, s) not in fixed_slots]
                if not cells:
                    continue
                if pin.flexibility == "fixed":
                    if pin.time_slot:
                        model.add(cell_vars[(d, pin.time_slot)][pin.session_type_key] == 1)
                    else:
                        # No specific slot named: a "fixed, any slot" pin requires at least one
                        # slot that day to carry this type — it can't force EVERY slot to it,
                        # since that would forbid any other independent session that date.
                        model.add(sum(cell_vars[c][pin.session_type_key] for c in cells) >= 1)
                else:
                    preferred_terms.extend(cell_vars[c][pin.session_type_key] for c in cells)
        return preferred_terms

    add_weekly_and_rest_constraints()
    add_spacing_constraints()
    preferred_terms = add_day_pin_constraints()
    if preferred_terms:
        model.maximize(sum(preferred_terms))

    if constant_violations:
        return ScheduleResult(feasible=False, infeasible_reasons=sorted(set(constant_violations)))

    if assumptions:
        model.add_assumptions(assumptions)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_seconds
    status = solver.solve(model)

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        slot_assignments: dict[tuple[date, str], str] = {}
        for d, key in fixed_whole_day.items():
            slot_assignments[(d, "day")] = key
        slot_assignments.update(fixed_slots)
        for cell, vars_ in cell_vars.items():
            for key, var in vars_.items():
                if solver.value(var):
                    slot_assignments[cell] = key
                    break
        return ScheduleResult(feasible=True, slot_assignments=slot_assignments)

    if status == cp_model.INFEASIBLE:
        culprits = solver.sufficient_assumptions_for_infeasibility()
        reasons = [reasons_by_index[i] for i in culprits if i in reasons_by_index]
        if not reasons:
            reasons = ["infeasible — could not isolate a specific conflicting rule"]
        return ScheduleResult(feasible=False, infeasible_reasons=sorted(set(reasons)))

    return ScheduleResult(
        feasible=False,
        infeasible_reasons=[f"solver returned unexpected status: {solver.status_name(status)}"],
    )
