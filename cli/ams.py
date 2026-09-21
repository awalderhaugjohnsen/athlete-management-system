#!/usr/bin/env python3

import argparse
import asyncio
import getpass
import json
import logging
import os
import re
import sys
from dataclasses import asdict
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

from services.ai.coaching_memory import extract_memory_candidates
from services.ai.langgraph.workflows.planning_workflow import (
    run_complete_analysis_and_planning,
    run_replan,
)
from services.ai.utils.plan_storage import FilePlanStorage
from services.garmin import ExtractionConfig, GarminDataExtractor
from services.garmin.client import GarminConnectClient
from services.garmin.credentials import resolve_garmin_credentials
from services.garmin.history_sync import (
    build_completed_activity_records,
    build_completed_exercise_set_records,
    build_daily_metrics_records,
)
from services.garmin.running_uploader import (
    PlannedRunningSegment,
    PlannedRunningSession,
    delete_running_workout,
    estimate_running_duration_secs,
    normalize_recovery_segments,
    render_running_description,
    upload_running_session,
)
from services.garmin.strength_uploader import (
    PlannedExercise,
    PlannedSet,
    PlannedStrengthSession,
    delete_strength_workout,
    upload_strength_session,
)
from services.garmin.training_paces import extract_predicted_5k_secs
from services.supabase.athlete_memory import get_athlete_memory
from services.supabase.athlete_memory_suggestions import insert_suggestions
from services.supabase.client import get_supabase, rows
from services.supabase.plan_drift import analyze_plan_drift
from services.supabase.plan_writer import (
    compute_weekly_kpi_delta,
    expand_strength_session_slots,
    finalize_recent_nutrition_targets,
    get_future_garmin_running_workout_ids,
    get_future_garmin_workout_ids,
    get_planned_exercises_by_date,
    get_sync_gap_days,
    monday_of,
    render_coach_feedback_html,
    shift_plan,
    sync_todays_nutrition_target,
    upsert_completed_activities,
    upsert_completed_exercise_sets,
    upsert_daily_metrics_batch,
    upsert_kpis,
    write_plan,
    write_report,
    write_weekly_review,
)

sys.path.append(str(Path(__file__).parent.parent))


logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)


class ConfigParser:

    def __init__(self, config_path: Path):
        self.config_path = config_path
        self.config = self._load_config()

    def _load_config(self) -> dict[str, Any]:
        if not self.config_path.exists():
            raise FileNotFoundError(f"Config file not found: {self.config_path}")

        content = self.config_path.read_text(encoding="utf-8")

        if self.config_path.suffix in [".yaml", ".yml"]:
            return yaml.safe_load(content)
        elif self.config_path.suffix == ".json":
            return json.loads(content)
        else:
            raise ValueError(f"Unsupported config format: {self.config_path.suffix}")

    def get_athlete_info(self) -> tuple[str, str]:
        # In SaaS mode, email comes from Supabase vault
        import os
        user_id = os.environ.get("SUPABASE_USER_ID")
        if user_id:
            try:
                from services.supabase.credentials import get_garmin_credentials
                creds = get_garmin_credentials(user_id)
                if creds:
                    email, _ = creds
                    return self.config.get("athlete", {}).get("name", "Athlete"), email
            except Exception:
                pass

        if not (email := self.config.get("athlete", {}).get("email")):
            raise ValueError("Athlete email is required in config file or Supabase vault")

        return self.config.get("athlete", {}).get("name", "Athlete"), email

    def get_contexts(self) -> tuple[str, str]:
        """Return (analysis_context, planning_context), read live from Supabase.

        The web setup wizard is the single source of truth for coaching context — the analysis
        narrative is LLM-authored and stored on athlete_profile, while the planning context is
        rendered deterministically from structured profile fields on every call (never cached).
        """
        user_id = os.environ.get("SUPABASE_USER_ID")
        if not user_id:
            raise ValueError("SUPABASE_USER_ID must be set to read coaching context from Supabase")

        from services.supabase.athlete_profile import build_planning_context, get_analysis_context

        return get_analysis_context(user_id), build_planning_context(user_id)

    def get_recurring_session_requests(self) -> list[dict[str, Any]]:
        user_id = os.environ.get("SUPABASE_USER_ID")
        if not user_id:
            return []

        from services.supabase.athlete_profile import get_recurring_session_requests

        return get_recurring_session_requests(user_id)

    def get_language(self) -> str:
        """The athlete's selected language ('en'/'no'), read live from Supabase — see
        services.supabase.athlete_profile.get_athlete_language(). Defaults to 'en' when no
        SUPABASE_USER_ID is set (local, non-SaaS runs).
        """
        user_id = os.environ.get("SUPABASE_USER_ID")
        if not user_id:
            return "en"

        from services.supabase.athlete_profile import get_athlete_language

        return get_athlete_language(user_id)

    def get_extraction_config(self) -> dict[str, Any]:
        extraction = self.config.get("extraction", {})
        return {
            "activities_days": extraction.get("activities_days", 7),
            "metrics_days": extraction.get("metrics_days", 14),
            "enable_plotting": extraction.get("enable_plotting", False),
            "hitl_enabled": extraction.get("hitl_enabled", True),
            "skip_synthesis": extraction.get("skip_synthesis", False),
            "upload_to_garmin": extraction.get("upload_to_garmin", False),
        }

    def get_competitions(self) -> list[dict[str, Any]]:
        competitions = self.config.get("competitions", [])
        return [
            {
                "name": comp.get("name", ""),
                "date": comp.get("date", ""),
                "race_type": comp.get("race_type", ""),
                "priority": comp.get("priority", "B"),
                "target_time": comp.get("target_time", ""),
            }
            for comp in competitions
        ]

    def get_output_directory(self) -> Path:
        return Path(self.config.get("output", {}).get("directory", "./data"))

    def get_password(self) -> str:
        return resolve_garmin_credentials(self.config)[1]


def _reconcile_strength_focus_labels(
    scheduled_days: list[dict[str, Any]] | None,
    strength_sessions: list[dict[str, Any]],
) -> None:
    """Overwrite scheduled_days[i]["focus"] for strength dates with the authoritative slot_name
    from expand_strength_session_slots(). The LLM writes `focus` itself, independently of the
    `strength_sessions` slot Python actually assigns (which silently overrides the LLM's own slot
    guess to keep the A->B->C rotation correct) — if the LLM's own tracking of the rotation drifts,
    its focus label can describe a different slot than what's actually delivered. Mutates in place;
    call right after expand_strength_session_slots(), before scheduled_days is saved/written.
    """
    if not scheduled_days:
        return
    slot_name_by_key = {
        (s["date"], s.get("time_slot", "day")): s["slot_name"]
        for s in strength_sessions if s.get("slot_name")
    }
    for day in scheduled_days:
        slot_name = slot_name_by_key.get((day.get("date"), day.get("time_slot", "day")))
        if slot_name and day.get("focus") != slot_name:
            logger.warning(
                "Focus label mismatch on %s: planner wrote %r, actual slot is %r — correcting",
                day.get("date"), day.get("focus"), slot_name,
            )
            day["focus"] = slot_name


def _apply_running_descriptions(
    scheduled_days: list[dict[str, Any]] | None,
    running_sessions: list[dict[str, Any]],
    language: str = "en",
) -> None:
    """Overwrite scheduled_days[i]["description"] for run dates with a description rendered
    deterministically from that date's structured segments (running_uploader.render_running_
    description) — the LLM's own attempt at the description field for run days is discarded, the
    segments are the single source of truth. Also force-corrects any recovery/warmup/cooldown
    segment that came back distance-based into time-based first (normalize_recovery_segments) —
    distance is only meant for the interval rep itself. Mutates in place; call right after the AI
    result comes back, before scheduled_days is saved/written or pushed to Garmin.
    """
    if not scheduled_days:
        return
    segments_by_key = {
        (s["date"], s.get("time_slot", "day")): s["segments"]
        for s in running_sessions if s.get("segments")
    }
    for day in scheduled_days:
        segments = segments_by_key.get((day.get("date"), day.get("time_slot", "day")))
        if segments is not None:
            normalize_recovery_segments(segments)
            day["description"] = render_running_description(segments, language=language)


def _save_html_outputs(output_dir: Path, result: dict[str, Any]) -> list[str]:
    files_generated: list[str] = []

    for filename, key in [
        ("analysis.html", "analysis_html"),
        ("planning.html", "planning_html"),
    ]:
        if content := result.get(key):
            if isinstance(content, dict):
                content = content.get("content", "")

            output_path = output_dir / filename
            output_path.write_text(content, encoding="utf-8")
            files_generated.append(filename)
            logger.info("Saved: %s", output_path)

    return files_generated


