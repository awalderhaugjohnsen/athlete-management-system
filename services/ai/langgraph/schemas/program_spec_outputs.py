"""Structured output for season_planner_node's ProgramSpec authoring (Phase 3).

Reuses the real services/scheduling/program_spec.py Pydantic models as nested
fields — no schema duplication. SeasonProgramSpecDraft holds only what the LLM
actually authors; the athlete's real strength session types and the 48h
leg-spacing floor are Python-injected separately (see
services/scheduling/spec_bootstrap.py) and merged in by season_planner_node.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from services.ai.langgraph.schemas.agent_outputs import Question
from services.scheduling.program_spec import (
    DayPin,
    ProgressionScheme,
    RestPolicy,
    SpacingConstraint,
    WeeklyTarget,
)


class NewSessionTypeDraft(BaseModel):
    """A run/cross/rest session type the LLM is introducing.

    Strength session types are Python-injected from the athlete's real saved
    templates (see spec_bootstrap.build_deterministic_session_types) — never
    authored here.
    """

    key: str = Field(..., description="Unique identifier, e.g. 'tempo-run'. Must not collide with any existing strength session_type_key given in the prompt.")
    category: str = Field(
        ...,
        description=(
            "Grouping used by spacing_constraints/progression_schemes. Use category "
            "'key-run' for any hard/key run session type — the fixed 24h leg-spacing "
            "constraint binds to that category name specifically."
        ),
    )
    label: str = Field(..., description="Human-readable name.")
    session_kind: Literal["run", "cross", "rest"] = Field(..., description="Strength is never authored here — see class docstring.")
    is_key: bool = Field(default=False, description="Hard/long session that shouldn't be moved lightly.")


class SeasonProgramSpecDraft(BaseModel):
    """Everything the LLM actually authors toward a ProgramSpec.

    Python assembles the final ProgramSpec by merging this with the
    deterministic strength session types/weekly targets/leg-spacing constraint
    injected separately — see season_planner_node.py.
    """

    new_session_types: list[NewSessionTypeDraft] = Field(default_factory=list)
    weekly_targets: list[WeeklyTarget] = Field(default_factory=list)
    spacing_constraints: list[SpacingConstraint] = Field(default_factory=list)
    day_pins: list[DayPin] = Field(default_factory=list)
    progression_schemes: list[ProgressionScheme] = Field(default_factory=list)
    rest_policy: RestPolicy = Field(default_factory=lambda: RestPolicy())
    horizon_weeks: int = Field(default=6, gt=0)
    spec_rationale: str = Field(
        ...,
        description="1-3 sentences on the key structural choices (weekly frequencies, "
        "spacing, progression) — stored verbatim in program_specs.rationale.",
    )


class SeasonPlannerOutput(BaseModel):
    """Season planner output: EITHER HITL questions OR the prose plan + a structured spec.

    program_spec is required exactly when output is the final prose plan
    (not HITL questions).
    """

    output: list[Question] | str = Field(
        ...,
        description="EITHER questions for HITL OR the complete prose season plan markdown.",
    )
    program_spec: SeasonProgramSpecDraft | None = Field(
        None,
        description="Required when output is the final prose plan. Omit (leave null) when output is HITL questions.",
    )

    @model_validator(mode="after")
    def _check_program_spec_present_for_final_answer(self) -> SeasonPlannerOutput:
        if isinstance(self.output, str) and self.program_spec is None:
            raise ValueError("program_spec is required when output is the final prose plan, not HITL questions")
        return self
