"""Tests for services/scheduling/spec_bootstrap.py — the deterministic (non-LLM) pieces of a
ProgramSpec, shared by season_planner_node.py and scripts/bootstrap_program_spec.py. Pure
functions, no Supabase — fed hand-built row fixtures matching the real table shapes.
"""
from services.scheduling.spec_bootstrap import (
    build_deterministic_leg_spacing_constraint,
    build_deterministic_recovery_spacing_constraints,
    build_deterministic_session_types,
    build_deterministic_weekly_targets,
)


def _template_row(slot: str, garmin_category: str, slot_name: str) -> dict:
    return {"slot": slot, "garmin_category": garmin_category, "slot_name": slot_name}


ADRIAN_TEMPLATES = [
    _template_row("A", "SQUAT", "Bench Variant + Legs"),
    _template_row("A", "BENCH_PRESS", "Bench Variant + Legs"),
    _template_row("B", "DEADLIFT", "Bench Heavy + Legs"),
    _template_row("B", "BENCH_PRESS", "Bench Heavy + Legs"),
    _template_row("C", "BENCH_PRESS", "Bench Moderate + Upper"),
    _template_row("C", "ROW", "Bench Moderate + Upper"),
]


class TestBuildDeterministicSessionTypes:
    def test_one_type_per_slot_sorted(self):
        types = build_deterministic_session_types(ADRIAN_TEMPLATES)
        assert [st.key for st in types] == ["strength-a", "strength-b", "strength-c"]

    def test_slots_tagged_with_real_muscle_groups(self):
        types = {st.key: st for st in build_deterministic_session_types(ADRIAN_TEMPLATES)}
        assert types["strength-a"].category == ["chest", "legs"]
        assert types["strength-b"].category == ["chest", "legs"]
        assert types["strength-c"].category == ["back", "chest"]

    def test_every_strength_type_is_key(self):
        types = build_deterministic_session_types(ADRIAN_TEMPLATES)
        assert all(st.is_key for st in types)
        assert all(st.session_kind == "strength" for st in types)

    def test_label_from_slot_name(self):
        types = {st.key: st for st in build_deterministic_session_types(ADRIAN_TEMPLATES)}
        assert types["strength-a"].label == "Bench Variant + Legs"

    def test_no_templates_gives_no_types(self):
        assert build_deterministic_session_types([]) == []

    def test_rows_missing_slot_are_skipped(self):
        types = build_deterministic_session_types([{"garmin_category": "SQUAT"}])
        assert types == []


class TestBuildDeterministicWeeklyTargets:
    def test_matching_cadence_gives_one_target_per_slot(self):
        types = build_deterministic_session_types(ADRIAN_TEMPLATES)
        recurring = [
            {"session_type": "strength", "importance": "must"},
            {"session_type": "strength", "importance": "must"},
            {"session_type": "strength", "importance": "must"},
        ]
        targets, note = build_deterministic_weekly_targets(types, recurring)
        assert note is None
        assert {t.session_type_key for t in targets} == {"strength-a", "strength-b", "strength-c"}
        assert all(t.min_per_week == 1 and t.max_per_week == 1 for t in targets)

    def test_mismatched_cadence_gives_empty_targets_and_a_note(self):
        types = build_deterministic_session_types(ADRIAN_TEMPLATES)
        recurring = [{"session_type": "strength", "importance": "must"}]  # only 1, but 3 slots
        targets, note = build_deterministic_weekly_targets(types, recurring)
        assert targets == []
        assert note is not None
        assert "1/week" in note or "1" in note

    def test_should_importance_not_counted_toward_cadence(self):
        types = build_deterministic_session_types(ADRIAN_TEMPLATES)
        recurring = [
            {"session_type": "strength", "importance": "must"},
            {"session_type": "strength", "importance": "must"},
            {"session_type": "strength", "importance": "must"},
            {"session_type": "strength", "importance": "should"},
        ]
        targets, note = build_deterministic_weekly_targets(types, recurring)
        assert note is None
        assert len(targets) == 3


class TestBuildDeterministicLegSpacingConstraint:
    def test_default_gap(self):
        sc = build_deterministic_leg_spacing_constraint()
        assert sc.from_category == "legs"
        assert sc.to_category == "key-run"
        assert sc.min_gap_hours == 24
        assert sc.direction == "before"

    def test_custom_gap(self):
        sc = build_deterministic_leg_spacing_constraint(min_gap_hours=72)
        assert sc.min_gap_hours == 72


class TestBuildDeterministicRecoverySpacingConstraints:
    def test_generates_self_and_cross_pairs(self):
        types = build_deterministic_session_types(ADRIAN_TEMPLATES)
        constraints = build_deterministic_recovery_spacing_constraints(types)
        pairs = {(c.from_category, c.to_category) for c in constraints}
        # Real tags present across ADRIAN_TEMPLATES: chest (A/B/C), legs (A/B), back (C).
        assert pairs == {
            ("back", "back"), ("back", "chest"), ("back", "legs"),
            ("chest", "chest"), ("chest", "legs"),
            ("legs", "legs"),
        }
        assert all(c.direction == "either" for c in constraints)
        assert all(c.min_gap_hours == 48 for c in constraints)

    def test_custom_gap(self):
        types = build_deterministic_session_types(ADRIAN_TEMPLATES)
        constraints = build_deterministic_recovery_spacing_constraints(types, min_gap_hours=12)
        assert all(c.min_gap_hours == 12 for c in constraints)

    def test_no_strength_types_gives_no_constraints(self):
        assert build_deterministic_recovery_spacing_constraints([]) == []
