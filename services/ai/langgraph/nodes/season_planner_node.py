import json
import logging
import os
from collections.abc import Awaitable, Callable
from datetime import date, datetime, timedelta

from pydantic import ValidationError

from services.ai.ai_settings import AgentRole
from services.ai.langgraph.schemas.program_spec_outputs import SeasonPlannerOutput
from services.ai.langgraph.state.training_analysis_state import TrainingAnalysisState
from services.ai.langgraph.utils.output_helper import extract_expert_output
from services.ai.model_config import ModelSelector
from services.ai.utils.plan_storage import FilePlanStorage
from services.ai.utils.retry_handler import AI_ANALYSIS_CONFIG, retry_with_backoff
from services.scheduling.live_state import resolve_today_pin
from services.scheduling.program_spec import ProgramSessionType, ProgramSpec
from services.scheduling.solver import solve_schedule
from services.scheduling.spec_bootstrap import (
    build_deterministic_leg_spacing_constraint,
    build_deterministic_recovery_spacing_constraints,
    build_deterministic_session_types,
    build_deterministic_weekly_targets,
)
from services.supabase.athlete_profile import get_recurring_session_requests, get_strength_session_templates
from services.supabase.program_specs import fetch_checkin_context, write_active_program_spec

from .node_base import (
    configure_node_tools,
    create_timing_entry,
    execute_node_with_error_handling,
    log_node_completion,
)
from .prompt_components import get_hitl_instructions, get_language_instructions, get_workflow_context
from .tool_calling_helper import handle_tool_calling_in_node

logger = logging.getLogger(__name__)

# Bounded corrective-feedback loop: nothing like this existed before (retry_with_backoff only
# retries Anthropic transport errors) — needed because a spec can be internally invalid (a bad
# session_type_key reference) or valid-but-infeasible (the solver can't satisfy it), and both
# are recoverable with the right feedback appended to the next attempt, not a transport retry.
MAX_SPEC_FEASIBILITY_ATTEMPTS = 3

# Rules in a ProgramSpec are weekly-periodic (nothing but a rare DayPin.fixed_date references a
# specific far-future calendar date), so checking the first 8 weeks proves the rule *combination*
# is feasible without burning solver time on a horizon that can run 12-24 weeks.
SPEC_FEASIBILITY_CHECK_MAX_WEEKS = 8


class ProgramSpecInfeasibleError(Exception):
    """No feasible/valid ProgramSpec could be authored within the attempt budget.

    Caught by execute_node_with_error_handling like any other node failure —
    becomes state["errors"], which cli/garmin_ai_coach_cli.py now checks
    before any Supabase write (see the fix alongside this one).
    """


SEASON_PLANNER_SYSTEM_PROMPT = """You are a strategic season planner.
## Goal
Create strategic season plans for long-term athletic development.
## Principles
- Strategic: Focus on macro-cycles and phases.
- Adaptive: Use expert insights to tailor the plan.
- Systematic: Ensure logical progression towards goals.
- Deliberate: You have deep knowledge of real periodization science (linear, undulating/DUP,
  block, conjugate, and high-frequency/high-volume approaches for strength; polarized,
  threshold-focused, and pyramidal approaches for endurance/VO2max). Do not default to the
  first generic template that comes to mind. This is YOUR expert judgment call, not a
  question for the athlete — weigh named alternatives against this athlete's own data and
  commit to a choice, the way a real coach would, rather than asking them to pick."""

