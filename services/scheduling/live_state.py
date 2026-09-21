"""Pure functions for turning live Supabase rows into solve_schedule() inputs.

No Supabase calls here — the I/O counterparts (fetching the rows these
functions consume) live in services/supabase/program_specs.py, matching the
project's existing split between pure logic (tested directly, no mocking) and
thin I/O wrappers (see tests/test_bench_wave.py / tests/test_plan_shift_layout.py
for the established pattern).

Generalizes scripts/bootstrap_program_spec.py's original find_pinned_disruption
(strength-only) to any session kind, and adds the churn-avoidance logic a live
check-in needs that the one-off bootstrap script never did: treating the
existing, undisturbed schedule as fixed so solve_schedule doesn't needlessly
reshuffle Garmin workouts that were never actually disrupted.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from services.scheduling.program_spec import ProgramSpec

if TYPE_CHECKING:
    from datetime import date


def _resolve_row_session_type_key(row: dict[str, Any], spec: ProgramSpec) -> str | None:
    """Best-effort match of a scheduled_days-shaped row to a session_type_key in spec.

    Strength rows must carry a 'slot' key (joined in from strength_sessions by the
    caller) — matched to 'strength-{slot.lower()}', the naming
    build_deterministic_session_types uses. Non-strength rows are matched by
    (session_kind, is_key) against the spec's session_types; if that's ambiguous
    (more than one session type shares the same kind/is_key) or matches nothing,
    returns None rather than guessing — the caller should then leave that date
    undecided for the solver, not silently mis-pin it.
    """
    session_type = row.get("session_type")
    if session_type == "strength":
        slot = row.get("slot")
        if not slot:
            return None
        key = f"strength-{str(slot).lower()}"
        return key if key in {st.key for st in spec.session_types} else None

    is_key = bool(row.get("is_key") or row.get("is_key_session"))
    candidates = [
        st for st in spec.session_types
        if st.session_kind == session_type and st.is_key == is_key
    ]
    return candidates[0].key if len(candidates) == 1 else None


def resolve_today_pin(
    today: date,
    scheduled_day_row: dict[str, Any] | None,
    strength_session_row: dict[str, Any] | None,
    spec: ProgramSpec,
) -> dict[date, str]:
    """Pin today's already-committed session, of any kind — not just strength.

    Mirrors what a real check-in already knows (today's committed session) the
    same way the original find_pinned_disruption did for strength only.
    Returns {} if there's no committed session today, or if it can't be
    unambiguously matched to a session_type_key in the active spec.
    """
    if not scheduled_day_row:
        return {}
    row = dict(scheduled_day_row)
    if row.get("session_type") == "strength" and strength_session_row:
        row["slot"] = strength_session_row.get("slot")
    key = _resolve_row_session_type_key(row, spec)
    return {today: key} if key else {}


def compute_checkin_fixed_days(
    window_dates: list[date],
    existing_scheduled_days: dict[tuple[date, str], dict[str, Any]],
    overrides: dict[date, str],
    spec: ProgramSpec,
) -> tuple[dict[date, str], dict[tuple[date, str], str]]:
    """Everything solve_schedule should treat as already-decided for a check-in.

    Returns (pinned_events, pinned_slot_events) — solve_schedule's own two
    pinning mechanisms (see its docstring): pinned_events is a whole-day pin
    (blocks every other session sharing that date, in either solver mode);
    pinned_slot_events pins one specific (date, time_slot) cell and is only
    meaningful when spec.allow_multi_session_days is True.

    - overrides (the athlete-note-translated {date: key} pairs) are always
      whole-day intent — the translation has no time_slot concept, "skip
      Thursday's tempo" means the whole day — so they always go into
      pinned_events, regardless of solver mode.
    - Existing, undisturbed scheduled_days rows NOT touched by an override,
      resolved to a session_type_key (churn avoidance — re-solving the whole
      window from scratch every check-in risks CP-SAT returning a different-
      but-equally-valid placement each run, needlessly reshuffling Garmin
      workouts that were never disrupted), go into pinned_events under the
      single-session model (unchanged behavior) or pinned_slot_events under
      allow_multi_session_days — so an already-committed session on one slot
      doesn't block the solver from placing something else on another slot of
      the same date, which is what made turning the flag on unsafe before
      this fix (a whole-day pin blocks any other session sharing that date,
      per solve_schedule's own docstring).

    Dates with no existing row (the new tail of the rolling window) and dates
    an override displaced are deliberately left OUT — those are what the
    solver is actually being asked to (re)decide this run. A row that can't be
    unambiguously resolved to a session_type_key (see
    _resolve_row_session_type_key) is also left undecided rather than guessed.
    """
    window_set = set(window_dates)
    valid_keys = {st.key for st in spec.session_types}

    pinned_events: dict[date, str] = {
        d: key for d, key in overrides.items() if d in window_set and key in valid_keys
    }

    pinned_slot_events: dict[tuple[date, str], str] = {}
    for (d, time_slot), row in existing_scheduled_days.items():
        if d not in window_set or d in overrides:
            continue
        key = _resolve_row_session_type_key(row, spec)
        if key is None:
            continue
        if spec.allow_multi_session_days:
            pinned_slot_events[(d, time_slot)] = key
        else:
            pinned_events[d] = key

    return pinned_events, pinned_slot_events
