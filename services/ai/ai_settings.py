"""Which model each node runs on.

The decision made per node is not "which model" but "how much judgement does
this step need". Three tiers cover the graph:

* FAST      — restructure data, no judgement. Summarisers and formatters.
* REASONING — judgement over data. Experts, the weekly and nutrition planners,
              race strategy, synthesis.
* DEEP      — the longest-horizon, most consequential call. The season planner.

ROLE_TIER is the per-node tuning and is meant to be edited. TIER_MODEL gives
each tier a default model; override any tier without touching Python via
MODEL_FAST / MODEL_REASONING / MODEL_DEEP in the environment (see
core/config.py). Cheap runs are not a tier concern: `--replan` skips the
experts, which is where the cost is.
"""

from enum import Enum


class Tier(Enum):
    FAST = "fast"
    REASONING = "reasoning"
    DEEP = "deep"


class AgentRole(Enum):
    """One role per LLM-calling node, so ROLE_TIER reads as a list of the graph."""

    METRICS_SUMMARIZER = "metrics_summarizer"
    PHYSIOLOGY_SUMMARIZER = "physiology_summarizer"
    ACTIVITY_SUMMARIZER = "activity_summarizer"
    NUTRITION_SUMMARIZER = "nutrition_summarizer"
    LIFESTYLE_SUMMARIZER = "lifestyle_summarizer"
    METRICS_EXPERT = "metrics_expert"
    PHYSIOLOGY_EXPERT = "physiology_expert"
    ACTIVITY_EXPERT = "activity_expert"
    NUTRITION_EXPERT = "nutrition_expert"
    LIFESTYLE_EXPERT = "lifestyle_expert"
    SYNTHESIS = "synthesis"
    ANALYSIS_FORMATTER = "analysis_formatter"
    SEASON_PLANNER = "season_planner"
    WEEKLY_PLANNER = "weekly_planner"
    NUTRITION_PLANNER = "nutrition_planner"
    RACE_STRATEGY = "race_strategy"
    PLAN_FORMATTER = "plan_formatter"
    MEMORY_EXTRACTOR = "memory_extractor"


ROLE_TIER: dict[AgentRole, Tier] = {
    AgentRole.METRICS_SUMMARIZER: Tier.FAST,
    AgentRole.PHYSIOLOGY_SUMMARIZER: Tier.FAST,
    AgentRole.ACTIVITY_SUMMARIZER: Tier.FAST,
    AgentRole.NUTRITION_SUMMARIZER: Tier.FAST,
    AgentRole.LIFESTYLE_SUMMARIZER: Tier.FAST,
    AgentRole.METRICS_EXPERT: Tier.REASONING,
    AgentRole.PHYSIOLOGY_EXPERT: Tier.REASONING,
    AgentRole.ACTIVITY_EXPERT: Tier.REASONING,
    AgentRole.NUTRITION_EXPERT: Tier.REASONING,
    AgentRole.LIFESTYLE_EXPERT: Tier.REASONING,
    AgentRole.SYNTHESIS: Tier.REASONING,
    AgentRole.ANALYSIS_FORMATTER: Tier.FAST,
    AgentRole.SEASON_PLANNER: Tier.DEEP,
    AgentRole.WEEKLY_PLANNER: Tier.REASONING,
    AgentRole.NUTRITION_PLANNER: Tier.REASONING,
    AgentRole.RACE_STRATEGY: Tier.REASONING,
    AgentRole.PLAN_FORMATTER: Tier.FAST,
    AgentRole.MEMORY_EXTRACTOR: Tier.FAST,
}

TIER_MODEL: dict[Tier, str] = {
    Tier.FAST: "claude-haiku",
    Tier.REASONING: "claude-sonnet",
    Tier.DEEP: "claude-opus",
}
