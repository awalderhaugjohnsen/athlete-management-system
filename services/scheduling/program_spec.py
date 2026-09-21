"""Structured, athlete-specific training rules — data, not Python.

Replaces what used to be hardcoded per-athlete assumptions scattered across
weekly_planner_node.py (the 48h leg-before-hard-run threshold, which strength
slots carry legs, "3 sessions/week") and bench_wave.py (the 10-8-5-3 rep wave).
Those were all correct FOR ADRIAN but required editing Python to change, and had
no representation a solver could check for global feasibility.

A ProgramSpec is a closed, small vocabulary of rule *types* — WeeklyTarget,
SpacingConstraint, DayPin, ProgressionScheme, RestPolicy. The coach (LLM, at
season-planning time) fills in *values* for a given athlete; it never invents a
new rule type. services/scheduling/solver.py is the one generic, athlete-agnostic
engine that enforces any given spec. See the memory
project_leg_spacing_structural_limit and the plan this shipped under for the
motivating bug (a 2026-08-25 check-in silently lost 3 of 18 required strength
sessions and left 2 unresolved spacing violations because the old approach had no
persistent target to check against).
"""
from __future__ import annotations

from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

# The 4 real time-of-day buckets a session can be scheduled into. Deliberately excludes the
# storage-layer 'day' sentinel (migration 045) — that value only exists on scheduled_days/
# strength_sessions rows to mean "unslotted, single-session-per-date convention"; a ProgramSpec
# never authors 'day' itself, only these 4 real slots (or leaves time_slot unset for "any slot").
TimeSlot = Literal["morning", "midday", "afternoon", "evening"]


class ProgramSessionType(BaseModel):
    """One kind of session this athlete's program uses.

    Athlete-defined — a different athlete's spec can have entirely different
    keys/categories.
    """

    key: str = Field(..., description="Unique identifier, e.g. 'strength-a'.")
    category: list[str] = Field(
        ...,
        description=(
            "Tags used by spacing_constraints and progression_schemes. A session "
            "type can carry more than one — e.g. a strength slot combining a "
            "bench press and a squat is both 'chest' and 'legs' — a "
            "SpacingConstraint binds if EITHER session in a pair carries the "
            "referenced tag. Multiple session types can share a tag."
        ),
    )

    @field_validator("category", mode="before")
    @classmethod
    def _wrap_bare_category_string(cls, v: Any) -> Any:
        """Accept a bare string for back-compat with specs stored before category
        became list-valued (e.g. {"category": "leg-strength"}) — wrap it into a
        single-item list rather than forcing every previously-stored
        program_specs row to be re-authored before it can be read again.
        """
        return [v] if isinstance(v, str) else v
    label: str = Field(..., description="Human-readable name.")
    session_kind: Literal["strength", "run", "cross", "rest"] = Field(
        ..., description="Broad kind, for rendering/downstream routing."
    )
    is_key: bool = Field(
        default=False,
        description="Hard/long/race session that shouldn't be moved lightly.",
    )


class WeeklyTarget(BaseModel):
    """How many times per week a session type must/should occur.

    Generalizes athlete_profile.recurring_session_requests.
    """

    session_type_key: str
    min_per_week: int = Field(..., ge=0)
    max_per_week: int = Field(..., ge=0)
    importance: Literal["must", "should"] = "must"

    @model_validator(mode="after")
    def _check_range(self) -> WeeklyTarget:
        if self.max_per_week < self.min_per_week:
            raise ValueError(
                f"max_per_week ({self.max_per_week}) < min_per_week "
                f"({self.min_per_week}) for {self.session_type_key!r}"
            )
        return self


class SpacingConstraint(BaseModel):
    """A minimum gap between two session categories.

    Generalizes the hardcoded leg-before-hard-run rule in
    weekly_planner_node.py::_fix_legs_before_hard_runs into per-athlete data —
    a different athlete's spec can use a different threshold, or none at all.
    (The rule's own value moved from an unresearched 48h to a research-backed
    24h in 2026-08-26 — see spec_bootstrap.py::build_deterministic_leg_spacing_constraint.)

    direction='before': if a from_category session lands on day d1 and a
    to_category session lands on a later day d2, (d2 - d1) must be >= min_gap_hours.
    direction='after': the mirror — a to_category session must be min_gap_hours
    before a later from_category session.
    direction='either': the gap applies regardless of which category comes first.
    """

    from_category: str
    to_category: str
    min_gap_hours: int = Field(..., gt=0)
    direction: Literal["before", "after", "either"] = "before"


class DayPin(BaseModel):
    """A session type pinned to a specific weekday or calendar date.

    Generalizes recurring_session_requests[].day_flexibility, which exists
    today but is only check-only
    (weekly_planner_node.py::_check_recurring_requests_honored) — never
    structurally enforced.
    """

    session_type_key: str
    day_of_week: Literal[
        "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"
    ] | None = None
    fixed_date: date | None = None
    flexibility: Literal["fixed", "preferred"] = "preferred"
    time_slot: TimeSlot | None = Field(
        default=None,
        description="Pin to a specific time-of-day slot within the day, if set. None means "
        "'that day, any slot' — today's behavior, unaffected. Only meaningful when the spec "
        "has allow_multi_session_days=True; ignored otherwise.",
    )

    @model_validator(mode="after")
    def _check_exactly_one_anchor(self) -> DayPin:
        if (self.day_of_week is None) == (self.fixed_date is None):
            raise ValueError(
                f"DayPin for {self.session_type_key!r} must set exactly one of "
                "day_of_week or fixed_date, not both or neither"
            )
        return self


