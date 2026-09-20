"""Extract durable, cross-check-in facts (injuries, equipment/schedule changes, strong
preferences) from a check-in comment, for the athlete to confirm before they're saved.

Deliberately narrow: this only classifies what's durable vs. transient in a short piece of
free text — that judgment can't be made mechanically, unlike the slot-rotation/volume rules
elsewhere in this codebase — so it stays a small LLM call. Everything around it (dedupe,
persistence, requiring athlete confirmation before anything reaches a future prompt) is
deterministic and lives in services/supabase/athlete_memory_suggestions.py instead.
"""
from __future__ import annotations

import logging

from pydantic import BaseModel, Field

from services.ai.ai_settings import AgentRole
from services.ai.model_config import ModelSelector
from services.ai.utils.retry_handler import AI_ANALYSIS_CONFIG, retry_with_backoff

logger = logging.getLogger(__name__)


class MemoryFactCandidate(BaseModel):
    category: str = Field(
        ...,
        description="One of: injuries, preferences, equipment, schedule, observations, goals.",
    )
    key: str = Field(
        ...,
        description="Short snake_case identifier for this fact, e.g. 'shin_splints' or 'no_gym_access'.",
    )
    value: str = Field(
        ...,
        description="The durable fact itself, restated in one plain sentence.",
    )


class MemoryExtractionOutput(BaseModel):
    facts: list[MemoryFactCandidate] = Field(
        default_factory=list,
        description="Durable, multi-week-relevant facts worth remembering beyond this single "
        "check-in. Do not include anything already listed under Known facts unless the athlete "
        "is updating or correcting it. Most check-ins contain nothing worth extracting — an "
        "empty list is the common and correct answer.",
    )


_MEMORY_EXTRACTION_PROMPT = """\
An athlete just left this note during a training check-in:

\"\"\"{user_comment}\"\"\"

Known facts already on file (do not repeat these unless the note updates or corrects one):
{known_facts}

Extract only facts that will still matter weeks from now — a new or ongoing injury, a change \
in available equipment or schedule, or a strongly stated preference. Do NOT extract transient \
status that only describes this one check-in: today's soreness, a single missed session, mood, \
or anything the athlete is only reporting once in passing. If nothing durable is mentioned, \
return an empty list.
"""


async def extract_memory_candidates(
    user_comment: str, known_facts_text: str | None
) -> list[MemoryFactCandidate]:
    """Best-effort extraction — never raises. Returns [] on any failure."""
    try:
        llm = ModelSelector.get_llm(AgentRole.MEMORY_EXTRACTOR)
        structured_llm = llm.with_structured_output(MemoryExtractionOutput)
        prompt = _MEMORY_EXTRACTION_PROMPT.format(
            user_comment=user_comment.strip(),
            known_facts=known_facts_text or "None recorded yet.",
        )

        async def call() -> MemoryExtractionOutput:
            return await structured_llm.ainvoke(prompt)

        result = await retry_with_backoff(call, AI_ANALYSIS_CONFIG, "Memory Extraction")
        return result.facts
    except Exception:
        logger.exception("Memory extraction failed — skipping for this check-in")
        return []
