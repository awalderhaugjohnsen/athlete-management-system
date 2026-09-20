from services.ai.ai_settings import AgentRole
from services.ai.langgraph.state.training_analysis_state import TrainingAnalysisState

from .data_summarizer_node import create_data_summarizer_node

NUTRITION_SUMMARIZER_SYSTEM_PROMPT = """## Goal
Extract and organize nutrition-relevant data from Garmin: energy expenditure and body composition.
## Principles
- Factual: Numbers only. No dietary advice or interpretation.
- Transparent Compression: Show date ranges and aggregation windows explicitly.
- Missing data: Flag explicitly if a metric is absent."""

NUTRITION_SUMMARIZER_USER_PROMPT = """## Task
Extract and structure all nutrition-relevant data for the Nutrition Expert: what the athlete BURNED,
per Garmin's energy expenditure and body composition data.

## Constraints
- NO interpretation or dietary advice.
- Show missing data and gaps explicitly.
- Use transparent compression for long time series.

## Required Structure

### Energy Expenditure & Body State (Garmin)
1. **Body Composition Timeline**: weight_kg and any body-fat/muscle metrics with dates.
2. **Daily Caloric Expenditure**: total_calories, active_calories, bmr_calories per day.
3. **Energy Readiness**: body battery trend (daily end-of-day values).
4. **Training Load**: daily training load (for expenditure correlation).

### Data Quality
5. **Coverage Notes**: date range, missing days, suspicious values.

## Input Data
```json
{data}
```

## Output Format
- Markdown tables for time-series data.
- Explicit date ranges and units (kg, kcal, g).

Deliver a compact, factual summary of energy expenditure ready for nutritional analysis."""


def extract_nutrition_data(state: TrainingAnalysisState) -> dict:
    garmin_data = state["garmin_data"]

    daily_stats = garmin_data.get("daily_stats") or []
    caloric_expenditure = [
        {
            "date": ds.get("date"),
            "total_calories_burned": ds.get("total_calories"),
            "active_calories": ds.get("active_calories"),
            "bmr_calories": ds.get("bmr_calories"),
            "sleeping_hours": ds.get("sleeping_hours"),
        }
        for ds in daily_stats
        if any(ds.get(k) is not None for k in ("total_calories", "active_calories", "bmr_calories"))
    ]

    return {
        "garmin": {
            "body_composition": garmin_data.get("body_metrics", {}),
            "caloric_expenditure": caloric_expenditure,
            "body_battery": garmin_data.get("body_battery", []),
            "training_load_history": garmin_data.get("training_load_history", []),
        },
    }


nutrition_summarizer_node = create_data_summarizer_node(
    node_name="Nutrition Summarizer",
    agent_role=AgentRole.NUTRITION_SUMMARIZER,
    data_extractor=extract_nutrition_data,
    state_output_key="nutrition_summary",
    agent_type="nutrition_summarizer",
    system_prompt=NUTRITION_SUMMARIZER_SYSTEM_PROMPT,
    user_prompt=NUTRITION_SUMMARIZER_USER_PROMPT,
)