class ProgressionScheme(BaseModel):
    """Deterministic phase progression for one session type.

    The generalized form of bench_wave.py's fixed 10-8-5-3 wave.
    'sessions_completed' anchoring (the bench-wave default) advances on real
    completed sessions, not calendar time, so plan shifts and layoffs don't
    desynchronize it (see bench_wave.py's module docstring for why that
    matters). 'calendar_date' anchoring is for things that must track a fixed
    date regardless of session count, e.g. a race taper.

    phases cycle in order, repeating once exhausted — phases[0] then phases[1]
    ... then phases[0] again, matching bench_wave's _BLOCK_REPS cycle of
    [10, 8, 5, 3]. Each phase is an arbitrary dict of prescription parameters
    (e.g. {"sets": 4, "reps_min": 10, "reps_max": 10, "rir": 2}) — the solver and
    progression engine don't interpret its contents, only the caller does.
    """

    session_type_key: str
    anchor_mode: Literal["sessions_completed", "calendar_date"] = "sessions_completed"
    anchor_date: date = Field(
        ..., description="Date counting begins from (bench_wave_start_date equivalent)."
    )
    sessions_per_week: int | None = Field(
        default=None,
        description=(
            "This athlete's real cadence for this session type — sets block "
            "length in sessions so the dose per block is constant regardless of "
            "frequency (see bench_wave.py). Required for anchor_mode="
            "'sessions_completed'."
        ),
    )
    weeks_per_block: int = Field(default=4, gt=0)
    deload_weeks_per_block: int = Field(default=1, ge=0)
    phases: list[dict[str, Any]] = Field(..., min_length=1)
    deload_overrides: dict[str, Any] = Field(
        default_factory=dict,
        description="Keys merged into the returned prescription when a session "
        "falls in the deload window, e.g. {'sets': 3} to drop volume without "
        "changing the rep target.",
    )

    @model_validator(mode="after")
    def _check_sessions_per_week_required(self) -> ProgressionScheme:
        if self.anchor_mode == "sessions_completed" and not self.sessions_per_week:
            raise ValueError(
                f"ProgressionScheme for {self.session_type_key!r} needs "
                "sessions_per_week when anchor_mode='sessions_completed'"
            )
        if self.deload_weeks_per_block > self.weeks_per_block:
            raise ValueError(
                f"deload_weeks_per_block ({self.deload_weeks_per_block}) can't "
                f"exceed weeks_per_block ({self.weeks_per_block}) for "
                f"{self.session_type_key!r}"
            )
        return self


class RestPolicy(BaseModel):
    min_rest_days_per_week: int = Field(default=0, ge=0, le=7)


class ProgramSpec(BaseModel):
    """The full per-athlete rule set.

    One row of supabase.program_specs.spec, versioned — see
    supabase/migrations/043_program_specs.sql.
    """

    session_types: list[ProgramSessionType] = Field(..., min_length=1)
    weekly_targets: list[WeeklyTarget] = Field(default_factory=list)
    spacing_constraints: list[SpacingConstraint] = Field(default_factory=list)
    day_pins: list[DayPin] = Field(default_factory=list)
    progression_schemes: list[ProgressionScheme] = Field(default_factory=list)
    rest_policy: RestPolicy = Field(default_factory=lambda: RestPolicy())
    horizon_weeks: int = Field(default=6, gt=0)
    allow_multi_session_days: bool = Field(
        default=False,
        description="Opt-in: when True, the solver may place more than one session per "
        "calendar day, across morning/midday/afternoon/evening slots. Off by default so "
        "every spec that predates this field — and every athlete who hasn't asked for it — "
        "keeps exactly one session/day, byte-identical to before this field existed.",
    )

    @model_validator(mode="after")
    def _check_session_type_keys_unique(self) -> ProgramSpec:
        keys = [st.key for st in self.session_types]
        if len(keys) != len(set(keys)):
            raise ValueError("session_types keys must be unique")
        return self

    @model_validator(mode="after")
    def _check_session_type_key_references(self) -> ProgramSpec:
        key_set = {st.key for st in self.session_types}
        for field_name, items in (
            ("weekly_targets", self.weekly_targets),
            ("day_pins", self.day_pins),
            ("progression_schemes", self.progression_schemes),
        ):
            for item in items:
                if item.session_type_key not in key_set:
                    raise ValueError(
                        f"{field_name} references unknown session_type_key "
                        f"{item.session_type_key!r}"
                    )
        return self

    @model_validator(mode="after")
    def _check_spacing_category_references(self) -> ProgramSpec:
        categories = {c for st in self.session_types for c in st.category}
        for sc in self.spacing_constraints:
            for category in (sc.from_category, sc.to_category):
                if category not in categories:
                    raise ValueError(
                        f"spacing_constraints references unknown category {category!r}"
                    )
        return self

    def session_type(self, key: str) -> ProgramSessionType:
        for st in self.session_types:
            if st.key == key:
                return st
        raise KeyError(key)
