import logging
from datetime import datetime

from services.ai.ai_settings import AgentRole
from services.ai.langgraph.state.training_analysis_state import TrainingAnalysisState
from services.ai.model_config import ModelSelector
from services.ai.utils.retry_handler import AI_ANALYSIS_CONFIG, retry_with_backoff

from .node_base import create_timing_entry, execute_node_with_error_handling, log_node_completion
from .prompt_components import get_language_instructions, get_workflow_context
from .tool_calling_helper import extract_text_content

logger = logging.getLogger(__name__)

NUTRITION_PLANNER_SYSTEM_PROMPT = """## Goal
Produce a concrete, day-by-day nutrition plan for the next 4 weeks, anchored to the athlete's
training schedule. Targets must be specific (kcal, protein g, carbs g, fat g) and vary by day type.

## Principles
- Training-coupled: Hard training days need more carbs and total calories than rest days.
- Protein floor: Protein targets should never drop below 1.6g/kg bodyweight regardless of day type.
- Realistic: Targets should be achievable — avoid extreme deficits/surpluses (>500 kcal/day).
- Phase-aware: Bulk / maintenance / cut targets must align with the season planner's phase.
- Trackable: Outputs should be phrased so the athlete can easily log them day to day."""

NUTRITION_PLANNER_USER_PROMPT = """## Task
Produce a 4-week daily nutrition plan aligned to the athlete's training schedule.

## Inputs

### Training Plan (Weekly Planner Output)
{weekly_plan}

### Nutrition Expert Signals
{nutrition_signals}

### Athlete Context
{analysis_context}

### Current Date
{current_date}

## Output Format
Produce a structured nutrition plan with:

### 1. Macro Framework
A table defining targets by day type:
| Day Type | Calories | Protein (g) | Carbs (g) | Fat (g) |
|---|---|---|---|---|
| Rest day | ... | ... | ... | ... |
| Easy training | ... | ... | ... | ... |
| Hard/long session | ... | ... | ... | ... |
| Recovery day (post-hard) | ... | ... | ... | ... |

### 2. Week-by-Week Overview
For each of the 4 weeks, map the macro framework to the actual planned sessions.
Show which days are which day type and the resulting daily targets.

### 3. Key Nutrition Priorities
3-5 bullet points of the highest-leverage nutrition habits for this training block
(e.g. pre-workout carb timing, post-session protein window, hydration on hard days).

### 4. Daily Goal Recommendation
Suggest what to set as daily nutrition goals (use the most common day type's targets as the base,
and instruct the athlete to manually adjust on hard days).

Keep the plan concrete and immediately actionable."""


async def nutrition_planner_node(state: TrainingAnalysisState) -> dict[str, list | str]:
    logger.info("Starting nutrition planner node")

    weekly_plan = state.get("weekly_plan") or "No weekly plan available yet."
    nutrition_outputs = state.get("nutrition_outputs")

    if nutrition_outputs and hasattr(nutrition_outputs, "output"):
        output = nutrition_outputs.output
        if hasattr(output, "for_weekly_planner"):
            nutrition_signals = (
                f"Signals: {output.for_weekly_planner.signals}\n"
                f"Evidence: {output.for_weekly_planner.evidence}\n"
                f"Implications: {output.for_weekly_planner.implications}"
            )
        else:
            nutrition_signals = "No structured nutrition signals available."
    else:
        nutrition_signals = "Nutrition expert has not run or produced no output."

    system_prompt = (
        get_workflow_context("nutrition_planner")
        + NUTRITION_PLANNER_SYSTEM_PROMPT
        + get_language_instructions(state.get("language"))
    )
    user_content = NUTRITION_PLANNER_USER_PROMPT.format(
        weekly_plan=weekly_plan,
        nutrition_signals=nutrition_signals,
        analysis_context=state.get("analysis_context", ""),
        current_date=str(state.get("current_date", {})),
    )

    agent_start_time = datetime.now()

    async def call_llm():
        response = await ModelSelector.get_llm(AgentRole.NUTRITION_PLANNER).ainvoke(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ]
        )
        return extract_text_content(response)

    async def node_execution():
        nutrition_plan = await retry_with_backoff(call_llm, AI_ANALYSIS_CONFIG, "Nutrition Planner")
        execution_time = (datetime.now() - agent_start_time).total_seconds()
        log_node_completion("Nutrition planner", execution_time, 0)

        return {
            "nutrition_plan": nutrition_plan,
            "timings": [create_timing_entry("nutrition_planner", execution_time)],
        }

    return await execute_node_with_error_handling(
        node_name="Nutrition planner",
        node_function=node_execution,
        error_message_prefix="Nutrition planner failed",
    )