def _save_expert_outputs(output_dir: Path, result: dict[str, Any]) -> list[str]:
    files_generated: list[str] = []

    for filename, key in [
        ("metrics_expert.json", "metrics_outputs"),
        ("activity_expert.json", "activity_outputs"),
        ("physiology_expert.json", "physiology_outputs"),
    ]:
        if output := result.get(key):
            output_path = output_dir / filename
            output_path.write_text(
                json.dumps(output.model_dump(mode="json"), indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            files_generated.append(filename)
            logger.info("Saved: %s", output_path)

    return files_generated


def _raise_if_node_errors(result: dict[str, Any]) -> None:
    """Raise loudly on a failed node instead of letting empty data through silently.

    A node failure returns {"errors": [...]} (execute_node_with_error_handling)
    instead of raising — nothing downstream ever checked this before, so a
    failed node's absent scheduled_days/strength_sessions silently defaulted
    to [] and write_plan() would still insert an empty plan, deleting the
    real overlapping plan via its date-range cleanup.
    """
    if result.get("errors"):
        raise RuntimeError("; ".join(result["errors"]))


def _save_plan_outputs(output_dir: Path, result: dict[str, Any]) -> list[str]:
    files_generated: list[str] = []

    storage = FilePlanStorage()
    user_id = result.get("user_id", "cli_user")

    for filename, key in [
        ("season_plan.md", "season_plan"),
        ("weekly_plan.md", "weekly_plan"),
    ]:
        if plan_dict := result.get(key):
            output = plan_dict.get("output", plan_dict) if isinstance(plan_dict, dict) else plan_dict
            if isinstance(output, str):
                output_path = output_dir / filename
                output_path.write_text(output, encoding="utf-8")
                files_generated.append(filename)
                logger.info("Saved: %s", output_path)
                storage.save_plan(user_id, key, output)

    if scheduled_days := result.get("scheduled_days"):
        storage.save_json(user_id, "scheduled_days", scheduled_days)
        logger.info("Saved scheduled_days (%d days) to storage", len(scheduled_days))

    return files_generated


async def run_analysis_from_config(config_path: Path, user_comment: str | None = None) -> None:
    config_parser = ConfigParser(config_path)
    athlete_name, email = config_parser.get_athlete_info()
    analysis_context, planning_context = config_parser.get_contexts()
    recurring_session_requests = config_parser.get_recurring_session_requests()
    if user_comment:
        logger.info("User note for new season: %s", user_comment[:120])
        supabase_user_id = os.environ.get("SUPABASE_USER_ID")
        if supabase_user_id:
            try:
                known_memory = get_athlete_memory(supabase_user_id)
                candidates = await extract_memory_candidates(user_comment, known_memory)
                if candidates:
                    logger.info("Extracted %d memory candidate(s) for review", len(candidates))
                    insert_suggestions(supabase_user_id, candidates, source_note=user_comment)
            except Exception:
                logger.exception("Memory suggestion extraction failed — continuing season plan")
        planning_context = f"{planning_context.rstrip()}\n\n## Athlete Note\n{user_comment.strip()}"
    extraction_settings = config_parser.get_extraction_config()

    competitions = config_parser.get_competitions()

    output_dir = config_parser.get_output_directory()

    logger.info("Starting analysis for %s", athlete_name)
    logger.info("Output directory: %s", output_dir)

    password = config_parser.get_password()

    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        logger.info("Extracting Garmin Connect data...")
        extractor = GarminDataExtractor(email, password)

        # Widen the lookback to cover any gap since the last successful sync — a fixed
        # window silently drops whatever Garmin activities fall between "N days ago" and
        # the actual last-synced date if the athlete goes longer than N days without a
        # sync (see get_sync_gap_days's docstring; confirmed live as a real data gap).
        extraction_config = ExtractionConfig(
            activities_range=get_sync_gap_days(extraction_settings["activities_days"]),
            metrics_range=get_sync_gap_days(extraction_settings["metrics_days"]),
            include_detailed_activities=True,
            include_metrics=True,
        )

        garmin_data = extractor.extract_data(extraction_config)
        logger.info("Data extraction completed")

        now = datetime.now()
        plotting_enabled = extraction_settings.get("enable_plotting", False)
        hitl_enabled = extraction_settings.get("hitl_enabled", True)
        skip_synthesis = extraction_settings.get("skip_synthesis", False)

        logger.info("Plotting enabled: %s", plotting_enabled)
        logger.info("HITL enabled: %s", hitl_enabled)
        logger.info("Skip synthesis: %s", skip_synthesis)

        current_date = {"date": now.strftime("%Y-%m-%d"), "day_name": now.strftime("%A")}
        week_dates = [
            {"date": (now + timedelta(days=offset)).strftime("%Y-%m-%d"),
             "day_name": (now + timedelta(days=offset)).strftime("%A")}
            for offset in range(28)
        ]

        logger.info("Running AI analysis and planning...")

        result = await run_complete_analysis_and_planning(
            user_id="cli_user",
            athlete_name=athlete_name,
            garmin_data=asdict(garmin_data),
            analysis_context=analysis_context,
            planning_context=planning_context,
            recurring_session_requests=recurring_session_requests,
            competitions=competitions,
            current_date=current_date,
            week_dates=week_dates,
            plotting_enabled=plotting_enabled,
            hitl_enabled=hitl_enabled,
            skip_synthesis=skip_synthesis,
            language=config_parser.get_language(),
        )

        _raise_if_node_errors(result)

        # The weekly planner only decides {date, slot} for strength sessions now — expand into full
        # exercise lists from the athlete's saved templates (+ deterministic bench wave) here, once,
        # before anything downstream (Garmin push, Supabase write) reads strength_sessions.
        if result.get("strength_sessions"):
            result["strength_sessions"] = expand_strength_session_slots(result["strength_sessions"])
            _reconcile_strength_focus_labels(result.get("scheduled_days"), result["strength_sessions"])

        # Running sessions come back as structured segments (running_sessions) — render each
        # date's description from its segments before anything downstream reads scheduled_days.
        if result.get("running_sessions"):
            _apply_running_descriptions(result.get("scheduled_days"), result["running_sessions"], language=config_parser.get_language())

        logger.info("Saving results...")

        files_generated: list[str] = []
        files_generated.extend(_save_html_outputs(output_dir, result))
        files_generated.extend(_save_expert_outputs(output_dir, result))
        files_generated.extend(_save_plan_outputs(output_dir, result))

        (output_dir / "summary.json").write_text(
            json.dumps({
                "athlete": athlete_name,
                "analysis_date": datetime.now().isoformat(),
                "competitions": competitions,
                "execution_id": result.get("execution_id", ""),
                "execution_time_seconds": result.get("execution_metadata", {}).get("execution_time_seconds"),
                "files_generated": files_generated,
            }, indent=2, ensure_ascii=False),
            encoding="utf-8"
        )

        logger.info("✅ Analysis completed successfully!")
        logger.info("📁 Results saved to: %s", output_dir)

        workout_ids: dict[tuple[str, str], Any] = {}
        running_workout_ids: dict[tuple[str, str], Any] = {}
        if extraction_settings.get("upload_to_garmin", False):
            strength_sessions = result.get("strength_sessions") or []
            if strength_sessions:
                logger.info("📲 Syncing %d strength session(s) with Garmin Connect…", len(strength_sessions))
                # Query Supabase (not a local file) for whatever plan is live right now — this is
                # the durable record every previous run's push ultimately landed in, so it can't
                # drift out of sync with what's actually still scheduled on the watch.
                old_ids = get_future_garmin_workout_ids(date.today().isoformat())
                workout_ids = _sync_strength_sessions(strength_sessions, old_ids, email, password)
            else:
                logger.info("📲 upload_to_garmin is enabled but no strength sessions found in plan.")

            running_sessions = result.get("running_sessions") or []
            if running_sessions:
                logger.info("📲 Syncing %d running session(s) with Garmin Connect…", len(running_sessions))
                old_running_ids = get_future_garmin_running_workout_ids(date.today().isoformat())
                running_workout_ids = _sync_running_sessions(
                    running_sessions, old_running_ids, email, password,
                    scheduled_days=result.get("scheduled_days"),
                )
            else:
                logger.info("📲 upload_to_garmin is enabled but no running sessions found in plan.")

        gd_dict = asdict(garmin_data)
        _write_to_supabase(result, workout_ids, running_workout_ids, garmin_data=gd_dict)
        # Full extraction includes 360-day training load history — persist all of it.
        upsert_daily_metrics_batch(build_daily_metrics_records(gd_dict))
        upsert_completed_activities(build_completed_activity_records(gd_dict))
        _sync_completed_exercise_sets(gd_dict)
    except Exception as e:
        logger.error("❌ Analysis failed: %s", e)
        raise


async def run_replan_from_config(
    config_path: Path,
    user_comment: str | None = None,
    outer_scheduled_days: list[dict] | None = None,
    replan_job_id: str | None = None,
) -> str | None:
    """Tier-2 check-in: assess the last week, give feedback, and optionally update the 6-week schedule.
    Returns coach_feedback text (or None) so the caller can save it to the job row.
    """
    config_parser = ConfigParser(config_path)
    language = config_parser.get_language()
    athlete_name, email = config_parser.get_athlete_info()
    _, planning_context = config_parser.get_contexts()
    recurring_session_requests = config_parser.get_recurring_session_requests()
    extraction_settings = config_parser.get_extraction_config()
    competitions = config_parser.get_competitions()
    output_dir = config_parser.get_output_directory()

    storage = FilePlanStorage()
    user_id = "cli_user"

    season_plan = storage.load_plan(user_id, "season_plan")
    if not season_plan:
        logger.error(
            "❌ No season plan found. Run the full pipeline first: --config %s", config_path
        )
        sys.exit(1)

    logger.info("Loaded stored season plan (%d chars)", len(season_plan))

    password = config_parser.get_password()

    if user_comment:
        logger.info("User note: %s", user_comment[:120])
        supabase_user_id = os.environ.get("SUPABASE_USER_ID")
        if supabase_user_id:
            try:
                known_memory = get_athlete_memory(supabase_user_id)
                candidates = await extract_memory_candidates(user_comment, known_memory)
                if candidates:
                    logger.info("Extracted %d memory candidate(s) for review", len(candidates))
                    insert_suggestions(
                        supabase_user_id, candidates, source_note=user_comment,
                        replan_job_id=replan_job_id,
                    )
            except Exception:
                logger.exception("Memory suggestion extraction failed — continuing check-in")
        planning_context = f"{planning_context.rstrip()}\n\n## Athlete Note\n{user_comment.strip()}"

    # Widen past 14 days if the athlete hasn't synced in longer than that — see
    # get_sync_gap_days's docstring; a fixed window here previously left a real,
    # permanent data gap for whatever fell between "14 days ago" and the actual last sync.
    replan_lookback_days = get_sync_gap_days(14)
    logger.info("Extracting recent Garmin data (%d days)…", replan_lookback_days)
    extractor = GarminDataExtractor(email, password)
    garmin_data = extractor.extract_data(
        ExtractionConfig(
            activities_range=replan_lookback_days,
            metrics_range=replan_lookback_days,
            include_detailed_activities=True,
            include_metrics=False,
            include_long_term_trends=False,
        )
    )

    # Persist real activity before analysing drift, so an unsynced session doesn't read as a
    # missed one — the difference between "you skipped it" and "we haven't looked yet".
    upsert_completed_activities(build_completed_activity_records(asdict(garmin_data)))

    # ── Drift: what actually happened vs. what was planned ──────────────────────────────
    # A uniform shift has no judgment left in it (every session done, same order, just offset),
    # so resolve it deterministically and skip the LLM entirely — "I did everything a day late"
    # becomes free, instant, and impossible to mis-author. Every other case (reordered /
    # shortfall / substituted) is a real coaching call, so the facts go into the prompt and the
    # coach decides. Skipped when the athlete left a note: they're telling us something the
    # activity data doesn't contain, and that deserves the coach's attention.
    drift = analyze_plan_drift(lookback_days=replan_lookback_days)
    if drift.get("pure_shift_days") and not user_comment:
        shift_days = drift["pure_shift_days"]
        logger.info("📆 Pure %d-day shift detected — resolving deterministically (no AI call).", shift_days)
        shifted = shift_plan(from_date=date.today().isoformat(), days=shift_days)
        for warning in shifted.get("warnings", []):
            logger.warning("⚠️  %s", warning)
        feedback = _feedback(
            language, "shift_moved", days=str(shift_days), shifted=str(shifted["shifted"]),
        )
        if shifted.get("dropped"):
            feedback += _feedback(language, "shift_compressed_suffix", count=str(len(shifted["dropped"])))
        return feedback

    if drift.get("summary"):
        logger.info("Plan drift — %s", drift["summary"][:200])
        planning_context = (
            f"{planning_context.rstrip()}\n\n=== WHAT ACTUALLY HAPPENED (measured, not reported) ===\n"
            f"{drift['summary']}\n"
            "Decide how to respond: slide the remaining plan to keep order, absorb the gap, drop "
            "the lowest-value session, or re-anchor to the athlete's preferred days. State which "
            "you chose and why in coach_feedback."
        )

    now = datetime.now()
    current_date = {"date": now.strftime("%Y-%m-%d"), "day_name": now.strftime("%A")}
    week_dates = [
        {
            "date": (now + timedelta(days=i)).strftime("%Y-%m-%d"),
            "day_name": (now + timedelta(days=i)).strftime("%A"),
        }
        for i in range(42)  # 6-week rolling window
    ]

    logger.info("Running Tier-2 re-plan (6-week rolling window)…")
    result = await run_replan(
        user_id=user_id,
        athlete_name=athlete_name,
        season_plan=season_plan,
        planning_context=planning_context,
        garmin_data=asdict(garmin_data),
        recurring_session_requests=recurring_session_requests,
        competitions=competitions,
        current_date=current_date,
        week_dates=week_dates,
        language=config_parser.get_language(),
    )

    _raise_if_node_errors(result)

    # The weekly planner only decides {date, slot} for strength sessions now — expand into full
    # exercise lists from the athlete's saved templates (+ deterministic bench wave) here, once,
    # before anything downstream (Garmin push, Supabase write) reads strength_sessions.
    if result.get("strength_sessions"):
        result["strength_sessions"] = expand_strength_session_slots(result["strength_sessions"])
        _reconcile_strength_focus_labels(result.get("scheduled_days"), result["strength_sessions"])

    # Running sessions come back as structured segments (running_sessions) — render each date's
    # description from its segments before anything downstream reads scheduled_days.
    if result.get("running_sessions"):
        _apply_running_descriptions(result.get("scheduled_days"), result["running_sessions"], language=language)

    coach_feedback: str | None = result.get("coach_feedback")
    schedule_updated: bool = result.get("schedule_updated", True)

    # Persist this check-in as the week's review — this is what the Progress page's
    # "This week" tab reads. write_weekly_review() existed since migration 006 but had
    # zero callers, so weekly_reviews was never written and the tab showed "No weekly
    # review yet" forever, even after real check-ins. Written before the
    # schedule_updated early-return below: a check-in that concludes "no changes needed"
    # still produced a valid assessment worth showing.
    if coach_feedback:
        try:
            week_start = monday_of(date.today())
            write_weekly_review(
                week_start=week_start,
                summary_html=render_coach_feedback_html(coach_feedback),
                kpi_delta=compute_weekly_kpi_delta(week_start) or None,
            )
        except Exception:
            logger.exception("Failed to write weekly review — continuing check-in")

    if not schedule_updated:
        logger.info("✅ Check-in complete — coach assessed no schedule changes needed.")
        return coach_feedback

    # Merge AI-generated near-term days with preserved outer season days
    if outer_scheduled_days and result.get("scheduled_days") is not None:
        result["scheduled_days"] = result["scheduled_days"] + outer_scheduled_days
        logger.info(
            "Merged %d AI days + %d preserved outer days",
            len(result["scheduled_days"]) - len(outer_scheduled_days),
            len(outer_scheduled_days),
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    files = _save_plan_outputs(output_dir, result)
    logger.info("✅ Check-in complete — schedule updated: %s", files)

    workout_ids: dict[tuple[str, str], Any] = {}
    running_workout_ids: dict[tuple[str, str], Any] = {}
    if extraction_settings.get("upload_to_garmin", False):
        strength_sessions = result.get("strength_sessions") or []
        if strength_sessions:
            logger.info("📲 Syncing %d strength session(s) with Garmin Connect…", len(strength_sessions))
            old_ids = get_future_garmin_workout_ids(date.today().isoformat())
            workout_ids = _sync_strength_sessions(strength_sessions, old_ids, email, password)
        else:
            logger.info("📲 upload_to_garmin is enabled but no strength sessions in check-in.")

        running_sessions = result.get("running_sessions") or []
        if running_sessions:
            logger.info("📲 Syncing %d running session(s) with Garmin Connect…", len(running_sessions))
            old_running_ids = get_future_garmin_running_workout_ids(date.today().isoformat())
            running_workout_ids = _sync_running_sessions(
                running_sessions, old_running_ids, email, password,
                scheduled_days=result.get("scheduled_days"),
            )
        else:
            logger.info("📲 upload_to_garmin is enabled but no running sessions in check-in.")

    gd = asdict(garmin_data)
    _write_to_supabase(result, workout_ids, running_workout_ids, garmin_data=gd)
    _write_report_to_supabase(output_dir, garmin_data=gd)
    # Full extraction includes 360-day training load history — persist all of it.
    upsert_daily_metrics_batch(build_daily_metrics_records(gd))
    upsert_completed_activities(build_completed_activity_records(gd))
    _sync_completed_exercise_sets(gd)
    return coach_feedback


def _write_report_to_supabase(
    output_dir: Path,
    garmin_data: dict[str, Any] | None = None,
) -> None:
    """Upload analysis/planning HTML from disk to Supabase if they exist."""
    if not os.environ.get("SUPABASE_URL") or not os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
        return
    analysis_path = output_dir / "analysis.html"
    planning_path = output_dir / "planning.html"
    analysis_html = analysis_path.read_text(encoding="utf-8") if analysis_path.exists() else None
    planning_html = planning_path.read_text(encoding="utf-8") if planning_path.exists() else None
    if analysis_html or planning_html:
        try:
            gd = garmin_data or {}
            bench_e1rm = _compute_bench_e1rm(gd)
            predicted_5k = _compute_predicted_5k_secs(gd)
            max_hr = _compute_max_heart_rate(gd)
            write_report(
                analysis_html=analysis_html,
                planning_html=planning_html,
                bench_e1rm_kg=bench_e1rm,
                predicted_5k_secs=predicted_5k,
                predicted_10k_secs=_compute_predicted_race_secs(gd, "time10K"),
                predicted_half_marathon_secs=_compute_predicted_race_secs(gd, "timeHalfMarathon"),
                predicted_marathon_secs=_compute_predicted_race_secs(gd, "timeMarathon"),
                max_heart_rate_bpm=max_hr,
                kpis=_compute_kpis(gd),
                personal_records=_extract_personal_records(gd),
            )
        except Exception as exc:
            logger.warning("⚠️  Report write to Supabase failed: %s", exc)


def _compute_kpis(garmin_data: dict[str, Any]) -> dict[str, Any]:
    """Assemble a structured KPI snapshot from the full garmin_data dict."""
    from statistics import mean as _mean

    def _dg(*keys: str, src: dict | None = None) -> Any:
        node: Any = src if src is not None else garmin_data
        for k in keys:
            if not isinstance(node, dict):
                return None
            node = node.get(k)
        return node

    # ── Training Load (most recent day in history) ──────────────────────
    load_history: list[dict] = garmin_data.get("training_load_history") or []
    latest_load = load_history[-1] if load_history else {}

    training_load = {
        "chronic_28d_avg": latest_load.get("chronic_28d_avg"),
        "acute_7d_sum": latest_load.get("acute_7d_sum"),
        "acwr_uncoupled": latest_load.get("acwr_uncoupled"),
        "tsb": latest_load.get("tsb"),
        "monotony_7d": latest_load.get("monotony_7d"),
        "strain_7d": latest_load.get("strain_7d"),
        "ramp_7d": latest_load.get("ramp_7d"),
    }

    # ── Physiological ───────────────────────────────────────────────────
    phys = garmin_data.get("physiological_markers") or {}
    if hasattr(phys, "__dict__"):
        phys = phys.__dict__
    up = garmin_data.get("user_profile") or {}
    if hasattr(up, "__dict__"):
        up = up.__dict__

    hrv_raw = phys.get("hrv") or {}
    baseline = hrv_raw.get("baseline") or {}

    # LT pace: convert m/s → min/km
    lt_speed = up.get("lactate_threshold_speed")
    lt_pace_min_per_km = round(1000 / (lt_speed * 60), 2) if lt_speed else None

    physiological = {
        "vo2max_running": phys.get("vo2_max"),
        "rhr": phys.get("resting_heart_rate"),
        "lactate_threshold_hr": up.get("lactate_threshold_heart_rate"),
        "lactate_threshold_pace_min_per_km": lt_pace_min_per_km,
    }

    hrv = {
        "weekly_avg": hrv_raw.get("weekly_avg"),
        "last_night_avg": hrv_raw.get("last_night_avg"),
        "last_night_5min_high": hrv_raw.get("last_night_5min_high"),
        "baseline_low": baseline.get("balanced_low"),
        "baseline_high": baseline.get("balanced_upper"),
    }

    # ── Recovery indicators (7-day avg) ─────────────────────────────────
    indicators: list[dict] = garmin_data.get("recovery_indicators") or []
    if indicators and hasattr(indicators[0], "__dict__"):
        indicators = [i.__dict__ for i in indicators]

    sleep_entries = [i.get("sleep") or {} for i in indicators if i.get("sleep")]
    stress_entries = [i.get("stress") or {} for i in indicators if i.get("stress")]

    def _avg(vals: list) -> float | None:
        clean = [v for v in vals if v is not None]
        return round(_mean(clean), 1) if clean else None

    def _latest(key: str, src: list[dict]) -> Any:
        for entry in reversed(src):
            v = entry.get(key)
            if v is not None:
                return v
        return None

    sleep = {
        "avg_total_hours": _avg([s.get("duration", {}).get("total") for s in sleep_entries]),
        "avg_deep_hours": _avg([s.get("duration", {}).get("deep") for s in sleep_entries]),
        "avg_rem_hours": _avg([s.get("duration", {}).get("rem") for s in sleep_entries]),
        "avg_score": _avg([s.get("quality", {}).get("overall_score") for s in sleep_entries]),
        "avg_overnight_hrv": _avg([s.get("avg_overnight_hrv") for s in sleep_entries]),
        "avg_rhr": _avg([s.get("resting_heart_rate") for s in sleep_entries]),
        "latest_score": _latest("quality", sleep_entries) and _latest("quality", sleep_entries).get("overall_score"),
    }

    stress = {
        "avg_7d": _avg([s.get("avg_level") for s in stress_entries]),
        "max_7d": _avg([s.get("max_level") for s in stress_entries]),
    }

    # ── Body metrics ────────────────────────────────────────────────────
    body_raw = garmin_data.get("body_metrics") or {}
    if hasattr(body_raw, "__dict__"):
        body_raw = body_raw.__dict__
    weight_data = (body_raw.get("weight") or {})
    weight_entries: list[dict] = weight_data.get("data") or [] if isinstance(weight_data, dict) else []
    weight_avg = weight_data.get("average") if isinstance(weight_data, dict) else None
    latest_weight = next((e.get("weight") for e in reversed(weight_entries) if e.get("weight")), None)
    earliest_weight = next((e.get("weight") for e in weight_entries if e.get("weight")), None)

    hydration_entries: list[dict] = body_raw.get("hydration") or []
    hydration_avg = _avg([h.get("intake") for h in hydration_entries if h.get("intake")])

    body = {
        "weight_kg": latest_weight or weight_avg,
        "weight_change_kg": round(latest_weight - earliest_weight, 2) if latest_weight and earliest_weight else None,
        "weight_entries": weight_entries[-14:],  # last 14 days for trend sparkline
        "hydration_avg_l": hydration_avg,
    }

    # ── Body battery ────────────────────────────────────────────────────
    bb_entries: list[dict] = garmin_data.get("body_battery") or []
    bb_levels = [e.get("end_of_day") for e in bb_entries if e.get("end_of_day") is not None]
    body_battery = {
        "latest": bb_levels[-1] if bb_levels else None,
        "avg_7d": _avg(bb_levels[-7:]) if bb_levels else None,
    }

    # ── Training readiness ──────────────────────────────────────────────
    tr_raw = garmin_data.get("training_readiness") or {}
    training_readiness = {
        "score": tr_raw.get("score"),
        "level": tr_raw.get("level"),
        "feedback": tr_raw.get("feedback"),
    } if tr_raw else {}

    # ── Race predictions ────────────────────────────────────────────────
    # Garmin's real race-predictor payload is flat with time5K/time10K/timeHalfMarathon/
    # timeMarathon int-seconds keys — confirmed against a real live response. The previous
    # guessed keys (fiveK, tenK, halfMarathon, raceTime5K, ...) never matched, so
    # kpis.race_predictions.* silently stayed null for every analyses row ever written.
    preds_raw = garmin_data.get("race_predictions") or {}

    def _pred_secs(key: str) -> int | None:
        v = preds_raw.get(key)
        if v is None:
            return None
        secs = v if isinstance(v, (int, float)) else (v.get("time") or v.get("raceDuration"))
        return int(secs) if secs else None

    race_predictions = {
        "5k_secs":            _pred_secs("time5K"),
        "10k_secs":           _pred_secs("time10K"),
        "half_marathon_secs": _pred_secs("timeHalfMarathon"),
        "marathon_secs":      _pred_secs("timeMarathon"),
    }

    return {
        "as_of": datetime.now().date().isoformat(),
        "training_load": training_load,
        "physiological": physiological,
        "hrv": hrv,
        "sleep": sleep,
        "stress": stress,
        "body": body,
        "body_battery": body_battery,
        "training_readiness": training_readiness,
        "race_predictions": race_predictions,
    }


def _extract_personal_records(garmin_data: dict[str, Any]) -> list[dict[str, Any]]:
    return garmin_data.get("personal_records") or []


def _compute_max_heart_rate(garmin_data: dict[str, Any]) -> int | None:
    """Highest HR recorded across all recent activities and per-day daily stats."""
    best: int | None = None

    def _consider(v: Any) -> None:
        nonlocal best
        if isinstance(v, int) and 100 < v < 230 and (best is None or v > best):
            best = v

    for acts_key in ("recent_activities", "all_activities"):
        for act in (garmin_data.get(acts_key) or []):
            _consider((act.get("summary") or {}).get("max_hr"))
    for ds in (garmin_data.get("daily_stats") or []):
        _consider(ds.get("max_heart_rate"))
    return best


def _compute_bench_e1rm(garmin_data: dict[str, Any]) -> float | None:
    """Epley e1RM from the heaviest barbell bench set across recent activities."""
    best: float | None = None
    for act in (garmin_data.get("recent_activities") or []):
        for s in (act.get("exercise_sets") or []):
            if s.get("set_type") == "REST":
                continue
            cat = (s.get("exercise_category") or "").upper()
            if "BENCH_PRESS" not in cat:
                continue
            name = (s.get("exercise_name") or "").upper()
            if any(x in name for x in ("MACHINE", "SMITH", "CABLE")):
                continue
            w = s.get("weight_kg")
            r = s.get("reps")
            if w and r and r > 1:
                e1rm = w * (1 + r / 30)
                if best is None or e1rm > best:
                    best = e1rm
    return round(best, 1) if best is not None else None


def _compute_predicted_5k_secs(garmin_data: dict[str, Any]) -> int | None:
    """Extract 5k prediction (seconds) from Garmin race predictions payload."""
    secs = extract_predicted_5k_secs(garmin_data)
    if secs is None:
        # Log the raw payload once so we can refine the key on the next run.
        preds = garmin_data.get("race_predictions")
        if preds:
            logger.info("race_predictions payload (for key mapping): %s", json.dumps(preds)[:500])
    return secs


def _compute_predicted_race_secs(garmin_data: dict[str, Any], key: str) -> int | None:
    """Extract a race-time prediction (seconds) from Garmin's race_predictions payload —
    confirmed live flat with int-seconds keys time5K/time10K/timeHalfMarathon/timeMarathon
    (see _compute_kpis' race_predictions block for the same mapping).
    """
    preds = garmin_data.get("race_predictions") or {}
    v = preds.get(key)
    if v is None:
        return None
    secs = v if isinstance(v, (int, float)) else (v.get("time") or v.get("raceDuration"))
    return int(secs) if secs else None


def _sync_completed_exercise_sets(garmin_data: dict[str, Any], days_back: int = 21) -> None:
    """Match completed Garmin exercise sets to planned exercises and persist them, for
    autoregulated weight progression. Best-effort: logs a warning and continues on failure rather
    than breaking the pipeline, since this feeds a secondary display feature, not the plan itself.
    """
    if not os.environ.get("SUPABASE_URL") or not os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
        return
    try:
        today = date.today()
        planned = get_planned_exercises_by_date(
            (today - timedelta(days=days_back)).isoformat(), today.isoformat()
        )
        records = build_completed_exercise_set_records(garmin_data, planned)
        upsert_completed_exercise_sets(records)
    except Exception as exc:
        logger.warning("⚠️  Completed exercise set sync failed (non-fatal): %s", exc)


def _write_to_supabase(
    result: dict[str, Any],
    workout_ids: dict[tuple[str, str], Any],
    running_workout_ids: dict[tuple[str, str], Any] | None = None,
    garmin_data: dict[str, Any] | None = None,
) -> None:
    """Write the completed plan to Supabase. Logs a warning and continues on failure."""
    if not os.environ.get("SUPABASE_URL") or not os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
        logger.debug("Supabase not configured — skipping write.")
        return
    try:
        weekly_plan = result.get("weekly_plan") or {}
        markdown = weekly_plan.get("output", "") if isinstance(weekly_plan, dict) else str(weekly_plan)
        plan_id = write_plan(
            markdown=markdown,
            scheduled_days=result.get("scheduled_days") or [],
            strength_sessions=result.get("strength_sessions") or [],
            garmin_workout_ids=workout_ids,
            running_sessions=result.get("running_sessions") or [],
            running_workout_ids=running_workout_ids or {},
        )
        logger.info("📊 Plan saved to Supabase (id=%s)", plan_id)
        analysis_html = result.get("analysis_html") or ""
        planning_html = result.get("planning_html") or ""
        if isinstance(analysis_html, dict):
            analysis_html = analysis_html.get("content", "")
        if isinstance(planning_html, dict):
            planning_html = planning_html.get("content", "")
        if analysis_html or planning_html:
            gd = garmin_data or {}
            bench_e1rm = _compute_bench_e1rm(gd)
            predicted_5k = _compute_predicted_5k_secs(gd)
            max_hr = _compute_max_heart_rate(gd)
            if bench_e1rm:
                logger.info("📈 Bench e1RM: %.1f kg", bench_e1rm)
            if predicted_5k:
                logger.info("🏃 Predicted 5k: %d s (%d:%02d)", predicted_5k, predicted_5k // 60, predicted_5k % 60)
            if max_hr:
                logger.info("❤️  Max HR: %d bpm", max_hr)
            write_report(
                analysis_html=analysis_html,
                planning_html=planning_html,
                bench_e1rm_kg=bench_e1rm,
                predicted_5k_secs=predicted_5k,
                predicted_10k_secs=_compute_predicted_race_secs(gd, "time10K"),
                predicted_half_marathon_secs=_compute_predicted_race_secs(gd, "timeHalfMarathon"),
                predicted_marathon_secs=_compute_predicted_race_secs(gd, "timeMarathon"),
                max_heart_rate_bpm=max_hr,
                kpis=_compute_kpis(gd),
                personal_records=_extract_personal_records(gd),
            )
    except Exception as exc:
        logger.warning("⚠️  Supabase write failed (plan still saved locally): %s", exc)


_DATE_PREFIX_RE = re.compile(r"^([A-Za-z]{3} \d{1,2}) · ")


def _orphaned_workout_ids_by_date(client: Any, dates: list[str]) -> dict[str, list[int]]:
    """Find Garmin workouts whose title carries one of the given dates' "<Mon> <Day> · "
    prefix (our own upload naming convention — see workout_name construction below),
    regardless of what Supabase currently remembers.

    Supabase's garmin_workout_id columns are the primary record of what to delete before a
    resync, but a crash between a successful Garmin upload and the Supabase write that
    persists its ID (real incident: a NameError killed a run after 18 running workouts were
    already live on Garmin but before their IDs reached Supabase) leaves those workouts
    permanently untracked — no future sync would ever know to remove them, since cleanup only
    ever trusts Supabase. Matching by the date embedded in the title instead is self-healing:
    it finds and removes duplicates for a date even if Supabase's record of that date's ID is
    stale, missing, or was never written. Caveat: the title's "Mon Day" has no year, so a
    same-month-and-day workout from a different year would false-positive match — acceptable
    given the alternative (silently accumulating orphans forever) is worse.
    """
    prefix_to_date = {}
    for d in dates:
        try:
            prefix_to_date[datetime.strptime(d, "%Y-%m-%d").strftime("%b %-d")] = d
        except ValueError:
            continue
    if not prefix_to_date:
        return {}

    all_workouts = client.get_workouts(0, 500)
    if len(all_workouts) >= 500:
        logger.warning(
            "Garmin workout library returned %d entries (limit) — orphan detection may miss "
            "older entries beyond this page.", len(all_workouts),
        )

    found: dict[str, list[int]] = {}
    for w in all_workouts:
        match = _DATE_PREFIX_RE.match(w.get("workoutName") or "")
        session_date = prefix_to_date.get(match.group(1)) if match else None
        workout_id = w.get("workoutId")
        if session_date and workout_id:
            found.setdefault(session_date, []).append(int(workout_id))
    return found


def _sync_strength_sessions(
    new_sessions: list[dict[str, Any]],
    old_workout_ids: dict[tuple[str, str], Any],
    email: str,
    password: str,
) -> dict[tuple[str, str], Any]:
    """Delete future planned Garmin workouts, then upload new sessions. Single connection.

    Sessions whose date is in the past are assumed completed and left untouched.
    Returns {(date, time_slot): {workout_id, schedule_id, name}} for the newly uploaded
    sessions — keyed by (date, time_slot) since a date can hold more than one strength session
    (see migration 045); a bare-date dict would silently drop one of two same-day uploads'
    tracked ids.
    """
    today = date.today().isoformat()

    gc = GarminConnectClient()
    gc.connect(email=email, password=password)
    client = gc.client
    new_workout_ids: dict[tuple[str, str], Any] = {}

    try:
        # Remove old planned sessions that haven't happened yet — union of what Supabase
        # remembers and what's actually on Garmin for these dates (see
        # _orphaned_workout_ids_by_date's docstring for why both are needed). Deletion itself
        # only needs date granularity — Garmin workout titles don't encode time_slot, and we
        # delete everything for a date before re-uploading fresh sessions for it regardless of
        # how many slots it holds.
        to_delete: dict[str, set[int]] = {}
        for (session_date, _slot), entry in old_workout_ids.items():
            if session_date >= today and entry.get("workout_id"):
                to_delete.setdefault(session_date, set()).add(int(entry["workout_id"]))
        for session_date, ids in _orphaned_workout_ids_by_date(
            client, [s["date"] for s in new_sessions]
        ).items():
            to_delete.setdefault(session_date, set()).update(ids)

        for session_date, id_set in to_delete.items():
            for workout_id in id_set:
                try:
                    delete_strength_workout(client, workout_id)
                except Exception:
                    logger.warning(
                        "Could not delete old workoutId=%s for %s — skipping",
                        workout_id, session_date,
                    )

        # Upload new sessions
        for s in new_sessions:
            exercises = [
                PlannedExercise(
                    garmin_category=ex["garmin_category"],
                    display_name=ex["display_name"],
                    garmin_exercise_key=ex.get("garmin_exercise_key"),
                    # reps_max: Garmin's structured workout never displays/enforces a rep
                    # target on the watch (athlete advances sets via lap button), so which
                    # end of the range we pass here is informational only.
                    sets=[PlannedSet(
                        reps=ex["reps_max"],
                        weight_kg=ex.get("weight_kg"),
                    )] * ex["sets"],
                    rest_seconds=ex.get("rest_seconds", 120),
                )
                for ex in s.get("exercises", [])
            ]
            raw_date = s["date"]
            try:
                date_prefix = datetime.strptime(raw_date, "%Y-%m-%d").strftime("%b %-d")
            except ValueError:
                date_prefix = raw_date
            workout_name = f"{date_prefix} · {s['name']}"
            session = PlannedStrengthSession(
                name=workout_name,
                date=raw_date,
                exercises=exercises,
                estimated_duration_secs=s.get("estimated_duration_secs", 3600),
            )
            try:
                entry = upload_strength_session(client, session)
                new_workout_ids[(session.date, s.get("time_slot", "day"))] = entry
                logger.info(
                    "✅ '%s' → workoutId=%s scheduled on %s",
                    session.name, entry["workout_id"], session.date,
                )
            except Exception:
                logger.exception("❌ Failed to upload '%s'", session.name)
    finally:
        gc.disconnect()
    return new_workout_ids


def _sync_running_sessions(
    new_sessions: list[dict[str, Any]],
    old_workout_ids: dict[tuple[str, str], Any],
    email: str,
    password: str,
    scheduled_days: list[dict[str, Any]] | None = None,
) -> dict[tuple[str, str], Any]:
    """Delete future planned Garmin running workouts, then upload new sessions. Single connection.

    Mirrors _sync_strength_sessions() above. Sessions whose date is in the past are assumed
    completed and left untouched. Returns {(date, time_slot): {workout_id, schedule_id, name}}
    for the newly uploaded sessions.

    scheduled_days supplies each date's `focus` label (e.g. "VO2max", "Tempo") for the Garmin
    workout name — running_sessions itself carries no name field, unlike strength sessions whose
    name comes from the template slot.
    """
    today = date.today().isoformat()
    focus_by_key = {
        (d["date"], d.get("time_slot", "day")): d.get("focus") for d in (scheduled_days or [])
    }

    gc = GarminConnectClient()
    gc.connect(email=email, password=password)
    client = gc.client
    new_workout_ids: dict[tuple[str, str], Any] = {}

    try:
        to_delete: dict[str, set[int]] = {}
        for (session_date, _slot), entry in old_workout_ids.items():
            if session_date >= today and entry.get("workout_id"):
                to_delete.setdefault(session_date, set()).add(int(entry["workout_id"]))
        for session_date, ids in _orphaned_workout_ids_by_date(
            client, [s["date"] for s in new_sessions]
        ).items():
            to_delete.setdefault(session_date, set()).update(ids)

        for session_date, id_set in to_delete.items():
            for workout_id in id_set:
                try:
                    delete_running_workout(client, workout_id)
                except Exception:
                    logger.warning(
                        "Could not delete old running workoutId=%s for %s — skipping",
                        workout_id, session_date,
                    )

        for s in new_sessions:
            segments = [
                PlannedRunningSegment(
                    segment_type=seg["segment_type"],
                    zone=seg.get("zone"),
                    duration_secs=seg.get("duration_secs"),
                    distance_meters=seg.get("distance_meters"),
                    pace_low=seg.get("pace_low"),
                    pace_high=seg.get("pace_high"),
                    repeat_count=seg.get("repeat_count", 1),
                    note=seg.get("note"),
                )
                for seg in s.get("segments", [])
            ]
            if not segments:
                continue
            raw_date = s["date"]
            try:
                date_prefix = datetime.strptime(raw_date, "%Y-%m-%d").strftime("%b %-d")
            except ValueError:
                date_prefix = raw_date
            time_slot = s.get("time_slot", "day")
            focus = focus_by_key.get((raw_date, time_slot))
            workout_name = f"{date_prefix} · {focus}" if focus else f"{date_prefix} · Run"
            session = PlannedRunningSession(
                name=workout_name,
                date=raw_date,
                segments=segments,
                estimated_duration_secs=estimate_running_duration_secs(s.get("segments", [])),
            )
            try:
                entry = upload_running_session(client, session)
                new_workout_ids[(session.date, time_slot)] = entry
                logger.info(
                    "✅ '%s' → workoutId=%s scheduled on %s",
                    session.name, entry["workout_id"], session.date,
                )
            except Exception:
                logger.exception("❌ Failed to upload '%s'", session.name)
    finally:
        gc.disconnect()
    return new_workout_ids


async def process_queue(config_path: Path) -> None:
    """Process pending replan jobs queued via the web UI."""
    from services.supabase.client import get_supabase, rows

    sb = get_supabase()
    uid = os.environ.get("SUPABASE_USER_ID", "")
    if not uid:
        logger.error("❌ SUPABASE_USER_ID not set — cannot process queue")
        sys.exit(1)

    jobs = rows(
        sb.table("replan_jobs").select("*").eq("user_id", uid).eq("status", "pending").order("created_at").execute()
    )

    if not jobs:
        logger.info("✅ No pending replan jobs.")
        return

    logger.info("Found %d pending job(s).", len(jobs))

    for job in jobs:
        job_id      = job["id"]
        job_type    = job["type"]
        user_comment = job.get("user_comment") or None
        logger.info("Processing job %s (type=%s)…", job_id, job_type)
        if user_comment:
            logger.info("  with user note: %s", user_comment[:80])

        sb.table("replan_jobs").update({
            "status": "running",
            # UTC-aware — a naive local timestamp gets misread as already-UTC by Postgres,
            # skewing "how long ago" displays by the local UTC offset (verified live).
            "started_at": datetime.now(UTC).isoformat(),
        }).eq("id", job_id).execute()

        try:
            coach_feedback = None
            if job_type in ("daily", "replan"):
                # "daily" (Reschedule) and "replan" (Check-In) both go through the same AI-driven
                # replan pipeline now — Reschedule's user_comment already carries the
                # calendar-selected missed/upcoming-constraint dates, formatted as real instruction
                # text, so it's treated identically to a Check-In note (was previously "mechanical"
                # and ignored by the AI — that's what made Reschedule unable to actually replan
                # around availability constraints).
                # Fetch scheduled days beyond the 6-week window to preserve them
                cutoff = (datetime.now() + timedelta(days=42)).strftime("%Y-%m-%d")
                plan_res = rows(
                    sb.table("plans").select("id").eq("user_id", uid).order("created_at", desc=True).limit(1).execute()
                )
                outer_days: list[dict] = []
                if plan_res:
                    outer_res = rows(sb.table("scheduled_days").select(
                        "date, session_type, focus, description, is_key, is_rest"
                    ).eq("plan_id", plan_res[0]["id"]).gte("date", cutoff).execute())
                    outer_days = [
                        {
                            "date": d["date"],
                            "session_type": d.get("session_type", "rest"),
                            "focus": d.get("focus", ""),
                            "description": d.get("description", ""),
                            "is_key_session": d.get("is_key", False),
                            "is_rest": d.get("is_rest", False),
                        }
                        for d in outer_res
                    ]
                    logger.info("Fetched %d outer days (beyond day 42) to preserve", len(outer_days))
                coach_feedback = await run_replan_from_config(
                    config_path, user_comment=user_comment, outer_scheduled_days=outer_days,
                    replan_job_id=job_id,
                )
            elif job_type == "seasonal":
                await run_analysis_from_config(config_path, user_comment=user_comment)
                coach_feedback = None
            elif job_type == "sync_kpis":
                coach_feedback = cmd_sync_kpis(config_path)
            else:
                raise ValueError(f"Unknown job type: {job_type}")

            done_payload: dict = {
                "status": "done",
                "completed_at": datetime.now(UTC).isoformat(),
            }
            if coach_feedback:
                done_payload["coach_feedback"] = coach_feedback
            sb.table("replan_jobs").update(done_payload).eq("id", job_id).execute()
            logger.info("✅ Job %s done.", job_id)

        except Exception as exc:
            sb.table("replan_jobs").update({
                "status": "error",
                "error_message": str(exc)[:500],
                "completed_at": datetime.now(UTC).isoformat(),
            }).eq("id", job_id).execute()
            logger.error("❌ Job %s failed: %s", job_id, exc)


def create_config_template(output_path: Path) -> None:
    template_path = Path(__file__).parent / "coach_config_template.yaml"

    if template_path.exists():
        output_path.write_text(template_path.read_text(encoding="utf-8"), encoding="utf-8")
        logger.info("✅ Config template created: %s", output_path)
        logger.info("Edit this file with your settings and run analysis with --config")
    else:
        logger.error("❌ Template file not found")


_SYNC_STAMP = Path.home() / ".ams-kpi-sync"
# Stamp path before the project was renamed. Read as a fallback so the first run
# after the rename still respects KPI_SYNC_MIN_INTERVAL rather than firing
# immediately. Writes always go to the current path, so this fades out on its own.
_LEGACY_SYNC_STAMP = Path.home() / ".garmin-ai-coach-kpi-sync"


def _read_sync_stamp() -> str | None:
    """Return the last-run ISO timestamp, or None if there is no readable stamp."""
    for path in (_SYNC_STAMP, _LEGACY_SYNC_STAMP):
        if path.exists():
            return path.read_text().strip()
    return None

# Minimum time between successful KPI syncs. This is a personal single-user app —
# a finished workout or fresh HRV/sleep reading doesn't need sub-hour freshness for
# a coaching app, and we don't want to hammer the unofficial Garmin API more than
# necessary. 2 hours means at most ~12 real syncs/day even if the LaunchAgent fires
# far more often (it fires every 30 min as a cheap "trigger opportunity" — see the
# plist). Tune by changing this one constant.
KPI_SYNC_MIN_INTERVAL = timedelta(hours=2)


def _format_timedelta(td: timedelta) -> str:
    """Render a timedelta as e.g. '1h23m' for compact log lines."""
    total_minutes = int(td.total_seconds() // 60)
    hours, minutes = divmod(max(total_minutes, 0), 60)
    if hours:
        return f"{hours}h{minutes:02d}m"
    return f"{minutes}m"


# A handful of short, deterministic (non-LLM) status strings surfaced verbatim as a
# replan_job's coach_feedback — e.g. RefreshDataButton.tsx's "Already synced recently"
# tooltip and ReplanPanel.tsx's "Coach Feedback" panel. These bypass the LangGraph
# pipeline entirely (no LLM call), so get_language_instructions() never sees them and
# they need their own translation here, keyed the same way as web/lib/i18n's dictionaries.
_FEEDBACK_STRINGS: dict[str, dict[str, str]] = {
    "en": {
        "already_up_to_date": "Already up to date — last synced {elapsed} ago (next refresh eligible in {remaining}).",
        "synced_at": "Synced at {time}.",
        "shift_moved": (
            "Every planned session was completed, just {days} day(s) later than scheduled — "
            "so the whole plan moved with you, keeping the same order and spacing. "
            "{shifted} day(s) moved; no training was lost."
        ),
        "shift_compressed_suffix": " {count} day(s) were compressed so your race dates stay fixed.",
    },
    "no": {
        "already_up_to_date": "Allerede oppdatert — sist synkronisert for {elapsed} siden (neste oppdatering mulig om {remaining}).",
        "synced_at": "Synkronisert kl. {time}.",
        "shift_moved": (
            "Alle planlagte økter ble gjennomført, bare {days} dag(er) senere enn planlagt — "
            "så hele planen flyttet seg med deg, med samme rekkefølge og avstand. "
            "{shifted} dag(er) ble flyttet; ingen trening gikk tapt."
        ),
        "shift_compressed_suffix": " {count} dag(er) ble komprimert slik at konkurransedatoene dine ligger fast.",
    },
}


def _feedback(language: str, key: str, **kwargs: str) -> str:
    return _FEEDBACK_STRINGS.get(language, _FEEDBACK_STRINGS["en"])[key].format(**kwargs)


def cmd_sync_kpis(config_path: Path) -> str | None:
    """Lightweight KPI sync — no AI, no plan generation.

    Skips unless at least KPI_SYNC_MIN_INTERVAL has elapsed since the last
    successful run (tracked via a local stamp file storing an ISO timestamp),
    so the LaunchAgent can fire frequently without over-syncing.

    Returns a short status string describing what happened (used as a queued
    job's coach_feedback so the web UI's manual refresh button can tell the
    athlete "already up to date" apart from a silent no-op), or None when the
    caller doesn't need it (LaunchAgent invocation via --sync-kpis).
    """
    now = datetime.now()
    config_parser = ConfigParser(config_path)
    language = config_parser.get_language()

    raw = _read_sync_stamp()
    if raw is not None:
        last_run = None
        try:
            last_run = datetime.fromisoformat(raw)
        except ValueError:
            logger.warning(
                "⚠️  KPI sync stamp file is unreadable (%r) — treating as no prior run.",
                raw,
            )

        if last_run is not None:
            elapsed = now - last_run
            if elapsed < KPI_SYNC_MIN_INTERVAL:
                remaining = KPI_SYNC_MIN_INTERVAL - elapsed
                logger.info(
                    "⏭️  KPI sync skipped — last run %s ago, next eligible in %s "
                    "(minimum interval %s).",
                    _format_timedelta(elapsed),
                    _format_timedelta(remaining),
                    _format_timedelta(KPI_SYNC_MIN_INTERVAL),
                )
                return _feedback(
                    language, "already_up_to_date",
                    elapsed=_format_timedelta(elapsed), remaining=_format_timedelta(remaining),
                )

    _, email = config_parser.get_athlete_info()
    password = config_parser.get_password()

    logger.info("🔄 KPI sync starting at %s …", now.isoformat(timespec="seconds"))

    # Minimal extraction: only what's needed for daily metrics (activity summaries
    # so completed sessions sync to the calendar — no per-activity detail calls;
    # normally a 3-day window to capture last night's sleep, widened automatically if
    # the athlete hasn't synced in longer than that — summaries-only keeps a wider
    # pull cheap even across a real gap (see get_sync_gap_days's docstring).
    sync_lookback_days = get_sync_gap_days(3)
    extraction_config = ExtractionConfig(
        activities_range=sync_lookback_days,
        metrics_range=sync_lookback_days,
        include_detailed_activities=True,
        activity_summaries_only=True,
        include_metrics=True,
        include_mindfulness=False,
        include_long_term_trends=False,
    )

    extractor = GarminDataExtractor(email, password)
    garmin_data = extractor.extract_data(extraction_config)
    gd = asdict(garmin_data)

    kpis = _compute_kpis(gd)
    personal_records = _extract_personal_records(gd)

    # Race predictions come from one cheap, always-fetched API call (unlike bench e1RM,
    # which needs per-set activity detail this lightweight extraction doesn't pull) — so
    # persist them on every KPI sync, not just once a week at Check-In. That's what gives
    # the dashboard's evolution charts enough points to actually render a trend.
    upsert_kpis(
        kpis=kpis,
        personal_records=personal_records or None,
        predicted_5k_secs=_compute_predicted_5k_secs(gd),
        predicted_10k_secs=_compute_predicted_race_secs(gd, "time10K"),
        predicted_half_marathon_secs=_compute_predicted_race_secs(gd, "timeHalfMarathon"),
        predicted_marathon_secs=_compute_predicted_race_secs(gd, "timeMarathon"),
    )

    # Also persist today's row into the dense time-series table for trend charts.
    # (Minimal extraction only covers ~3 days, so this adds/updates a small window.)
    upsert_daily_metrics_batch(build_daily_metrics_records(gd))
    upsert_completed_activities(build_completed_activity_records(gd))
    _sync_completed_exercise_sets(gd, days_back=3)

    # Refresh today's nutrition target now that today's active_calories may have moved —
    # this is what makes the target genuinely track estimated burn "at all times" rather than
    # being frozen at whatever it was set to that morning. Free (no LLM), so safe to redo on
    # every sync-kpis run rather than needing its own separate cron. Also finalize the last few
    # days' targets against Garmin's now-settled totals, so a concluded day shows what was
    # actually burned rather than the estimate that was set that morning.
    try:
        sync_todays_nutrition_target()
        finalize_recent_nutrition_targets()
    except Exception:
        logger.exception("Failed to sync nutrition targets — continuing KPI sync")

    _SYNC_STAMP.write_text(now.isoformat())
    logger.info("✅ KPI sync complete at %s.", now.isoformat(timespec="seconds"))
    return _feedback(language, "synced_at", time=now.strftime("%H:%M"))


def cmd_shift_plan(config_path: Path, days: int = 1, from_date: str | None = None) -> str:
    """Slide the remaining plan forward N days, then re-push the moved workouts to Garmin.

    The DB-level move (including race-collision compression) is plan_writer.shift_plan; this
    wrapper handles the Garmin side, which shift_plan deliberately leaves alone: the workouts
    are still scheduled on their OLD dates in Garmin, so every moved session has to be deleted
    and re-uploaded. Reuses the same _sync_* helpers a check-in uses, which already
    delete-and-replace by date.
    """
    if days == 0:
        return "Nothing to do — 0 days."
    start = from_date or date.today().isoformat()

    result = shift_plan(from_date=start, days=days)
    for warning in result.get("warnings", []):
        logger.warning("⚠️  %s", warning)
    for d in result.get("dropped", []):
        logger.info("   dropped %s (%s)", d["date"], "rest day" if d.get("is_rest") else d.get("focus") or "session")
    if not result.get("shifted"):
        return result.get("warnings", ["Nothing was shifted."])[0]

    cp = ConfigParser(config_path)
    _, email = cp.get_athlete_info()
    if not cp.get_extraction_config().get("upload_to_garmin", False):
        logger.info("📲 upload_to_garmin disabled — plan moved in the app only.")
        return f"Shifted {result['shifted']} day(s) by +{days}."

    password = cp.get_password()
    today_iso = date.today().isoformat()
    sb = get_supabase()
    uid = os.environ.get("SUPABASE_USER_ID", "")

    strength = rows(
        sb.table("strength_sessions").select("id, date, time_slot, name, estimated_duration_secs")
        .eq("user_id", uid).gte("date", today_iso).order("date").execute()
    )
    new_sessions = []
    strength_id_by_key: dict[tuple[str, str], str] = {}
    for s in strength:
        exercises = rows(
            sb.table("exercises").select("*").eq("session_id", s["id"]).order("display_order").execute()
        )
        time_slot = s.get("time_slot") or "day"
        new_sessions.append({
            "date": s["date"], "time_slot": time_slot, "name": s["name"], "exercises": exercises,
            "estimated_duration_secs": s["estimated_duration_secs"],
        })
        strength_id_by_key[(s["date"], time_slot)] = s["id"]
    if new_sessions:
        logger.info("📲 Re-pushing %d strength session(s) after shift…", len(new_sessions))
        ids = _sync_strength_sessions(
            new_sessions, get_future_garmin_workout_ids(today_iso), email, password
        )
        # Row-id-scoped, not date-scoped — two strength sessions can share a date (different
        # time_slot) since migration 045; filtering by bare date would stamp the same workout
        # id onto both rows.
        for key, entry in ids.items():
            row_id = strength_id_by_key.get(key)
            if row_id:
                sb.table("strength_sessions").update({"garmin_workout_id": entry["workout_id"]}) \
                    .eq("id", row_id).execute()

    days_rows = rows(
        sb.table("scheduled_days").select("id, date, time_slot, focus, running_segments")
        .eq("user_id", uid).gte("date", today_iso)
        .not_.is_("running_segments", "null").order("date").execute()
    )
    scheduled_day_id_by_key = {(r["date"], r.get("time_slot") or "day"): r["id"] for r in days_rows}
    running = [
        {"date": r["date"], "time_slot": r.get("time_slot") or "day", "segments": r["running_segments"]}
        for r in days_rows if r["running_segments"]
    ]
    if running:
        logger.info("📲 Re-pushing %d running session(s) after shift…", len(running))
        ids = _sync_running_sessions(
            running, get_future_garmin_running_workout_ids(today_iso), email, password,
            scheduled_days=[
                {"date": r["date"], "time_slot": r.get("time_slot") or "day", "focus": r.get("focus")}
                for r in days_rows
            ],
        )
        for key, entry in ids.items():
            row_id = scheduled_day_id_by_key.get(key)
            if row_id:
                sb.table("scheduled_days").update({"garmin_workout_id": entry["workout_id"]}) \
                    .eq("id", row_id).execute()

    summary = f"Shifted {result['shifted']} day(s) by +{days}."
    if result.get("dropped"):
        summary += f" Compressed {len(result['dropped'])} day(s) to keep races on their dates."
    logger.info("✅ %s", summary)
    return summary


def cmd_sync_history(config_path: Path) -> None:
    """Full historical backfill of daily_metrics (up to 365 days from Garmin).

    - training_load_history: 365 days of EWMA metrics computed from activity loads
    - vo2_max_history: all available VO2max estimates
    - body_battery: last 56 days of end-of-day levels
    - recovery_indicators: last 56 days of sleep/HRV/RHR/stress
    - body_metrics: all available weight history

    After the first run, ``--sync-kpis`` keeps daily_metrics current day-by-day.
    """
    cp = ConfigParser(config_path)
    _, email = cp.get_athlete_info()
    password = cp.get_password()

    # metrics_range capped at 14: Garmin's body battery endpoint returns 400
    # for windows wider than ~14 days. Training load comes from activities
    # (unaffected) and VO2max from long_term_trends (also unaffected).
    extraction_config = ExtractionConfig(
        activities_range=21,
        metrics_range=14,
        include_detailed_activities=False,
        include_metrics=True,
        include_mindfulness=False,
        include_long_term_trends=True,
        long_term_range=365,
        long_term_interval=7,
    )

    logger.info("🔄 Starting full history sync (up to 365 days) — this may take a few minutes…")
    extractor = GarminDataExtractor(email, password)
    garmin_data = extractor.extract_data(extraction_config)
    gd = asdict(garmin_data)

    records = build_daily_metrics_records(gd)
    n = upsert_daily_metrics_batch(records)
    logger.info("✅ History sync complete — %d daily metric rows upserted.", n)


def main():
    parser = argparse.ArgumentParser(
        description="Athlete Management System CLI — hybrid training, nutrition and Garmin sync",
        epilog="Example: python cli/ams.py --config my_config.yaml",
    )

    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--config", type=Path, help="Path to configuration file (YAML or JSON)")
    group.add_argument("--replan", type=Path, metavar="CONFIG",
                       help="Tier-2 weekly re-plan: fetch 14 days of Garmin data and re-run "
                            "only the weekly planner against the stored season plan (a fraction of a full run)")
    group.add_argument("--queue", type=Path, metavar="CONFIG",
                       help="Process pending replan jobs queued via the web UI")
    group.add_argument("--sync-kpis", type=Path, metavar="CONFIG",
                       help="Lightweight KPI sync (no AI). Safe to run frequently — "
                            "skips automatically if run within the last KPI_SYNC_MIN_INTERVAL.")
    group.add_argument("--sync-history", type=Path, metavar="CONFIG",
                       help="Backfill up to 365 days of trend data from Garmin into daily_metrics. "
                            "Run once after initial setup, then daily sync keeps it current.")
    group.add_argument("--shift", type=Path, metavar="CONFIG",
                       help="Slide the remaining plan forward N days (--days, default 1), preserving "
                            "session order and relative spacing. Fixed races stay anchored — the "
                            "segment before them is compressed instead. Re-pushes moved workouts to Garmin.")
    group.add_argument("--set-password", type=Path, metavar="CONFIG",
                       help="Securely store Garmin password in the system keychain (run once, never stored in files)")
    group.add_argument("--init-config", type=Path, help="Create a configuration template file")

    parser.add_argument("--output-dir", type=Path, help="Override output directory from config")
    parser.add_argument("--days", type=int, default=1,
                        help="Days to slide the plan forward with --shift (default 1).")
    parser.add_argument("--from-date", type=str, default=None,
                        help="First date to shift with --shift (default: today).")

    args = parser.parse_args()

    if args.set_password:
        config_parser = ConfigParser(args.set_password)
        _, email = config_parser.get_athlete_info()
        try:
            import keyring
        except ImportError:
            logger.error("❌ keyring not installed — run: pixi install")
            sys.exit(1)
        password = getpass.getpass(f"Garmin password for {email}: ")
        keyring.set_password("athlete-management-system", email, password)
        logger.info("✅ Password stored in system keychain for %s", email)
        return

    if args.init_config:
        create_config_template(args.init_config)
        return

    if args.config:
        try:
            asyncio.run(run_analysis_from_config(args.config))
        except KeyboardInterrupt:
            logger.info("❌ Analysis cancelled by user")
        except Exception as e:
            logger.error("❌ Analysis failed: %s", e)
            sys.exit(1)

    if args.replan:
        try:
            asyncio.run(run_replan_from_config(args.replan))
        except KeyboardInterrupt:
            logger.info("❌ Re-plan cancelled by user")
        except Exception as e:
            logger.error("❌ Re-plan failed: %s", e)
            sys.exit(1)

    if args.queue:
        try:
            asyncio.run(process_queue(args.queue))
        except KeyboardInterrupt:
            logger.info("❌ Queue processing cancelled")
        except Exception as e:
            logger.error("❌ Queue processing failed: %s", e)
            sys.exit(1)

    if args.sync_kpis:
        try:
            cmd_sync_kpis(args.sync_kpis)
        except KeyboardInterrupt:
            logger.info("❌ KPI sync cancelled")
        except Exception as e:
            logger.error("❌ KPI sync failed: %s", e)
            sys.exit(1)

    if args.shift:
        try:
            cmd_shift_plan(args.shift, days=args.days, from_date=args.from_date)
        except KeyboardInterrupt:
            logger.info("❌ Shift cancelled")
        except Exception as e:
            logger.error("❌ Shift failed: %s", e)
            sys.exit(1)

    if args.sync_history:
        try:
            cmd_sync_history(args.sync_history)
        except KeyboardInterrupt:
            logger.info("❌ History sync cancelled")
        except Exception as e:
            logger.error("❌ History sync failed: %s", e)
            sys.exit(1)



if __name__ == "__main__":
    main()
