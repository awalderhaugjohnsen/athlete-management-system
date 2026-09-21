"""Deterministic (non-LLM) pieces of a ProgramSpec, built from real Supabase data.

Strength session types and the leg-spacing floor are real saved data / a
research-grounded safety constant, not a coaching judgment call — Python owns them
outright so the season planner never has to (or gets a chance to) reinvent them.
Shared by services/ai/langgraph/nodes/season_planner_node.py (the live pipeline)
and scripts/bootstrap_program_spec.py (the manual bootstrap tool), so there is
exactly one implementation of "what does this athlete's real strength setup look
like as a ProgramSpec fragment."

See services/scheduling/program_spec.py for the schema and the plan this shipped
under (Phase 3+4: wiring ProgramSpec + the solver into the live pipeline).
"""
from __future__ import annotations

from services.scheduling.muscle_groups import slot_muscle_groups
from services.scheduling.program_spec import (
    ProgramSessionType,
    SpacingConstraint,
    WeeklyTarget,
)


def build_deterministic_session_types(
    strength_templates: list[dict],
) -> list[ProgramSessionType]:
    """One ProgramSessionType per real strength slot (A/B/C, ...).

    category is the real set of muscle groups the slot's saved template
    exercises touch (see services/scheduling/muscle_groups.py) — a slot
    commonly touches more than one (e.g. bench press + squat = chest + legs),
    which is exactly why category became list-valued. Every real strength
    session is treated as key — confirmed against live
    scheduled_days.is_key_session data (see scripts/bootstrap_program_spec.py's
    original comment on this). Never LLM-authored: this is real saved athlete
    data, not a periodization choice.
    """
    slots: dict[str, dict] = {}
    for row in strength_templates:
        slot = row.get("slot")
        if slot and slot not in slots:
            slots[slot] = row

    groups_by_slot = slot_muscle_groups(strength_templates)

    session_types: list[ProgramSessionType] = []
    for slot in sorted(slots):
        slot_name = slots[slot].get("slot_name") or f"Strength {slot}"
        session_types.append(
            ProgramSessionType(
                key=f"strength-{slot.lower()}",
                category=sorted(groups_by_slot.get(slot, set())),
                label=slot_name,
                session_kind="strength",
                is_key=True,
            )
        )
    return session_types


def build_deterministic_weekly_targets(
    session_types: list[ProgramSessionType],
    recurring_session_requests: list[dict],
) -> tuple[list[WeeklyTarget], str | None]:
    """One WeeklyTarget(min=max=1) per strength session type, when it's expressible.

    Only generated when the athlete's real strength cadence (count of 'must'
    strength recurring_session_requests) matches the number of saved strength
    slots — the common case, and the only one that's actually expressible
    today: ProgramSpec has no "rotate fairly across weeks" rule type yet (a
    known, pre-existing vocabulary gap — see the plan's "Known limitation"
    note), so a cadence/slot-count mismatch can't be turned into a
    deterministic per-slot target without either being infeasible (cadence <
    slot count) or silently under-committing (cadence > slot count).

    Returns (targets, mismatch_note) — mismatch_note is None when they match,
    otherwise a human-readable string meant to be surfaced to the season
    planner (and stored in the spec's rationale) rather than silently guessed.
    """
    strength_types = [st for st in session_types if st.session_kind == "strength"]
    strength_cadence = sum(
        1
        for r in recurring_session_requests
        if r.get("session_type") == "strength" and r.get("importance") == "must"
    )

    if strength_cadence != len(strength_types):
        note = (
            f"Athlete's recurring strength cadence ({strength_cadence}/week) does not match "
            f"the number of saved strength slots ({len(strength_types)}) — ProgramSpec has no "
            "rotate-fairly-across-weeks rule type yet, so per-slot weekly targets were not "
            "auto-generated for strength here. The season planner should account for this "
            "explicitly (e.g. via its own weekly_targets) rather than assume even rotation."
        )
        return [], note

    targets = [
        WeeklyTarget(session_type_key=st.key, min_per_week=1, max_per_week=1)
        for st in strength_types
    ]
    return targets, None


def build_deterministic_leg_spacing_constraint(min_gap_hours: int = 24) -> SpacingConstraint:
    """The leg-before-key-run spacing rule, Python-owned.

    A physiological safety floor, not a periodization choice — the season
    planner may add further spacing_constraints on top, never weaken or
    remove this one.

    24h, not the 48h originally hardcoded in weekly_planner_node.py: a
    research pass (2026-08-26) found no primary source directly validating a
    48h threshold specifically — the best real evidence (Robineau et al.
    2016, JSCR) tested 0h/6h/24h gaps between strength and aerobic sessions
    and found 0h significantly worse but no difference between 6h and 24h.
    24h is what that evidence actually supports; 48h was an unverified
    heuristic extrapolated from general DOMS/recovery timelines. Note this
    system approximates hour-gaps as calendar-day-difference * 24 (no
    time-of-day tracking) — see solver.py's _gap_hours — so 24h in practice
    means "not the same calendar day," not "a full buffer day between them"
    the way 48h did.

    Contract: the season planner must label any hard/key run session type it
    authors with category 'key-run' for this constraint to actually bind —
    stated explicitly in the season-planner prompt. 'legs' matches the muscle
    group tag build_deterministic_session_types assigns via
    services/scheduling/muscle_groups.py.
    """
    return SpacingConstraint(
        from_category="legs",
        to_category="key-run",
        min_gap_hours=min_gap_hours,
        direction="before",
    )


def build_deterministic_recovery_spacing_constraints(
    session_types: list[ProgramSessionType],
    min_gap_hours: int = 48,
) -> list[SpacingConstraint]:
    """One 'either'-direction SpacingConstraint per real muscle-group tag present
    across strength session types (including a tag against itself), so two
    sessions that both touch the same muscle group can't land on adjacent
    calendar days — e.g. chest can't follow chest, but a chest+legs session
    followed by a pure-back session is fine, since they share no tag.

    48h, not 24h: solver.py's day-granularity math (_gap_hours = calendar-day-
    difference * 24) makes any spacing_constraint at or under 24h a no-op for
    two different dates under the single-session-per-day model — any two
    different dates are already >=24h apart by construction, and same-day
    placement of two different session types is already impossible regardless.
    48h is the actual floor that binds: it blocks two adjacent calendar days
    (a 1-day gap = 24h, which is < 48h) while a normal >=2-days-apart cadence
    (e.g. Mon/Wed/Fri) is untouched (each pair is already >=48h apart).

    Generalizes weekly_planner_node.py's _check_strength_recovery_spacing
    (a same-bucket-adjacency warning) into a real, solver-enforced constraint,
    now with real per-muscle-group tags (see muscle_groups.py) instead of a
    coarse leg/upper split — replacing the old binary entirely, since a
    blanket "any two strength sessions" rule would re-introduce exactly the
    over-restriction this finer tagging exists to avoid (upper body doesn't
    need a blanket separation, only a shared muscle group does).
    """
    strength_categories = sorted({
        c for st in session_types if st.session_kind == "strength" for c in st.category
    })
    return [
        SpacingConstraint(
            from_category=cat_a,
            to_category=cat_b,
            min_gap_hours=min_gap_hours,
            direction="either",
        )
        for i, cat_a in enumerate(strength_categories)
        for cat_b in strength_categories[i:]
    ]
