"""Tests for services/scheduling/muscle_groups.py — real, exercise-level muscle-group tagging.

Includes a regression test pinning KNOWN_CATEGORIES against the real Garmin exercise catalog
(services/garmin/exercise_catalog.json) — if that file's category vocabulary ever changes, this
should fail loudly rather than silently losing spacing protection for a real exercise.
"""
import json
from pathlib import Path

import pytest

from services.scheduling.muscle_groups import (
    KNOWN_CATEGORIES,
    NOT_APPLICABLE_CATEGORIES,
    muscle_groups_for_row,
    slot_muscle_groups,
)

_CATALOG_PATH = Path(__file__).resolve().parent.parent / "services" / "garmin" / "exercise_catalog.json"


def test_known_categories_exactly_match_real_garmin_catalog():
    catalog = json.loads(_CATALOG_PATH.read_text())
    real_categories = {row["category"] for row in catalog}
    assert KNOWN_CATEGORIES == real_categories


def test_unrecognized_category_raises():
    with pytest.raises(ValueError, match="Unrecognized garmin_category"):
        muscle_groups_for_row({"garmin_category": "NOT_A_REAL_CATEGORY"})


def test_simple_category_maps_to_one_group():
    assert muscle_groups_for_row({"garmin_category": "BENCH_PRESS"}) == {"chest"}
    assert muscle_groups_for_row({"garmin_category": "squat"}) == {"legs"}  # case-insensitive


def test_flye_disambiguated_by_exercise_key():
    chest = muscle_groups_for_row({"garmin_category": "FLYE", "garmin_exercise_key": "DUMBBELL_FLYE"})
    back = muscle_groups_for_row({"garmin_category": "FLYE", "garmin_exercise_key": "KNEELING_REAR_FLYE"})
    assert chest == {"chest"}
    assert back == {"back"}


def test_flye_with_unknown_exercise_key_returns_empty_not_a_guess():
    assert muscle_groups_for_row({"garmin_category": "FLYE", "garmin_exercise_key": "SOME_NEW_FLYE_VARIANT"}) == set()


def test_total_body_tags_every_major_group():
    assert muscle_groups_for_row({"garmin_category": "TOTAL_BODY"}) == {"chest", "back", "legs"}


def test_not_applicable_category_returns_empty_set():
    for category in NOT_APPLICABLE_CATEGORIES:
        assert muscle_groups_for_row({"garmin_category": category}) == set()


def test_slot_muscle_groups_unions_across_a_slots_exercises():
    templates = [
        {"slot": "A", "garmin_category": "SQUAT"},
        {"slot": "A", "garmin_category": "BENCH_PRESS"},
        {"slot": "B", "garmin_category": "ROW"},
    ]
    result = slot_muscle_groups(templates)
    assert result == {"A": {"legs", "chest"}, "B": {"back"}}


def test_slot_muscle_groups_skips_rows_missing_slot():
    assert slot_muscle_groups([{"garmin_category": "SQUAT"}]) == {}