SEASON_PLANNER_USER_PROMPT = """Create a STRATEGIC, HIGH-LEVEL season plan (12-24 weeks).

## Inputs
- Athlete: {athlete_name}
- Date: ```json {current_date} ```
- Competitions: ```json {competitions} ```

## Hard Constraints & Recurring Session Requests
These are non-negotiable at the macro level too — do not design phases that would be impossible
to honor week-to-week (e.g. a phase requiring 6 sessions when only 3 days are available), and
make sure recurring session requests remain plannable throughout every phase, not just some.
```markdown
{planning_context}
```

## Expert Insights
### Metrics
```markdown
{metrics_insights}
```
### Activity
```markdown
{activity_insights}
```
### Physiology
```markdown
{physiology_insights}
```

## Task
Create a macro-cycle framework.
- **Integrate**: Use expert insights as your north star.
- **Strategize**: Define phases, themes, and focus areas.
- **Respect Boundaries**: Do NOT prescribe daily workouts (Weekly Planner's job).
- **Frequency vs Load**: When calling for smoother/controlled weekly training load, be explicit
  that this means smoothing total STRESS, not minimizing session COUNT — easy aerobic volume is
  a low-load way to sustain high session frequency and should be named as the tool for doing so
  wherever the athlete has asked for high frequency, rather than leaving "session count" ambiguous
  for the Weekly Planner to resolve.

## Output Requirements
Format as structured markdown.
1. **Phases**: Define phases (Base, Build, etc.) with goals and themes.
2. **Programming Methodology**: For BOTH strength and cardio/VO2max development, teach your
   reasoning explicitly:
   - Name 2-3 real, applicable periodization approaches for each (e.g. linear, undulating/DUP,
     block, conjugate, or high-frequency/high-volume for strength; polarized, threshold-focused,
     or pyramidal for cardio).
   - For each approach named, state its key trade-off for THIS athlete specifically — reference
     their training age, recent strength/performance trend, weekly session frequency, and
     timeline to their goal/competition.
   - State which approach (or blend) you are choosing and why, in plain language a self-coached
     athlete could later apply without you.
   - **Accessory work confirmation (required)**: Explicitly confirm the chosen approach retains
     meaningful accessory/isolation work alongside primary compound lifts, unless the athlete has
     explicitly asked to minimize it. State this as its own sentence, not folded into other text.
   Write for an athlete who wants to understand and eventually self-program — explain the "why,"
   not just the "what."
3. **Weekly Session Structure (required, concrete)**: Translate the Programming Methodology you
   just chose into an explicit, itemized structural spec — do not stop at naming the approach.
   - State exactly how many times per week each major lift/movement pattern will be trained (e.g.
     "Bench: 3x/week", "Squat: 2x/week"), grounded in the athlete's actual available session count
     from the Hard Constraints above and whatever training-age/strength-trend signal the Expert
     Insights provide. If no strength-benchmark or training-age signal is available in the inputs,
     say so explicitly (e.g. "no 1RM or training-age data provided — frequency below is derived
     from session count and equipment only") rather than inventing false specificity.
   - State how movement patterns combine into sessions where relevant (e.g. "Session 1: bench
     only; Session 2: bench + squat variant; Session 3: bench + posterior-chain variant" for a
     high-frequency/hybrid approach, or "Session 1: full upper; Session 2: full lower" for a
     simpler split). Choose whatever combination pattern actually follows from the approach you
     picked in item 2 — do not default to a generic Upper/Lower/Push-Pull split unless that split
     is genuinely what your chosen approach calls for for this athlete.
   - This is what the Weekly Planner will follow literally. Vague language like "train frequently"
     or "balance upper and lower" is not sufficient — use concrete counts and named combinations.
   - Keep this section itemized and terse (a short list per lift/pattern) — this is a spec to be
     followed, not additional prose to be read for flavor.
   - **Also populate the structured `program_spec` field** (see below) with the same decisions —
     this is what actually gets checked and enforced, not just described.
4. **Expert Rationale**: Explicitly reference how Metrics, Activity, and Physiology informed the plan.
5. **Constraints**: Qualitative constraints derived from experts.

**Stay high-level** for Phases and Constraints — that's still the map, not the turn-by-turn
navigation. **Weekly Session Structure** should be concrete and itemized but still compact — short
list entries, not paragraphs. Give **Programming Methodology** enough room to actually teach: a
few sentences per approach considered is appropriate and expected. **BE CONCISE everywhere else.**"""

