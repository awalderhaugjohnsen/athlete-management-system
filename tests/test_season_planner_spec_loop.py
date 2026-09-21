"""Control-flow tests for season_planner_node.author_feasible_spec — the bounded corrective-
feedback retry loop that assembles a ProgramSpec from an LLM draft and validates it (Pydantic
reference checks, then solve_schedule feasibility) before it's ever written as active. No real
LLM call: author_fn is dependency-injected, so a fake stands in and asserts on call count /
feedback content instead.
"""
import pytest

from services.ai.langgraph.nodes.season_planner_node import (
    ProgramSpecInfeasibleError,
    author_feasible_spec,
)
from services.ai.langgraph.schemas.agent_outputs import Question
from services.ai.langgraph.schemas.program_spec_outputs import (
    NewSessionTypeDraft,
    SeasonPlannerOutput,
    SeasonProgramSpecDraft,
)
from services.scheduling.program_spec import ProgramSessionType, SpacingConstraint, WeeklyTarget

DETERMINISTIC_TYPES = [
    ProgramSessionType(key="strength-a", category=["leg-strength"], label="A", session_kind="strength", is_key=True),
]
LEG_SPACING = SpacingConstraint(from_category="leg-strength", to_category="key-run", min_gap_hours=48)
CURRENT_DATE = {"date": "2026-08-24", "day_name": "Monday"}  # a Monday, for a clean full week

TEMPO_RUN_TYPE = NewSessionTypeDraft(key="tempo-run", category="key-run", label="Tempo", session_kind="run", is_key=True)


def _output(draft: SeasonProgramSpecDraft) -> SeasonPlannerOutput:
    return SeasonPlannerOutput(output="# Season Plan", program_spec=draft)


def _hitl_output() -> SeasonPlannerOutput:
    return SeasonPlannerOutput(
        output=[Question(id="q1", message="?", context=None, message_type="question")],
        program_spec=None,
    )


class TestFeasibleOnFirstAttempt:
    @pytest.mark.asyncio
    async def test_returns_immediately_with_spec(self):
        calls = []

        async def author_fn(feedback):
            calls.append(feedback)
            return _output(SeasonProgramSpecDraft(
                new_session_types=[TEMPO_RUN_TYPE], spec_rationale="r",
            ))

        _agent_output, spec = await author_feasible_spec(
            author_fn,
            deterministic_types=DETERMINISTIC_TYPES,
            deterministic_targets=[],
            leg_spacing_constraint=LEG_SPACING,
            recovery_spacing_constraints=[],
            current_date=CURRENT_DATE,
            max_check_weeks=1,
        )
        assert spec is not None
        assert len(calls) == 1
        assert calls[0] is None  # no feedback on the first attempt


class TestAllowMultiSessionDaysThreadsThrough:
    @pytest.mark.asyncio
    async def test_defaults_false(self):
        async def author_fn(feedback):
            return _output(SeasonProgramSpecDraft(new_session_types=[TEMPO_RUN_TYPE], spec_rationale="r"))

        _agent_output, spec = await author_feasible_spec(
            author_fn,
            deterministic_types=DETERMINISTIC_TYPES,
            deterministic_targets=[],
            leg_spacing_constraint=LEG_SPACING,
            recovery_spacing_constraints=[],
            current_date=CURRENT_DATE,
            max_check_weeks=1,
        )
        assert spec is not None
        assert spec.allow_multi_session_days is False

    @pytest.mark.asyncio
    async def test_true_when_athlete_opted_in(self):
        async def author_fn(feedback):
            return _output(SeasonProgramSpecDraft(new_session_types=[TEMPO_RUN_TYPE], spec_rationale="r"))

        _agent_output, spec = await author_feasible_spec(
            author_fn,
            deterministic_types=DETERMINISTIC_TYPES,
            deterministic_targets=[],
            leg_spacing_constraint=LEG_SPACING,
            recovery_spacing_constraints=[],
            current_date=CURRENT_DATE,
            max_check_weeks=1,
            allow_multi_session_days=True,
        )
        assert spec is not None
        assert spec.allow_multi_session_days is True


class TestHitlQuestionsShortCircuit:
    @pytest.mark.asyncio
    async def test_returns_none_spec_without_solving(self):
        async def author_fn(feedback):
            return _hitl_output()

        agent_output, spec = await author_feasible_spec(
            author_fn,
            deterministic_types=DETERMINISTIC_TYPES,
            deterministic_targets=[],
            leg_spacing_constraint=LEG_SPACING,
            recovery_spacing_constraints=[],
            current_date=CURRENT_DATE,
            max_check_weeks=1,
        )
        assert spec is None
        assert isinstance(agent_output.output, list)


class TestInvalidThenValid:
    @pytest.mark.asyncio
    async def test_recovers_on_second_attempt_with_feedback(self):
        calls = []

        async def author_fn(feedback):
            calls.append(feedback)
            if len(calls) == 1:
                return _output(SeasonProgramSpecDraft(
                    new_session_types=[TEMPO_RUN_TYPE],
                    weekly_targets=[WeeklyTarget(session_type_key="ghost-key", min_per_week=1, max_per_week=1)],
                    spec_rationale="r",
                ))
            return _output(SeasonProgramSpecDraft(new_session_types=[TEMPO_RUN_TYPE], spec_rationale="r"))

        _agent_output, spec = await author_feasible_spec(
            author_fn,
            deterministic_types=DETERMINISTIC_TYPES,
            deterministic_targets=[],
            leg_spacing_constraint=LEG_SPACING,
            recovery_spacing_constraints=[],
            current_date=CURRENT_DATE,
            max_check_weeks=1,
        )
        assert spec is not None
        assert len(calls) == 2
        assert calls[0] is None
        assert calls[1] is not None
        assert "ghost-key" in calls[1] or "invalid" in calls[1].lower()


class TestExhaustedInfeasibleRaises:
    @pytest.mark.asyncio
    async def test_raises_after_max_attempts(self):
        calls = []

        async def author_fn(feedback):
            calls.append(feedback)
            return _output(SeasonProgramSpecDraft(
                new_session_types=[TEMPO_RUN_TYPE],
                # min=max=8 sessions/week for a type that only ever gets 1 day-slot per day,
                # over a 1-week (7-day) window — structurally infeasible every attempt.
                weekly_targets=[WeeklyTarget(session_type_key="strength-a", min_per_week=8, max_per_week=8)],
                spec_rationale="r",
            ))

        with pytest.raises(ProgramSpecInfeasibleError):
            await author_feasible_spec(
                author_fn,
                deterministic_types=DETERMINISTIC_TYPES,
                deterministic_targets=[],
                leg_spacing_constraint=LEG_SPACING,
                recovery_spacing_constraints=[],
                current_date=CURRENT_DATE,
                max_check_weeks=1,
                max_attempts=3,
            )
        assert len(calls) == 3
