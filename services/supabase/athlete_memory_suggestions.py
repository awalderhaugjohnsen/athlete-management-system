"""Pending athlete_memory suggestions extracted from check-in comments.

Kept separate from athlete_memory itself so an unconfirmed extraction can never reach a
future prompt before the athlete has reviewed it — see migration 047.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from .client import get_supabase, rows

if TYPE_CHECKING:
    from services.ai.coaching_memory import MemoryFactCandidate

logger = logging.getLogger(__name__)


def insert_suggestions(
    user_id: str,
    candidates: list[MemoryFactCandidate],
    source_note: str,
    replan_job_id: str | None = None,
) -> None:
    """Insert each candidate as a pending suggestion, skipping ones already pending.

    A duplicate (same category/key/value, still unresolved) can show up if a check-in is
    re-run before the athlete gets to review the last one — skip it rather than piling up
    identical rows for the same fact.
    """
    try:
        sb = get_supabase()
        existing = rows(
            sb.table("athlete_memory_suggestions")
            .select("category, key, value")
            .eq("user_id", user_id)
            .eq("status", "pending")
            .execute()
        )
        pending_keys = {(r["category"], r["key"], r["value"]) for r in existing}

        new_rows = [
            {
                "user_id": user_id,
                "category": c.category,
                "key": c.key,
                "value": c.value,
                "source_note": source_note,
                "replan_job_id": replan_job_id,
            }
            for c in candidates
            if (c.category, c.key, c.value) not in pending_keys
        ]
        if new_rows:
            sb.table("athlete_memory_suggestions").insert(new_rows).execute()
    except Exception:
        logger.exception("Failed to insert memory suggestions for %s", user_id)
