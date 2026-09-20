from typing import Literal

AgentType = Literal[
    "metrics_summarizer",
    "physiology_summarizer",
    "activity_summarizer",
    "nutrition_summarizer",
    "lifestyle_summarizer",
    "metrics",
    "physiology",
    "activity",
    "nutrition",
    "lifestyle",
    "synthesis",
    "season_planner",
    "weekly_planner",
    "nutrition_planner",
    "race_strategy",
]


def get_workflow_context(agent_type: AgentType) -> str:
    # Summarizer agents
    summarizers = ["metrics_summarizer", "physiology_summarizer", "activity_summarizer",
                   "nutrition_summarizer", "lifestyle_summarizer"]
    if agent_type in summarizers:
        domain = agent_type.replace("_summarizer", "")
        return f"""
## System Role
You are the **{agent_type.replace('_', ' ').title()}**.
- **Input**: Raw `garmin_data`
- **Output**: Structured `{domain}_summary`
- **Goal**: Condense raw data into a factual, structured summary for the {domain} expert. Do NOT interpret."""

    # Expert agents
    if agent_type in ["metrics", "physiology", "activity", "nutrition", "lifestyle"]:
        return f"""
## System Role
You are the **{agent_type.title()} Expert**.
- **Input**: `{agent_type}_summary`
- **Output**: `{agent_type}_outputs` with 3 fields:
  1. `for_synthesis`: For the comprehensive report.
  2. `for_season_planner`: Strategic insights (12-24 weeks).
  3. `for_weekly_planner`: Tactical details (next 28 days).
- **Goal**: Analyze patterns and provide specific insights for each consumer.
- **Context**: You are 1 of 5 parallel experts. Focus ONLY on your domain."""

    # Synthesis agent
    if agent_type == "synthesis":
        return """
## System Role
You are the **Synthesis Agent**.
- **Input**: `for_synthesis` fields from all 5 domain experts (Metrics, Physiology, Activity, Nutrition, Lifestyle).
- **Output**: `synthesis_result` (Comprehensive Athlete Report).
- **Goal**: Integrate all domain insights into a coherent story. Focus on historical patterns, not future planning."""

    # Planner agents
    if agent_type in ["season_planner", "weekly_planner"]:
        timeframe = "12-24 week strategy" if agent_type == "season_planner" else "next 28-day workouts"
        return f"""
## System Role
You are the **{agent_type.replace('_', ' ').title()}**.
- **Input**: `for_{agent_type}` fields from all 5 domain experts.
- **Output**: `{agent_type.replace('_planner', '_plan')}` ({timeframe}).
- **Goal**: Translate expert insights into a concrete {timeframe}.
- **Context**: Use the expert signals as your primary constraints and guides."""

    if agent_type == "nutrition_planner":
        return """
## System Role
You are the **Nutrition Planner**.
- **Input**: `nutrition_outputs`, `weekly_plan`, athlete context.
- **Output**: `nutrition_plan` — daily nutrition targets aligned to the weekly training schedule.
- **Goal**: Translate nutrition expert signals into a concrete, day-by-day fueling strategy.
- **Context**: Nutrition targets must be anchored to training load per day (hard session vs rest day)."""

    if agent_type == "race_strategy":
        return """
## System Role
You are the **Race Strategy Agent**.
- **Input**: Expert outputs, season plan, upcoming competition details.
- **Output**: `race_strategy` — a targeted race-week and taper plan.
- **Goal**: Produce a specific race preparation protocol covering training taper, nutrition loading,
  pacing strategy, and pre-race logistics.
- **Context**: Only activated when a competition is within 6 weeks."""

    return ""


def get_plotting_instructions(agent_name: str) -> str:
    return f"""
## Visualization Rules
- **Constraint**: Create plots ONLY for unique insights not visible in standard Garmin reports. Max 2 plots.
- **Reference**: You MUST reference each plot EXACTLY ONCE in your text using `[PLOT:{agent_name}_TIMESTAMP_ID]`.
- **Placement**: Place the reference where it best supports your analysis. Do not repeat it."""


_LANGUAGE_NAMES = {"no": "Norwegian (bokmål)"}


def get_language_instructions(language: str | None) -> str:
    """Instruction block telling the model what language to write athlete-facing text in.

    Empty for English (the model's default), so this is a no-op addition to every existing
    prompt unless the athlete has actually selected Norwegian — see
    supabase/migrations/042_user_settings_language.sql and services.supabase.athlete_profile
    .get_athlete_language() for where `language` comes from.
    """
    name = _LANGUAGE_NAMES.get(language or "en")
    if not name:
        return ""
    return f"""
## Output Language
Write all athlete-facing natural-language text — analysis, feedback, plan descriptions, coach
notes, HTML report prose — in {name}. This applies to session/focus names too (e.g. "Recovery
Run", "Easy Aerobic", "Tempo Run") — translate their meaning into {name} rather than copying
any English example label shown elsewhere in this prompt verbatim; those examples illustrate
the *kind* of label to produce, not literal text to output. Keep structured field names, enum
values (e.g. session types, zone letters), units, dates, and any JSON/code keys exactly as
specified elsewhere in this prompt; only the natural-language prose changes language."""


def get_hitl_instructions(agent_name: str) -> str:
    return """
## Human Interaction
- **Questions**: If you need clarification, set `output` to a list of Question items.
- **Otherwise**: Set `output` to your node's normal output schema.
- **Criteria**: Only ask if data is ambiguous or user preference is required. Do not ask for obvious info.
- **Process**: If you ask questions, your execution pauses until the user answers."""
