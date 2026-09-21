"""One-off: build a ProgramSpec from Adrian's live current setup and check it.

Deliberately reproduces today's implicit configuration (whatever
athlete_profile.recurring_session_requests + strength_session_templates say
right now) rather than inventing a fix — the point is to see the solver's
explicit feasibility/infeasibility report for the rules as they actually
stand, then let Adrian decide what (if anything) needs to change.

Shares its deterministic strength-session-type / leg-spacing / recovery-
spacing logic with the live pipeline (season_planner_node.py) via
services/scheduling/spec_bootstrap.py, and its "what's pinned today" logic via
services/scheduling/live_state.py — this script only adds its own run/cross/
rest session-type derivation from recurring_session_requests, since that part
isn't real fixed data the way the strength slots and the leg-spacing floor
are; a live LLM call authors it in the pipeline, this script guesses it
deterministically as a stand-in. See the plan this shipped under (Phase 2 for
the original version of this script, Phase 3+4 for the live-pipeline reuse).

Not wired into the replan_jobs queue — run manually:
    pixi run python scripts/bootstrap_program_spec.py [--write] [--rest-days N]

Without --write, only prints the spec and the solver's report (dry run).
--write inserts the built spec into program_specs as a status='draft',
source='bootstrap' row — never 'active', so it can't affect the live app
(unlike season_planner_node's write, which auto-activates on feasible).
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import date, timedelta

from services.scheduling.live_state import resolve_today_pin
from services.scheduling.program_spec import (
    DayPin,
    ProgramSessionType,
    ProgramSpec,
    RestPolicy,
    WeeklyTarget,
)
from services.scheduling.solver import solve_schedule
from services.scheduling.spec_bootstrap import (
    build_deterministic_leg_spacing_constraint,
    build_deterministic_recovery_spacing_constraints,
    build_deterministic_session_types,
    build_deterministic_weekly_targets,
)
from services.supabase.athlete_profile import get_recurring_session_requests, get_strength_session_templates
from services.supabase.client import get_supabase
from services.supabase.program_specs import fetch_checkin_context


def _is_key_session(description: str) -> bool:
    text = (description or "").lower()
    return "key session" in text and "not a key session" not in text


def build_program_spec(user_id: str, min_rest_days_per_week: int = 0) -> ProgramSpec:
    recurring = get_recurring_session_requests(user_id)
    strength_templates = get_strength_session_templates(user_id)

    strength_types = build_deterministic_session_types(strength_templates)
    strength_targets, mismatch_note = build_deterministic_weekly_targets(strength_types, recurring)
    if mismatch_note:
        print(f"NOTE: {mismatch_note}")

    session_types: list[ProgramSessionType] = list(strength_types)
    weekly_targets: list[WeeklyTarget] = list(strength_targets)
    day_pins: list[DayPin] = []

    for req in recurring:
        if req.get("session_type") == "strength":
            continue  # already covered by the real saved slots above
        key = req["id"]
        session_kind = req["session_type"]
        is_key = _is_key_session(req.get("description", ""))
        category = "key-run" if is_key else f"{session_kind}-easy"

        session_types.append(
            ProgramSessionType(key=key, category=[category], label=req["label"], session_kind=session_kind, is_key=is_key)
        )
        if req.get("importance") == "must":
            weekly_targets.append(WeeklyTarget(session_type_key=key, min_per_week=1, max_per_week=1))
        if req.get("day_of_week"):
            day_pins.append(
                DayPin(
                    session_type_key=key,
                    day_of_week=req["day_of_week"],
                    flexibility=req.get("day_flexibility") or "preferred",
                )
            )

    return ProgramSpec(
        session_types=session_types,
        weekly_targets=weekly_targets,
        spacing_constraints=[
            build_deterministic_leg_spacing_constraint(),
            *build_deterministic_recovery_spacing_constraints(strength_types),
        ],
        day_pins=day_pins,
        rest_policy=RestPolicy(min_rest_days_per_week=min_rest_days_per_week),
        horizon_weeks=6,
    )


def find_pinned_disruption(user_id: str, start: date, spec: ProgramSpec) -> dict[date, str]:
    """Pin today's already-committed session, if any.

    Thin wrapper around live_state.resolve_today_pin (generalized beyond
    strength-only), kept under its original name/signature for this script's
    own use.
    """
    today_row, today_strength_row, _ = fetch_checkin_context(user_id, [start])
    return resolve_today_pin(start, today_row, today_strength_row, spec)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="Insert the spec as a draft program_specs row")
    parser.add_argument("--rest-days", type=int, default=0, help="min_rest_days_per_week to bootstrap with")
    args = parser.parse_args()

    user_id = os.environ["SUPABASE_USER_ID"]
    spec = build_program_spec(user_id, min_rest_days_per_week=args.rest_days)

    print("=== Bootstrapped ProgramSpec ===")
    print(json.dumps(spec.model_dump(mode="json"), indent=2, default=str))

    start = date.today()
    window = [start + timedelta(days=i) for i in range(42)]
    pinned = find_pinned_disruption(user_id, start, spec)

    result = solve_schedule(spec, window, pinned_events=pinned)
    print("\n=== Solver result ===")
    if result.feasible:
        print("FEASIBLE — a fully compliant 6-week schedule exists for the rules as they stand today.")
    else:
        print("INFEASIBLE — the rules as they stand today cannot all be satisfied at once:")
        for reason in result.infeasible_reasons or []:
            print(f"  - {reason}")

    if args.write:
        sb = get_supabase()
        sb.table("program_specs").insert(
            {
                "user_id": user_id,
                "effective_from": start.isoformat(),
                "status": "draft",
                "source": "bootstrap",
                "spec": spec.model_dump(mode="json"),
                "rationale": (
                    "Bootstrapped from live recurring_session_requests + strength_session_templates "
                    f"on {start.isoformat()}, reproducing the current implicit configuration "
                    f"(min_rest_days_per_week={args.rest_days}) rather than a fix. See the "
                    "solver result above/in logs for whether this configuration is feasible."
                ),
            }
        ).execute()
        print("\nInserted as a draft program_specs row (status='draft', source='bootstrap').")


if __name__ == "__main__":
    main()