PROGRAM_SPEC_INSTRUCTIONS = """
## Structured Program Spec (program_spec field, required alongside the prose plan)
In addition to the prose plan above, populate `program_spec` — a structured, machine-checkable
version of your Weekly Session Structure decisions. A generic solver verifies it's actually
satisfiable before it takes effect, so be concrete and precise here, not just descriptive.

### Existing Strength Session Types (fixed — real saved data, do not redefine)
{strength_types_block}{mismatch_block}
These already have a weekly target and the athlete's fixed 24h leg-spacing-before-key-run rule
applied automatically — do not redefine them in program_spec.new_session_types, and never invent
a different strength session type.

### Leave room — this spec is checked every week, not just written once
Every day_pin and every exact weekly_targets count removes a degree of freedom from the solver
permanently, for the whole horizon — not just for this week. A spec that pins every weekday and
gives every session type min==max leaves the solver nothing to actually decide: the schedule
becomes one fixed template repeated every week, and a check-in's overrides only ever get to move
whatever that week's note explicitly names. Author the loosest spec that still faithfully
represents your Weekly Session Structure decisions above — do not add structure "for rhythm" or
"for predictability" beyond what you actually argued for in prose.

### Your job in program_spec
- new_session_types: define every run/cross/rest session type your Weekly Session Structure
  calls for (e.g. 'tempo-run', 'easy-run', 'rest'). Label any hard/key run type's category as
  exactly 'key-run' — the fixed 24h leg-spacing rule above only binds to that exact category name.
- weekly_targets: how many times per week each of your new session types occurs. Prefer a range
  (min_per_week < max_per_week) over an exact count — e.g. easy-run min=1/max=3 rather than
  exactly 2 — so a short week or a deload doesn't read as a violation and a check-in has real room
  to add or drop a session. Use an exact count (min==max) only where the session type genuinely
  must happen a fixed number of times (a key/hard session tied to the phase's actual dose), and
  say why in spec_rationale when you do.
- spacing_constraints: any further spacing rules beyond the fixed leg-spacing one above (e.g. no
  two key runs on adjacent days).
- day_pins: ONLY for a genuine external constraint forcing a specific day — a running club, a
  class, a training partner, a fixed work/study commitment. Use 'fixed' for those. Do NOT add a
  day_pin just to give a session type a normal weekly rhythm or a predictable slot — that is what
  the solver and spacing_constraints are for, and pinning every session to a day removes the
  athlete's ability to have the schedule actually respond to a check-in. 'preferred' is for a real
  but softer version of the same thing (a mild scheduling reason, not just structural habit) —
  it is not a default to reach for on every session type. If nothing needs pinning, leave day_pins
  empty; that is the expected common case, not a gap to fill.
- progression_schemes: only if you're defining a NEW progression beyond the athlete's existing
  bench wave (handled separately, unaffected by this) — e.g. a squat-specific progression.
- rest_policy: minimum rest days/week, only if your chosen approach genuinely calls for one.
- horizon_weeks: match the season plan's horizon stated above.
- spec_rationale: 1-3 sentences on your key structural choices, including why any day_pin or
  exact weekly_targets count was necessary rather than left loose.
"""


def _build_solve_window(current_date: dict, weeks: int) -> list[date]:
    start = date.fromisoformat(current_date["date"])
    return [start + timedelta(days=i) for i in range(weeks * 7)]


