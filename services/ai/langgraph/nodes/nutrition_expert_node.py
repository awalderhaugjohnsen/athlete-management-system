import json
import logging
from datetime import datetime

from services.ai.ai_settings import AgentRole
from services.ai.langgraph.schemas import NutritionExpertOutputs
from services.ai.langgraph.state.training_analysis_state import TrainingAnalysisState
from services.ai.langgraph.utils.message_helper import normalize_langchain_messages
from services.ai.model_config import ModelSelector
from services.ai.tools.plotting import PlotStorage
from services.ai.utils.retry_handler import AI_ANALYSIS_CONFIG, retry_with_backoff

from .node_base import (
    configure_node_tools,
    create_plot_entries,
    create_timing_entry,
    execute_node_with_error_handling,
    log_node_completion,
)
from .prompt_components import (
    get_hitl_instructions,
    get_language_instructions,
    get_plotting_instructions,
    get_workflow_context,
)
from .tool_calling_helper import handle_tool_calling_in_node

logger = logging.getLogger(__name__)

NUTRITION_SYSTEM_PROMPT_BASE = """## Goal
Analyze the athlete's nutritional state from training energy demands (Garmin). Surface energy
balance patterns, body composition signals, and caloric demand forecasts for downstream planners.

## Principles
- Evidence-based: Every inference must be backed by a specific data point from the summary.
- Load-coupled: Interpret expenditure in the context of training load — a rest-day pattern is
  different from a hard-session pattern.
- Non-prescriptive at this stage: Surface signals and implications; the nutrition planner acts on them.
- No intake data: There is no logged food-intake source. Work from Garmin-side signals only
  (body comp, body battery, expenditure trends) and flag that intake data is unavailable.

## Domains
1. **Caloric Demand**: Total expenditure (BMR + active, Garmin). Trend over time.
2. **Body Composition Trajectory**: Weight and body-fat trending aligned with current training phase?
3. **Energy Availability**: Body battery as a proxy for between-session fueling adequacy.
4. **Caloric Demand Forecast**: Given training load trends, what demand level does the next block require?"""

NUTRITION_USER_PROMPT = """## Task
Analyze the Garmin expenditure summary to surface energy balance patterns, expenditure trends,
and body composition signals.

## Constraints
- Focus ONLY on nutritional signals.
- Do NOT describe specific workouts (Activity Expert's job).
- Do NOT analyze training load patterns (Metrics Expert's job).
- Do NOT infer HRV or physiological adaptation (Physiology Expert's job).
- Do NOT prescribe specific meals, exact macro targets, or food choices — that is the planner's job.
- There is no intake data available — state this clearly and work from Garmin-side signals only.

## Inputs
### Nutrition Summary
{data}
### Context
- Competitions: ```json {competitions} ```
- Date: ```json {current_date} ```
- **User Context**: ``` {analysis_context} ```

## Output Requirements
Produce 3 structured fields. For EACH field:
- **Signals**: what the data shows
- **Evidence**: specific numbers, date ranges, deficits/surpluses in kcal
- **Implications**: what this means for this receiver's decisions
- **Uncertainty**: Garmin estimation error, inference limitations from expenditure-only data

### 1. `for_synthesis` (Comprehensive Report)
- **Goal**: Describe the athlete's nutritional reality — are they fueling adequately for their training?
- **Lead with**: caloric demand, body comp trajectory.

### 2. `for_season_planner` (12-24 Weeks)
- **Goal**: Identify the nutritional phase the athlete is likely in (surplus/deficit/maintenance,
  inferred from body comp trend) and whether it aligns with the training phase.
- **Lead with**: rate of body comp change, phase recommendation.

### 3. `for_weekly_planner` (Next 28 Days)
- **Goal**: Flag the most critical nutrition signals for the next 4 weeks of training.
- **Lead with**: acute under/over-fueling risk (from body battery + expenditure trend), recovery
  nutrition gaps, pre-competition loading needs."""

NUTRITION_FINAL_CHECKLIST = """
## Final Checklist
- State clearly that there is no logged intake data, and work from Garmin signals only.
- No meal prescriptions or specific food recommendations.
- Body composition interpreted relative to the athlete's stated goals."""


async def nutrition_expert_node(state: TrainingAnalysisState) -> dict[str, list | str | dict]:
    logger.info("Starting nutrition expert analysis node")

    plot_storage = PlotStorage(state["execution_id"])
    plotting_enabled = state.get("plotting_enabled", False)
    hitl_enabled = state.get("hitl_enabled", True)

    logger.info(
        "Nutrition expert: Plotting %s, HITL %s",
        "enabled" if plotting_enabled else "disabled",
        "enabled" if hitl_enabled else "disabled",
    )

    tools = configure_node_tools(
        agent_name="nutrition",
        plot_storage=plot_storage,
        plotting_enabled=plotting_enabled,
    )

    system_prompt = (
        get_workflow_context("nutrition")
        + NUTRITION_SYSTEM_PROMPT_BASE
        + (get_plotting_instructions("nutrition") if plotting_enabled else "")
        + (get_hitl_instructions("nutrition") if hitl_enabled else "")
        + NUTRITION_FINAL_CHECKLIST
        + get_language_instructions(state.get("language"))
    )

    base_llm = ModelSelector.get_llm(AgentRole.NUTRITION_EXPERT)
    llm_with_tools = base_llm.bind_tools(tools) if tools else base_llm
    llm_with_structure = llm_with_tools.with_structured_output(NutritionExpertOutputs)

    agent_start_time = datetime.now()

    async def call_nutrition_with_tools():
        qa_messages = normalize_langchain_messages(state.get("nutrition_expert_messages", []))

        base_messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": NUTRITION_USER_PROMPT.format(
                    data=state.get("nutrition_summary", "No nutrition summary available"),
                    competitions=json.dumps(state["competitions"], indent=2),
                    current_date=json.dumps(state["current_date"], indent=2),
                    analysis_context=state["analysis_context"],
                ),
            },
        ]

        return await handle_tool_calling_in_node(
            llm_with_tools=llm_with_structure,
            messages=base_messages + qa_messages,
            tools=tools,
            max_iterations=15,
        )

    async def node_execution():
        agent_output = await retry_with_backoff(
            call_nutrition_with_tools, AI_ANALYSIS_CONFIG, "Nutrition Agent with Tools"
        )
        logger.info("Nutrition expert analysis completed")

        execution_time = (datetime.now() - agent_start_time).total_seconds()

        plots, plot_storage_data, available_plots = create_plot_entries("nutrition", plot_storage)

        log_node_completion("Nutrition expert analysis", execution_time, len(available_plots))

        return {
            "nutrition_outputs": agent_output,
            "plots": plots,
            "plot_storage_data": plot_storage_data,
            "timings": [create_timing_entry("nutrition", execution_time)],
            "available_plots": available_plots,
        }

    return await execute_node_with_error_handling(
        node_name="Nutrition expert analysis",
        node_function=node_execution,
        error_message_prefix="Nutrition expert analysis failed",
    )
