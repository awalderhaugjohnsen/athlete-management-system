"""Real, exercise-level muscle-group tagging for strength_session_templates rows.

Replaces the old whole-slot leg/upper binary (spec_bootstrap.py's former
LEG_GARMIN_CATEGORIES, weekly_planner_node.py's former _MUSCLE_GROUP_BUCKETS)
with one complete taxonomy, because a strength "slot" is not one muscle group —
every real slot in this athlete's program deliberately mixes several (the
"bench every session" split: every slot includes chest work alongside legs or
back). Spacing has to be decided per muscle group a session actually touches,
not per whole session.

The exercise universe this maps over is closed and finite, not open-ended —
services/garmin/exercise_catalog.json (already in the repo) is Garmin's own
FIT SDK vocabulary: exactly 37 categories, 232 exercises. So this mapping is
complete over all 37, not a hand-picked subset that could silently miss real
data — see muscle_groups_for_row's ValueError, and
tests/test_muscle_groups.py's regression test pinning _KNOWN_CATEGORIES against
the catalog file itself.
"""
from __future__ import annotations

from typing import Any

# 28 categories that map to exactly one muscle group unambiguously.
MUSCLE_GROUP_BY_GARMIN_CATEGORY: dict[str, str] = {
    "BENCH_PRESS": "chest", "PUSH_UP": "chest",
    "ROW": "back", "PULL_UP": "back", "HYPEREXTENSION": "back", "SHRUG": "back",
    "SHOULDER_PRESS": "delts", "LATERAL_RAISE": "delts", "SHOULDER_STABILITY": "delts",
    "BATTLE_ROPE": "delts",
    "CURL": "biceps",
    "TRICEPS_EXTENSION": "triceps",
    "SQUAT": "legs", "DEADLIFT": "legs", "LUNGE": "legs", "LEG_CURL": "legs",
    "HIP_RAISE": "legs", "LEG_RAISE": "legs", "HIP_STABILITY": "legs",
    "OLYMPIC_LIFT": "legs", "PLYO": "legs",
    "CALF_RAISE": "calves",
    "CORE": "core", "CRUNCH": "core", "SIT_UP": "core", "PLANK": "core",
    "CHOP": "core", "CARRY": "core",
}

# FLYE is ambiguous at category level (chest vs. rear-delt variants) —
# disambiguate by garmin_exercise_key, confirmed against exercise_catalog.json.
FLYE_MUSCLE_GROUP_BY_EXERCISE_KEY: dict[str, str] = {
    "CABLE_CROSSOVER": "chest", "DECLINE_DUMBBELL_FLYE": "chest",
    "DUMBBELL_FLYE": "chest", "INCLINE_DUMBBELL_FLYE": "chest",
    "KNEELING_REAR_FLYE": "back", "SINGLE_ARM_STANDING_CABLE_REVERSE_FLYE": "back",
}

# TOTAL_BODY is a genuine compound exercise, not a lookup gap — tag it with
# every major group so it conservatively counts toward spacing against any of
# them, rather than guessing one.
TOTAL_BODY_MUSCLE_GROUPS: set[str] = {"chest", "back", "legs"}

# Cardio modalities and mobility work — not muscle-isolating, never expected in
# a strength template, explicitly known-and-untagged (not a coverage gap).
NOT_APPLICABLE_CATEGORIES: set[str] = {
    "BIKE", "ELLIPTICAL", "INDOOR_BIKE", "INDOOR_ROW", "RUN_INDOOR",
    "STAIR_STEPPER", "POSE",
}

KNOWN_CATEGORIES: set[str] = (
    set(MUSCLE_GROUP_BY_GARMIN_CATEGORY) | {"FLYE", "TOTAL_BODY"} | NOT_APPLICABLE_CATEGORIES
)


def muscle_groups_for_row(row: dict[str, Any]) -> set[str]:
    """Real muscle group(s) for one strength_session_templates row.

    Raises on a garmin_category outside the closed, complete 37-value Garmin
    taxonomy — a real gap should surface immediately (at spec-build time, or in
    tests), not silently lose spacing protection for an exercise we don't
    recognize.
    """
    category = (row.get("garmin_category") or "").upper()
    if category not in KNOWN_CATEGORIES:
        raise ValueError(
            f"Unrecognized garmin_category {category!r} — not in the known "
            "37-category Garmin taxonomy (see exercise_catalog.json). Add it to "
            "muscle_groups.py rather than silently skipping it."
        )
    if category == "FLYE":
        key = (row.get("garmin_exercise_key") or "").upper()
        group = FLYE_MUSCLE_GROUP_BY_EXERCISE_KEY.get(key)
        return {group} if group else set()
    if category == "TOTAL_BODY":
        return set(TOTAL_BODY_MUSCLE_GROUPS)
    if category in NOT_APPLICABLE_CATEGORIES:
        return set()
    return {MUSCLE_GROUP_BY_GARMIN_CATEGORY[category]}


def slot_muscle_groups(templates: list[dict[str, Any]]) -> dict[str, set[str]]:
    """Muscle-group set actually touched by each strength session template slot.

    A slot can (and in this athlete's program, always does) touch more than
    one — e.g. a slot combining a bench press and a squat is both 'chest' and
    'legs'. Templates are fixed/saved data, so this is exact, not a best-effort
    guess.
    """
    by_slot: dict[str, set[str]] = {}
    for row in templates:
        slot = row.get("slot")
        if not slot:
            continue
        by_slot.setdefault(slot, set()).update(muscle_groups_for_row(row))
    return by_slot