async def author_feasible_spec(
    author_fn: Callable[[str | None], Awaitable[SeasonPlannerOutput]],
    *,
    deterministic_types: list[ProgramSessionType],
    deterministic_targets: list,
    leg_spacing_constraint,
    recovery_spacing_constraints: list,
    current_date: dict,
    max_check_weeks: int,
    pinned_events_for: Callable[[ProgramSpec], dict[date, str]] = lambda spec: {},
    max_attempts: int = MAX_SPEC_FEASIBILITY_ATTEMPTS,
) -> tuple[SeasonPlannerOutput, ProgramSpec | None]:
    """Calls author_fn(feedback) up to max_attempts times, assembling and feasibility-checking a
    ProgramSpec from each attempt's draft, feeding corrective feedback (a Pydantic validation
    error, or the solver's infeasible_reasons) back into the next attempt.

    Returns (agent_output, spec) — spec is None when agent_output is HITL questions (nothing to
    validate/activate this round). Raises ProgramSpecInfeasibleError if every attempt is
    exhausted without a valid, feasible spec.

    Dependency-injected (author_fn takes only the corrective feedback string, not a fixed
    prompt) so this control flow is testable without a real LLM call — see
    tests/test_season_planner_spec_loop.py.
    """
    feedback: str | None = None
    last_reasons: list[str] = []

    for attempt in range(1, max_attempts + 1):
        agent_output = await author_fn(feedback)

        if isinstance(agent_output.output, list):
            return agent_output, None

        draft = agent_output.program_spec
        assert draft is not None  # enforced by SeasonPlannerOutput's model_validator

        try:
            session_types = deterministic_types + [
                ProgramSessionType(**nt.model_dump()) for nt in draft.new_session_types
            ]
            spec = ProgramSpec(
                session_types=session_types,
                weekly_targets=deterministic_targets + draft.weekly_targets,
                spacing_constraints=[
                    leg_spacing_constraint, *recovery_spacing_constraints, *draft.spacing_constraints,
                ],
                day_pins=draft.day_pins,
                progression_schemes=draft.progression_schemes,
                rest_policy=draft.rest_policy,
                horizon_weeks=draft.horizon_weeks,
            )
        except ValidationError as exc:
            last_reasons = [str(exc)]
            feedback = (
                f"Your program_spec was invalid: {exc}\n"
                f"Valid existing session_type_keys are: {[st.key for st in deterministic_types]} "
                "— plus whatever unique keys you define yourself in new_session_types."
            )
            logger.warning("Season planner attempt %d: invalid ProgramSpec (%s)", attempt, exc)
            continue

        window = _build_solve_window(current_date, min(spec.horizon_weeks, max_check_weeks))
        result = solve_schedule(spec, window, pinned_events=pinned_events_for(spec))

        if result.feasible:
            return agent_output, spec

        last_reasons = result.infeasible_reasons or []
        feedback = (
            "The schedule you designed is infeasible:\n"
            + "\n".join(f"- {r}" for r in last_reasons)
            + "\nRevise weekly_targets/spacing_constraints/day_pins so a valid schedule exists."
        )
        logger.warning("Season planner attempt %d: infeasible spec (%s)", attempt, last_reasons)

    raise ProgramSpecInfeasibleError(
        f"Could not author a feasible ProgramSpec after {max_attempts} attempts: {last_reasons}"
    )


async def season_planner_node(state: TrainingAnalysisState) -> dict[str, list | str]:
    logger.info("Starting season planner node")

    hitl_enabled = state.get("hitl_enabled", True)
    logger.info("Season planner node: HITL %s", "enabled" if hitl_enabled else "disabled")

    agent_start_time = datetime.now()

    tools = configure_node_tools(
        agent_name="season_planner",
        plot_storage=None,
        plotting_enabled=False,
    )

    system_prompt = (
        SEASON_PLANNER_SYSTEM_PROMPT +
        get_workflow_context("season_planner") +
        (get_hitl_instructions("season_planner") if hitl_enabled else "") +
        get_language_instructions(state.get("language"))
    )

    qa_messages_raw = state.get("season_planner_messages", [])
    qa_messages = []
    for msg in qa_messages_raw:
        if hasattr(msg, "type"):
            role = "assistant" if msg.type == "ai" else "user"
            qa_messages.append({"role": role, "content": msg.content})
        else:
            qa_messages.append(msg)

    existing_season_plan = ""
    try:
        storage = FilePlanStorage()
        loaded_plan = storage.load_plan(state["user_id"], "season_plan")
        if loaded_plan:
            existing_season_plan = loaded_plan
    except Exception as exc:
        logger.warning("Could not read existing season plan: %s", exc)

    # state["user_id"] is a FilePlanStorage key (always the literal "cli_user"), NOT the real
    # Supabase auth id — weekly_planner_node.py/plan_writer.py already get this right by reading
    # SUPABASE_USER_ID directly; this node's new Supabase write must follow the same pattern.
    supabase_user_id = os.environ.get("SUPABASE_USER_ID")
    if not supabase_user_id:
        raise ValueError("SUPABASE_USER_ID must be set to author a ProgramSpec")

    strength_templates = get_strength_session_templates(supabase_user_id)
    recurring_requests = get_recurring_session_requests(supabase_user_id)
    deterministic_types = build_deterministic_session_types(strength_templates)
    deterministic_targets, mismatch_note = build_deterministic_weekly_targets(
        deterministic_types, recurring_requests
    )
    leg_spacing_constraint = build_deterministic_leg_spacing_constraint()
    recovery_spacing_constraints = build_deterministic_recovery_spacing_constraints(deterministic_types)

    strength_types_block = "\n".join(
        f"- key={st.key!r}, category={st.category!r}, label={st.label!r}"
        for st in deterministic_types
    ) or "No saved strength session templates."
    mismatch_block = f"\n\nNote: {mismatch_note}" if mismatch_note else ""

    planning_context_full = state.get("planning_context", "") or ""
    soft_prefs_idx = planning_context_full.find("=== SOFT PREFERENCES")
    season_planning_context = (
        planning_context_full[:soft_prefs_idx].strip() if soft_prefs_idx != -1 else planning_context_full
    )

    user_prompt_content = SEASON_PLANNER_USER_PROMPT.format(
        athlete_name=state["athlete_name"],
        current_date=json.dumps(state["current_date"], indent=2),
        competitions=json.dumps(state["competitions"], indent=2),
        planning_context=season_planning_context or "No specific constraints or recurring session requests.",
        metrics_insights=extract_expert_output(state.get("metrics_outputs"), "for_season_planner"),
        activity_insights=extract_expert_output(state.get("activity_outputs"), "for_season_planner"),
        physiology_insights=extract_expert_output(state.get("physiology_outputs"), "for_season_planner"),
    )
    user_prompt_content += PROGRAM_SPEC_INSTRUCTIONS.format(
        strength_types_block=strength_types_block, mismatch_block=mismatch_block
    )
    if existing_season_plan:
        user_prompt_content += (
            "\n\n## Existing Season Plan\nWe have an existing season plan. Do NOT start from "
            "scratch. Review this plan against the new expert insights. If the plan is still "
            "valid, maintain the phase structure and just refine the details. Only trigger a "
            "full replan if the new data suggests the old plan is dangerously off-track.\n\n"
            f"```markdown\n{existing_season_plan}\n```"
        )

    base_messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt_content},
    ]

    base_llm = ModelSelector.get_llm(AgentRole.SEASON_PLANNER)
    llm_with_tools = base_llm.bind_tools(tools) if tools else base_llm
    llm_with_structure = llm_with_tools.with_structured_output(SeasonPlannerOutput)

    async def author_and_validate_spec(feedback: str | None) -> SeasonPlannerOutput:
        messages = base_messages + qa_messages
        if feedback:
            messages = [*messages, {
                "role": "user",
                "content": f"## Correction Needed\n{feedback}\n\nRevise program_spec accordingly; "
                "keep the prose plan unless it also needs to change.",
            }]

        async def call_season_planning():
            if tools:
                return await handle_tool_calling_in_node(
                    llm_with_tools=llm_with_structure,
                    messages=messages,
                    tools=tools,
                    max_iterations=15,
                )
            return await llm_with_structure.ainvoke(messages)

        return await retry_with_backoff(call_season_planning, AI_ANALYSIS_CONFIG, "Season Planning")

    async def node_execution():
        today_row = None
        today_strength_row = None
        try:
            today_row, today_strength_row, _ = fetch_checkin_context(supabase_user_id, [date.today()])
        except Exception as exc:
            logger.warning("Could not fetch today's committed session for spec feasibility check: %s", exc)

        agent_output, spec = await author_feasible_spec(
            author_and_validate_spec,
            deterministic_types=deterministic_types,
            deterministic_targets=deterministic_targets,
            leg_spacing_constraint=leg_spacing_constraint,
            recovery_spacing_constraints=recovery_spacing_constraints,
            current_date=state["current_date"],
            max_check_weeks=SPEC_FEASIBILITY_CHECK_MAX_WEEKS,
            pinned_events_for=lambda s: resolve_today_pin(date.today(), today_row, today_strength_row, s) if today_row else {},
        )

        if spec is not None:
            assert agent_output.program_spec is not None
            write_active_program_spec(
                user_id=supabase_user_id,
                spec=spec,
                rationale=agent_output.program_spec.spec_rationale,
                effective_from=date.today(),
                source="llm_authored",
            )

        execution_time = (datetime.now() - agent_start_time).total_seconds()
        log_node_completion("Season planning", execution_time)
        return {
            "season_plan": agent_output.model_dump(),
            "timings": [create_timing_entry("season_planner", execution_time)],
        }

    return await execute_node_with_error_handling(
        node_name="Season planner",
        node_function=node_execution,
        error_message_prefix="Season planning failed",
    )
