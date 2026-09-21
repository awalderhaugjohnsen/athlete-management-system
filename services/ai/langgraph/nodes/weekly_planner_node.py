import itertools
import json
import logging
import os
from datetime import date, datetime, timedelta
from typing import Any

from services.ai.ai_settings import AgentRole
from services.ai.langgraph.schemas.agent_outputs import WeeklyPlanOutput
from services.ai.langgraph.schemas.checkin_outputs import CheckinContentOutput, CheckinTranslationOutput
from services.ai.langgraph.state.training_analysis_state import TrainingAnalysisState
from services.ai.langgraph.utils.message_helper import normalize_langchain_messages
from services.ai.langgraph.utils.output_helper import extract_agent_content, extract_expert_output
from services.ai.model_config import ModelSelector
from services.ai.utils.retry_handler import AI_ANALYSIS_CONFIG, retry_with_backoff
from services.garmin.training_paces import build_training_paces_context
from services.scheduling.live_state import compute_checkin_fixed_days, resolve_today_pin
from services.scheduling.muscle_groups import slot_muscle_groups
from services.scheduling.solver import FREE, SLOTS, solve_schedule
from services.supabase.athlete_profile import build_strength_templates_context, get_strength_session_templates
from services.supabase.plan_writer import get_next_strength_slot
from services.supabase.program_specs import fetch_checkin_context, get_active_program_spec

from .node_base import (
    configure_node_tools,
    create_timing_entry,
    execute_node_with_error_handling,
    log_node_completion,
)
from .prompt_components import get_hitl_instructions, get_language_instructions, get_workflow_context
from .tool_calling_helper import handle_tool_calling_in_node


def _safe_expert(output: Any, field: str) -> str:
    """Return expert analysis for `field`, or empty string if output is unavailable."""
    if output is None:
        return ""
    return extract_expert_output(output, field)

logger = logging.getLogger(__name__)

WEEKLY_PLANNER_SYSTEM_PROMPT = """## Goal
Create detailed, practical training plans that balance stress and recovery.
## Principles
- Adaptation: Progressive overload with adequate recovery.
- Specificity: Training must match the demands of the event.
- Individualization: Adapt to the athlete's current state and history."""

WEEKLY_PLANNER_USER_PROMPT = """## Task
Create a detailed training plan covering all {num_days} days listed in Upcoming Weeks below.

## Constraints
- **Honor the Phase**: Prioritize the Season Plan's phase intent.
- **Follow the Chosen Methodology (hard rule)**: The Season Plan's "Programming Methodology"
  section states which periodization approach was chosen for strength and for cardio and why, and
  its "Weekly Session Structure" section states an explicit per-lift/movement-pattern frequency
  and session-combination spec (e.g. how many times/week each major lift is trained, and which
  movement patterns share a session). Apply that structure LITERALLY — the exact session count and
  lift/movement combination per session — not just the general intensity feel of the approach
  (e.g. varying hard/easy for DUP is necessary but not sufficient). Do not fall back to a generic
  template (like a single Upper A/Upper B/Legs rotation) that ignores the season plan's stated
  structure. This is separate from — and checked in addition to — Recovery Spacing and Preserve
  Accessory Work below: those check calendar placement and per-session volume; this checks whether
  the count and combination of sessions matches the stated structure at all.
  Wrong: Season Plan states an explicit per-lift weekly frequency and session-combination spec,
  but the week's actual strength sessions don't match that count or combination — e.g. the spec
  calls for a lift to appear in multiple sessions per week and/or for specific movement patterns to
  be combined together, but the generated week instead uses a single weekly hit per lift via a
  generic split, or separates movement patterns the spec said to combine.
  Right: the week's strength sessions literally match the stated frequency and movement
  combination for every lift/pattern named in the Season Plan's Weekly Session Structure section —
  count the sessions each major lift appears in before finalizing and compare against the spec.
- **Strength Session Content (hard rule)**: You do NOT decide which exercises, sets, or reps
  appear in a strength session — the athlete has a fixed, saved template for each of their 3
  strength session slots (A/B/C), provided as read-only reference in the Strength Session
  Templates section below. Your only job for strength days is scheduling: decide which dates get
  which slot (in the `strength_sessions` structured field, as `{{date, slot}}` pairs), respecting
  Recovery Spacing and Legs Before Hard Runs below. Do not invent, reorder, add, or drop
  exercises — that would silently diverge from what the athlete actually has saved and expects.
  Use the templates only to write an accurate PURPOSE/description narrative in the markdown plan
  and to choose an appropriate `focus` label for `scheduled_days` (matching the slot's name).
- **Frequency vs Load (hard rule)**: Adding a session is NOT the same as adding training stress.
  An easy Z1/Z2 run, technique work, or light aerobic volume adds frequency at minimal load cost.
  The athlete's `sessions_per_week` figure in User Context is stated as "a baseline, not a cap —
  expand with readiness": treat it as a floor to actively try to EXCEED via easy sessions, not a
  target to merely reach. Per the Respect Readiness constraint below: if Physiology/Metrics have
  NOT flagged an active recovery concern, do not default to a Rest day just because nothing hard
  is scheduled — schedule a genuinely easy, non-key session instead. Reserve full Rest days for
  when recovery signals actually call for them, or for deliberate placement after key sessions —
  never as filler for landing at or below the athlete's stated baseline.
  Wrong: baseline 5, athlete asked for more, week has 5 sessions + 2 Rest days.
  Right: week has 6-7 sessions, with the added days being easy Z1/Z2 runs, Rest reserved for an
  actual recovery signal or planned placement.
- **Build the Stated Aerobic Base (hard rule)**: If the Season Plan's cardio methodology calls for
  a predominantly-easy aerobic base (e.g. polarized or pyramidal training), the week's schedule
  MUST include genuinely easy runs (session_type "run", is_key_session=false, is_rest=false — e.g.
  focus "Easy Aerobic" or "Recovery Run") to build that base. Do not mark every running session as
  key, and do not substitute a Rest day for what the methodology says should be easy volume.
- **Respect Readiness**: Adjust intensity based on Physiology/Metrics signals (e.g., pull back if recovery is low).
- **Integrate Signals**: Use Activity Expert advice for session structure.
- **Recovery Spacing (hard rule)**: Never schedule two strength sessions that train overlapping
  major muscle groups on adjacent calendar days — e.g., two upper-body sessions back-to-back, or
  two leg sessions back-to-back. Leave at least one full day between them. This applies across the
  *entire* multi-day/multi-week schedule you're producing in this single output, including the
  boundary between one week and the next — check your last strength session of week N against your
  first strength session of week N+1 before finalizing, not just within each week in isolation.
- **Legs Before Hard Runs (hard rule)**: Any strength session whose template includes leg work
  (squat, RDL, BSS, hip thrust, split squat — check the Strength Session Templates section below
  for which slots carry legs) must be scheduled at least 24 hours before any key run session
  (interval/VO2max or tempo/threshold) — i.e. never on the same calendar day as a key run. Easy
  aerobic runs are exempt from this rule — it only applies to hard/key run days. Check this across
  the week boundary the same way Recovery Spacing does. This has been violated in past generations
  specifically for VO2max — do not treat VO2max as a lighter exception just because it's shorter
  than tempo; it still requires the full 24h gap.
  Wrong: a leg-carrying strength session and VO2max intervals both scheduled on Saturday — 0h gap.
  Right: a leg-carrying strength session on Friday, then the next key run (VO2max or tempo) on
  Saturday or later — any different calendar day satisfies the gap; no full rest day is required
  between them.
- **Strength Session Order (hard rule)**: Strength sessions must cycle through slots A, B, C in
  that exact order, repeating (A, B, C, A, B, C, ...), with no skipping, reordering, or repeating a
  slot out of turn. The Next Strength Slot value given in the Inputs section below is the slot the
  *next* strength session you schedule must use — assign it to whichever calendar date you choose
  for that session, then continue the rotation (in calendar order) for every subsequent strength
  session you schedule in this output. You have full freedom over which calendar dates get a
  strength session (subject to Recovery Spacing and Legs Before Hard Runs above) — only the slot
  *order* is fixed, not the day-of-week.
- **Hard Run Spacing (hard rule)**: Never schedule two key run sessions (interval/VO2max and
  tempo/threshold) on adjacent calendar days — leave at least one easy or rest day between them.
  Stacking two hard run days back-to-back compounds fatigue into the second session (degrading its
  quality) and raises injury risk; this applies across the week boundary the same way Recovery
  Spacing does.
- **Preference Precedence (hard rule)**: The athlete's User Context below can contain multiple,
  sometimes overlapping statements of preference — a specific Recurring Session Request and a more
  general Soft Preference elsewhere may both speak to the same exercise. When a Recurring Session
  Request gives an explicit, literal number (sets, reps, exercise order, exact exercise name) for a
  session, that number is authoritative for that exercise — do not let a general Soft Preference
  (e.g. "prefers fewer sets taken to failure") override or water down a number the athlete stated
  explicitly and specifically for that session. General preferences only fill in what a Recurring
  Session Request left unspecified.
- **Brevity**: Use standard, compact notation for markdown plan text (e.g., "5' Z4" not "5 minutes
  at Zone 4 effort") — but brevity means terse notation in the markdown, not fewer segments. A
  running session's structured segments (running_sessions field, see the Structured Running
  Sessions rule below) must still cover every component (warm-up, main effort, cool-down, drills)
  as its own segment.
- **Use Current Training Paces (hard rule)**: Every running segment — easy aerobic, tempo/
  threshold, AND VO2max intervals — must carry a specific pace (pace_low/pace_high on its
  RunningSegment), not just a zone letter. Use the Current Training Paces given in the Inputs
  section below for every pace you set; these are computed fresh from the athlete's actual recent
  fitness (a real predicted-race-time formula), not invented. Do NOT derive a pace from the
  athlete's stated goal/target race time instead — the goal pace is where training is headed, not
  where it starts, and prescribing goal pace as today's session target is unsafe and unachievable.
  As the athlete's fitness improves over successive Check-Ins, the Current Training Paces you're
  given will themselves get faster and converge toward the goal — you don't need to (and must not)
  accelerate that yourself by setting a faster pace than what's provided.
  Wrong: athlete's goal is a sub-10:00 3000m (3:20/km average); a VO2max interval segment gets
  pace_low/pace_high near 3:15-3:25/km because that's close to the goal pace, even though Current
  Training Paces below states something slower.
  Right: every VO2max interval segment uses the exact vo2max pace range given in Current Training
  Paces below, regardless of how it compares to the athlete's longer-term goal pace.
  If Current Training Paces is empty/unavailable (no current fitness data yet), set `zone` only and
  leave pace_low/pace_high null on every segment for that session — never fall back to a
  goal-derived estimate.

## Inputs
### Season Plan
```markdown
{season_plan}
```
### Athlete Context
- Name: {athlete_name}
- Date: ```json {current_date} ```
- Upcoming Weeks: ```json {week_dates} ```
- Competitions: ```json {competitions} ```
- **User Context**: ``` {planning_context} ```

### Strength Session Templates (read-only — do not author exercises, see Strength Session
Content hard rule above)
```markdown
{strength_templates}
```

### Next Strength Slot
The next strength session you schedule must use slot **{next_strength_slot}** — see Strength
Session Order hard rule above for how the rotation continues from there.

### Current Training Paces (read-only — see Use Current Training Paces hard rule above)
```markdown
{training_paces}
```

### Expert Analysis
- Metrics: ``` {metrics_analysis} ```
- Activity: ``` {activity_analysis} ```
- Physiology: ``` {physiology_analysis} ```

## Output Requirements
1. **Zones Table**: Define intensity zones first, using the Current Training Paces given in the
   Inputs section above for the easy/tempo/VO2max pace figures — do not invent your own numbers
   for this table (see Use Current Training Paces hard rule above).
2. **Structure**: Group by week.
3. **Daily Format**:
   - **DAY & DATE**: e.g., "Mon, Nov 24"
   - **FOCUS**: 1-2 words (e.g., "Recovery", "VO2max")
   - **WORKOUT**: Concise structure string.
   - **PURPOSE**: One short sentence.
   - **ADAPTATION**: "If tired: ..."

**Important:**
- Use recent activity data to continue the current training flow and don't start a new phase.
- Use the Season Plan as a guide, but don't force it.
- Place sessions smartly to avoid back-to-back high-intensity sessions.
- Re-read the Recovery Spacing constraint above before finalizing — verify no two strength
  sessions with overlapping muscle groups land on adjacent days anywhere in the schedule.
- Re-read the Preference Precedence constraint above before finalizing — for every exercise where
  a Recurring Session Request gave a specific number, confirm you used that exact number rather
  than a number implied by a general preference elsewhere.
- Re-read the Season Plan's Programming Methodology section before finalizing — confirm the week's
  structure actually reflects the chosen periodization approach, not a generic default.
- Re-read the Season Plan's Weekly Session Structure section before finalizing — for every major
  lift/movement pattern it names a frequency for, count how many sessions that lift/pattern
  actually appears in this week's schedule and confirm the count and combination match. If they
  don't match, fix the schedule, don't just proceed.
- Re-read the Strength Session Content constraint above before finalizing — confirm every
  `strength_sessions` entry is a `{{date, slot}}` pair only, with no invented exercises, and that the
  slot assigned respects Recovery Spacing (below) and the templates' known muscle-group content.
- Re-read the Frequency vs Load and Build the Stated Aerobic Base constraints above before
  finalizing — count how many days this week are Rest vs genuinely easy sessions; if the athlete's
  baseline is N and physiology/metrics gave no red flag, the week should have more than N sessions,
  with the extra days being easy training, not Rest.
- Re-read the Structured Running Sessions rule below before finalizing — for every running
  session, confirm its segments include warm-up, main effort, and cool-down (and drills/strides if
  applicable) as separate segments, not just the main effort. A session with only one segment for
  a non-trivial run is a sign a component was dropped — add it back before proceeding.
- Re-read the Strides Placement rule below before finalizing — confirm any strides segment is
  attached to an easy run, not a tempo/threshold or interval session.
"""

WEEKLY_PLANNER_CHECKIN_INSTRUCTIONS = """
## Check-In Mode
This is a weekly check-in, not a full replan. Follow this process:

1. **Assess** the past week using the Garmin activity data vs the season plan phase intent.
2. **Write `coach_feedback`** — always populate this field. 3-4 concise bullet points:
   - What the data shows (sessions completed, load, any gaps)
   - How it compares to the season plan's current phase
   - Anything to watch (fatigue, missed key sessions, upcoming constraints)
   - What (if anything) is being adjusted and why
3. **Decide on `schedule_updated`**:
   - If the athlete is on track and no changes are needed: set `schedule_updated = false`,
     leave `scheduled_days` empty, and write `output` as a brief summary only (no full plan).
   - If there is meaningful drift, the athlete note requests changes, or key sessions need
     restructuring: set `schedule_updated = true` and produce the full updated schedule.

If the athlete wrote a note under "Athlete Note", treat it as direct instruction — it may
warrant a schedule change, a priority shift, or just an acknowledgment in your feedback.
"""

WEEKLY_PLANNER_FINAL_CHECKLIST = """
## Final Checklist
- Follow the planning horizon and week grouping.
- Do not contradict expert constraints.
- Keep output compact and structured.

## Structured Strength Sessions (strength_sessions field)
When outputting the final markdown plan (not HITL questions), also populate the
`strength_sessions` field with one `{{date, slot}}` entry for every strength day in the schedule —
NOT exercises. See the Strength Session Content hard rule above: the athlete's saved templates
(below, read-only) are the only source of exercise content. Your job here is purely which of the
3 slots (A/B/C) goes on which date, applying Recovery Spacing and normal training-load judgment —
spread the 3 slots across the week rather than clustering, same as any other session-placement
decision.

## Structured Running Sessions (running_sessions field)
When outputting the final markdown plan, also populate the `running_sessions` field with one
`{{date, segments}}` entry for every "run" day in the schedule — this is the source of truth for
that day's run (used both to render its display description and to push a structured workout to
the athlete's watch), NOT the `description` field on that day's `scheduled_days` entry, which is
ignored and overwritten downstream for run days. Do not spend effort making description agree with
segments by hand.

Each segment needs:
- segment_type: "warmup", "interval", "recovery", "cooldown", or "steady" (a continuous
  non-interval effort, e.g. a plain easy run or tempo run with no repeats).
- zone: required on every segment except a bare jog-recovery with no target effort.
- EITHER duration_secs OR distance_meters, never both. Use duration_secs for warm-up/cool-down/
  jog-recovery (time you spend, not distance-anchored), distance_meters for interval reps
  (distance-anchored, e.g. 400m/800m/1km reps).
- pace_low/pace_high: see the Use Current Training Paces hard rule above — required whenever
  Current Training Paces has data for that zone, omitted otherwise.
- repeat_count: how many times this exact segment repeats, e.g. 6 for "6x400m". 1 for
  non-repeated segments (warm-up, cool-down, a single steady run).

A session MUST include every real component as its own segment — warm-up, the main effort
(interval/tempo/steady), cool-down, and any drills/strides — not just the main effort in
isolation, same requirement as before, just as segments instead of notation.
Wrong: a single "steady" segment for the whole session (warm-up/cool-down silently dropped).
Right: warmup segment (Z2, duration_secs) + interval segment (Z5, distance_meters, repeat_count=5,
pace_low/pace_high set) + recovery segment (jog, duration_secs, no pace) + cooldown segment (Z2,
duration_secs).
Strides placement (hard rule): if strides are part of the week, they belong as a trailing segment
on an EASY run's session, not a tempo/threshold or interval session. Legs are fresh after an easy
run, so the neuromuscular stimulus is high-quality with minimal added fatigue; tacking them onto a
tempo/interval session means running near-max-velocity strides on already-fatigued legs, which
blunts the stimulus and adds injury risk right when the athlete should be recovering.

## Day-by-Day Schedule (scheduled_days field)
When outputting the final markdown plan, populate `scheduled_days` with one entry per day covering
every date in the Upcoming Weeks list ({num_days} entries). In check-in mode, only populate this
if `schedule_updated` is true — leave it empty otherwise.

Rules:
- session_type: "run" for any running session, "strength" for gym work, "rest" for off/recovery
  days, "cross" for other cardio (bike, swim, hike), "race" for competitions.
- focus: 1-3 words that immediately convey what the session IS. Be specific — a reader should
  understand the session type at a glance without reading the description.
  Run focus examples (pick the most accurate):
    "Recovery Run", "Easy Aerobic", "Long Run", "Progression Run",
    "Tempo Run", "Threshold Run", "2k Tempo", "Cruise Intervals",
    "Short Intervals", "Track Intervals", "VO₂max Intervals", "Hill Reps",
    "Fartlek", "Race Pace", "Time Trial", "Strides"
  Strength focus: use the slot_name from the Strength Session Templates section below for
    whichever slot (A/B/C) you assigned this date — do not invent a different label, the focus
    text and the actual slot content should always match.
  Other: "Rest", "Active Recovery", "Cross-Train"
  Never use bare "Easy", "Moderate", "Hard", or "Run" alone.
- description: for session_type="run", leave this as a short placeholder (e.g. the focus text) —
  it is ignored and overwritten from the running_sessions segments for that date, see the
  Structured Running Sessions rule above. For "strength", use compact notation matching the
  slot's content (e.g. "Bench 5x5 @ 97.5kg + row 4x8"). Empty string for rest days.
- is_key_session: true for hard interval sessions, long runs >75min, and heavy strength days.
  Most easy aerobic runs should be is_key_session=false AND is_rest=false — this is a real,
  expected middle category, not an edge case. Marking every non-rest day as key indicates you are
  not building the easy aerobic base your methodology calls for.
- is_rest: true for complete rest and active recovery days.
"""


RUNNING_SESSION_CONTENT_RULES = """## Structured Running Session Content
For each date listed above, author its segments (warm-up, interval, recovery, cooldown, or
steady):
- segment_type: "warmup", "interval", "recovery", "cooldown", or "steady" (a continuous
  non-interval effort, e.g. a plain easy run or tempo run with no repeats).
- zone: required on every segment except a bare jog-recovery with no target effort.
- EITHER duration_secs OR distance_meters, never both. Use duration_secs for warm-up/cool-down/
  jog-recovery (time you spend, not distance-anchored), distance_meters for interval reps
  (distance-anchored, e.g. 400m/800m/1km reps).
- pace_low/pace_high: use the Current Training Paces given below for every pace you set — these
  are computed fresh from the athlete's actual recent fitness, not invented. Do NOT derive a pace
  from a longer-term goal time. If Current Training Paces has no data for a zone, set `zone` only
  and leave pace_low/pace_high null — never fall back to a goal-derived estimate.
- repeat_count: how many times this exact segment repeats, e.g. 6 for "6x400m". 1 for
  non-repeated segments (warm-up, cool-down, a single steady run).

A session MUST include every real component as its own segment — warm-up, the main effort,
cool-down, and any drills/strides — not just the main effort in isolation.
Strides placement (hard rule): if strides are part of the session, they belong as a trailing
segment on an EASY run, not a tempo/threshold or interval session.
"""

CHECKIN_TRANSLATION_PROMPT = """## Task
This is a weekly check-in against an existing, solver-managed schedule — NOT a full replan. You
are not deciding which dates get which sessions; a scheduling solver already enforces the
athlete's ProgramSpec (weekly volume targets, spacing rules, day preferences). Your job:

1. **Assess** the past week using the Garmin activity data vs the season plan's phase intent.
2. **Translate** the athlete's note (if any, under "Athlete Note" inside User Context below) or
   any detected drift into `overrides` — a short list of {{date, session_type_key}} instructions
   that FORCE a specific date to a specific session type (session_type_key must be one of the
   Active Program Spec keys listed below). Only propose an override where it's genuinely required
   (e.g. "I did Monday's strength a day late" -> pin today to that strength session type; "skip
   Thursday's tempo, feeling sick" -> pin Thursday to a rest/easy type). Most check-ins need zero
   overrides — do not invent one just to have something to say. A date you don't mention keeps
   whatever is already scheduled for it.
3. **Write `assessment`** — 3-4 concise bullet points: what the data shows, how it compares to the
   season plan's phase, anything to watch, what (if anything) you're adjusting and why.

## Inputs
### Season Plan
```markdown
{season_plan}
```
### Active Program Spec — valid session_type_keys
```json
{session_type_keys}
```
### Athlete Context
- Name: {athlete_name}
- Date: ```json {current_date} ```
- Upcoming Weeks: ```json {week_dates} ```
- **User Context**: ``` {planning_context} ```
- **Already scheduled this window** (context only — do not propose an override for a date unless
  you are deliberately changing it): ```json {existing_summary} ```

### Expert Analysis
- Metrics: ``` {metrics_analysis} ```
- Activity: ``` {activity_analysis} ```
- Physiology: ``` {physiology_analysis} ```
"""

CHECKIN_CONTENT_PROMPT = """## Task
The scheduling solver has placed the following running session(s) this window that need content
authored. You are NOT deciding placement, only content — see the rules below.

## Dates needing content
```json
{run_dates_json}
```
(each entry: date, time_slot, session_type_key, label. time_slot is null unless the athlete's
program allows more than one session a day, in which case a date may appear more than once with
different time_slot values — author each independently and echo the same time_slot back on your
output entry so it can be matched to the right one.)

## Current Training Paces (read-only)
```markdown
{training_paces}
```

{running_session_rules}
"""


def _check_recurring_requests_honored(
    scheduled_days: list[dict[str, Any]] | None,
    recurring_session_requests: list[dict[str, Any]] | None,
) -> list[str]:
    """Post-generation visibility check on the athlete's recurring pattern.

    Checks VOLUME per session type, not weekday placement. Weekday identity is a convenience,
    not a training variable — an athlete who does Tuesday's run on Wednesday has missed nothing,
    and flagging that as a violation is what previously forced the plan to re-pin to a fixed
    weekday grid and made drift impossible to absorb. What actually must hold is that the week
    still contains the requested sessions.

    A request may opt back into hard weekday placement with day_flexibility="fixed" (a class, a
    training partner, a standing commitment) — those are still checked by day.

    Surfaces warnings only; never triggers regeneration (same philosophy as the other checks —
    real risk of retry loops for uncertain benefit).
    """
    if not recurring_session_requests or not scheduled_days:
        return []

    weeks = max(1, round(len(scheduled_days) / 7))
    warnings: list[str] = []

    # ── Volume, per session type ──
    wanted: dict[str, int] = {}
    for req in recurring_session_requests:
        if req.get("importance") != "must":
            continue
        req_type = req.get("session_type")
        if not req_type or req_type == "other":
            continue
        wanted[req_type] = wanted.get(req_type, 0) + 1

    got: dict[str, int] = {}
    for day in scheduled_days:
        if day.get("is_rest"):
            continue
        st = day.get("session_type")
        if st and st != "rest":
            got[st] = got.get(st, 0) + 1

    for req_type, per_week in wanted.items():
        expected = per_week * weeks
        actual = got.get(req_type, 0)
        # Tolerate one short across the whole window — a taper or deload week legitimately
        # trims a session, and this check shouldn't fight real coaching decisions.
        if actual < expected - 1:
            warnings.append(
                f"⚠️ Planned only {actual} {req_type} session(s) over {weeks} week(s); the athlete's "
                f"recurring pattern asks for about {expected}. Verify this was intentional."
            )

    # ── Hard weekday pins only ──
    for req in recurring_session_requests:
        if req.get("importance") != "must" or req.get("day_flexibility") != "fixed":
            continue
        day_of_week = req.get("day_of_week")
        if not day_of_week:
            continue
        req_type = req.get("session_type")
        label = req.get("label") or req_type or "session"
        matched = any(
            str(day.get("day_name") or "").lower() == day_of_week.lower()
            and (not req_type or req_type == "other" or day.get("session_type") == req_type)
            for day in scheduled_days
        )
        if not matched:
            warnings.append(
                f"⚠️ '{label}' is pinned to {day_of_week.capitalize()} (day_flexibility=fixed) but "
                "no matching session was scheduled on that day — please verify."
            )


    return warnings


# Real per-muscle-group tags (chest/back/delts/biceps/triceps/legs/calves/core), shared with
# spec_bootstrap.py's deterministic SpacingConstraint generation — see muscle_groups.py.
_slot_muscle_groups = slot_muscle_groups


def _check_strength_recovery_spacing(
    scheduled_days: list[dict[str, Any]] | None,
    strength_sessions: list[dict[str, Any]] | None,
    templates: list[dict[str, Any]] | None,
) -> list[str]:
    """Post-generation visibility check: flag adjacent-day strength sessions whose assigned slots
    share a muscle-group bucket (e.g. two slots that both include legs, scheduled back-to-back).
    Same philosophy as the recurring-request check — surface it in coach_feedback, don't
    retry-loop.
    """
    if not scheduled_days or not strength_sessions or not templates:
        return []

    slot_groups = _slot_muscle_groups(templates)
    slot_by_date = {s.get("date"): s.get("slot") for s in strength_sessions if s.get("date")}
    strength_dates: list[str] = sorted(
        d["date"] for d in scheduled_days if d.get("session_type") == "strength" and d.get("date")
    )

    warnings: list[str] = []
    for prev_date, next_date in itertools.pairwise(strength_dates):
        try:
            gap_days = (date.fromisoformat(next_date) - date.fromisoformat(prev_date)).days
        except ValueError:
            continue
        if gap_days != 1:
            continue

        prev_slot = slot_by_date.get(prev_date)
        next_slot = slot_by_date.get(next_date)
        if not prev_slot or not next_slot:
            continue

        overlap = slot_groups.get(prev_slot, set()) & slot_groups.get(next_slot, set())
        if overlap:
            warnings.append(
                f"⚠️ Slot {prev_slot} ({prev_date}) and Slot {next_slot} ({next_date}) both train "
                f"{'/'.join(sorted(overlap))}-body muscle groups on back-to-back days with no rest "
                "between — please verify recovery spacing."
            )

    return warnings


_ROTATION = ["A", "B", "C"]



_INSERTED_SESSION_LABELS = {
    "en": {
        "strength_focus": "Strength",
        "strength_description": "Strength session (from saved template)",
        "easy_focus": "Easy Aerobic",
        "easy_description": "45min Z2 easy aerobic",
    },
    "no": {
        "strength_focus": "Styrke",
        "strength_description": "Styrkeøkt (fra lagret mal)",
        "easy_focus": "Rolig aerob",
        "easy_description": "45 min Z2 rolig aerob",
    },
}

_CHECKIN_FALLBACK_WARNING = {
    "en": (
        "⚠️ Could not honor the requested schedule change(s) without breaking the athlete's "
        "program rules ({reasons}) — kept the existing schedule instead."
    ),
    "no": (
        "⚠️ Kunne ikke etterkomme den ønskede planendringen uten å bryte utøverens "
        "programregler ({reasons}) — beholdt den eksisterende planen i stedet."
    ),
}


def _fix_weekly_volume(
    scheduled_days: list[dict[str, Any]] | None,
    strength_sessions: list[dict[str, Any]] | None,
    running_sessions: list[dict[str, Any]] | None,
    recurring_session_requests: list[dict[str, Any]] | None,
    language: str = "en",
) -> list[str]:
    """Enforce the athlete's weekly session volume by inserting what the planner left out.

    Session count per week is mechanically checkable AND mechanically fixable, which by this
    codebase's own standard means it shouldn't depend on the LLM getting it right — the same
    reasoning that moved slot rotation, legs-before-hard-runs and running descriptions into
    Python. Three real check-ins under-scheduled strength (2/week against a 3/week pattern),
    each time filling the gap with rest days, and prompt fixes alone did not hold.

    Converts REST days into the missing session type — never overwrites real training, so this
    can only add work the athlete already committed to, never displace something the coach
    deliberately placed. Strength insertions take the next rotation slot (the real slot letter
    is recomputed downstream by expand_strength_session_slots anyway) and skip days adjacent to
    another strength session so Recovery Spacing isn't violated on the way in. Runs are inserted
    as plain easy aerobic volume — the lowest-risk thing to add and, per Frequency vs Load, the
    kind of session that adds frequency at minimal load cost.

    Only complete weeks are enforced; a partial week at either end of the window would otherwise
    look short simply because it's truncated. Returns warnings for anything it couldn't place.
    """
    if not scheduled_days or not recurring_session_requests:
        return []

    required: dict[str, int] = {}
    preferred_days: dict[str, list[str]] = {}
    for req in recurring_session_requests:
        if req.get("importance") == "must" and req.get("session_type"):
            st = req["session_type"]
            required[st] = required.get(st, 0) + 1
            if req.get("day_of_week"):
                preferred_days.setdefault(st, []).append(req["day_of_week"].lower())
    if not required:
        return []

    by_date = {d["date"]: d for d in scheduled_days if d.get("date")}
    strength_sessions = strength_sessions if strength_sessions is not None else []
    running_sessions = running_sessions if running_sessions is not None else []
    warnings: list[str] = []

    weeks: dict[str, list[str]] = {}
    for iso in sorted(by_date):
        d = date.fromisoformat(iso)
        weeks.setdefault((d - timedelta(days=d.weekday())).isoformat(), []).append(iso)

    def is_strength(iso: str) -> bool:
        day = by_date.get(iso)
        return bool(day and day.get("session_type") == "strength" and not day.get("is_rest"))

    for week_start, dates in sorted(weeks.items()):
        if len(dates) < 7:
            continue  # truncated week — not a real shortfall

        counts: dict[str, int] = {}
        for iso in dates:
            day = by_date[iso]
            if not day.get("is_rest") and day.get("session_type") not in (None, "rest"):
                counts[day["session_type"]] = counts.get(day["session_type"], 0) + 1

        for session_type, needed in required.items():
            missing = needed - counts.get(session_type, 0)

            # Before inserting anything: if this type is short AND the athlete has preferred days
            # for it, snap the existing sessions onto that grid first. A week where the planner
            # put strength on Tue+Thu has NO legal slot left — Mon, Wed and Fri are each adjacent
            # to one of them — so no amount of slot-hunting can fix it. Relocating Tue->Mon and
            # Thu->Wed frees Friday legally. The athlete's own pattern is spacing-valid by
            # construction, which is exactly why it's the right thing to fall back to.
            if missing > 0 and preferred_days.get(session_type):
                wanted = [
                    iso for iso in dates
                    if date.fromisoformat(iso).strftime("%A").lower() in preferred_days[session_type]
                ][:needed]
                for target in wanted:
                    tgt = by_date[target]
                    if tgt.get("session_type") == session_type and not tgt.get("is_rest"):
                        continue
                    if tgt.get("is_key_session"):
                        continue  # never displace a key session
                    donor = next(
                        (iso for iso in dates
                         if iso not in wanted
                         and by_date[iso].get("session_type") == session_type
                         and not by_date[iso].get("is_rest")),
                        None,
                    )
                    if donor is None:
                        continue
                    a, b = by_date[target], by_date[donor]
                    keys = ("session_type", "focus", "description", "is_rest", "is_key_session")
                    swapped = {k: b.get(k) for k in keys}
                    for k in keys:
                        b[k] = a.get(k)
                    a.update(swapped)
                    for coll in (running_sessions, strength_sessions):
                        for entry in coll:
                            if entry.get("date") == donor:
                                entry["date"] = target
                            elif entry.get("date") == target:
                                entry["date"] = donor
                    logger.info(
                        "Auto-corrected weekly volume: relocated %s session %s -> %s to restore the "
                        "athlete's preferred pattern", session_type, donor, target,
                    )

            while missing > 0:
                def is_free(iso: str) -> bool:
                    day = by_date[iso]
                    return bool(day.get("is_rest") or day.get("session_type") in (None, "rest"))

                def spacing_ok(iso: str, session_type: str = session_type) -> bool:
                    if session_type != "strength":
                        return True
                    d = date.fromisoformat(iso)
                    return not any(
                        is_strength(n) for n in
                        ((d - timedelta(days=1)).isoformat(), (d + timedelta(days=1)).isoformat())
                    )

                wanted_dows = preferred_days.get(session_type, [])
                on_preferred = [
                    iso for iso in dates
                    if date.fromisoformat(iso).strftime("%A").lower() in wanted_dows
                ]

                # 1) a free day that is already one of the athlete's preferred days for this type
                slot_iso = next((iso for iso in on_preferred if is_free(iso) and spacing_ok(iso)), None)
                # 2) any other free day that doesn't breach spacing
                if slot_iso is None:
                    slot_iso = next((iso for iso in dates if is_free(iso) and spacing_ok(iso)), None)
                # 3) The week drifted into a shape with no legal room — e.g. strength landed on
                #    Tue/Thu, leaving both rest days adjacent to it. Reclaim a preferred day by
                #    displacing whatever non-key session sits there onto a free day. The athlete's
                #    own pattern is spacing-valid by construction, so snapping back to it is the
                #    safest correction available, and it never touches a key session.
                if slot_iso is None:
                    for iso in on_preferred:
                        day = by_date[iso]
                        if is_free(iso) or day.get("is_key_session") or day.get("session_type") == session_type:
                            continue
                        dest = next((o for o in dates if is_free(o) and o != iso), None)
                        if dest is None or not spacing_ok(iso):
                            continue
                        by_date[dest].update({
                            "session_type": day.get("session_type"), "focus": day.get("focus"),
                            "description": day.get("description"), "is_rest": False,
                            "is_key_session": False,
                        })
                        for coll in (running_sessions, strength_sessions):
                            for entry in coll:
                                if entry.get("date") == iso:
                                    entry["date"] = dest
                        logger.info(
                            "Auto-corrected weekly volume: displaced %s from %s to %s to reclaim a "
                            "preferred %s day", day.get("focus"), iso, dest, session_type,
                        )
                        slot_iso = iso
                        break

                if slot_iso is None:
                    warnings.append(
                        f"⚠️ Week of {week_start} is {missing} {session_type} session(s) short of "
                        "the athlete's weekly pattern and no rest day was free to place them — "
                        "please verify."
                    )
                    break

                labels = _INSERTED_SESSION_LABELS.get(language, _INSERTED_SESSION_LABELS["en"])
                day = by_date[slot_iso]
                day["is_rest"] = False
                day["session_type"] = session_type
                if session_type == "strength":
                    day["focus"] = labels["strength_focus"]
                    day["description"] = labels["strength_description"]
                    strength_sessions.append({"date": slot_iso, "slot": "A"})
                else:
                    day["focus"] = labels["easy_focus"]
                    day["description"] = labels["easy_description"]
                    running_sessions.append({
                        "date": slot_iso,
                        "segments": [{
                            "segment_type": "steady", "zone": "Z2",
                            "duration_secs": 2700, "distance_meters": None,
                            "pace_low": None, "pace_high": None,
                            "repeat_count": 1, "note": None,
                        }],
                    })
                day["is_key_session"] = False
                logger.info(
                    "Auto-corrected weekly volume: inserted a %s session on %s (week of %s was short)",
                    session_type, slot_iso, week_start,
                )
                missing -= 1

    scheduled_days[:] = list(by_date.values())
    return warnings


def _fix_legs_before_hard_runs(
    scheduled_days: list[dict[str, Any]] | None,
    strength_sessions: list[dict[str, Any]] | None,
    templates: list[dict[str, Any]] | None,
) -> list[str]:
    """Auto-corrects Legs Before Hard Runs violations instead of just warning about them — the
    prompt rule (with a Wrong/Right example) proved unreliable in practice: it stopped one specific
    violation pattern (legs -> VO2max) but the LLM just produced the same underlying mistake against
    a different key run type (legs -> tempo) on the very next real Check-In. Same lesson as the
    Strength Session Order rotation: don't trust the LLM for a mechanically-checkable spacing rule,
    verify and fix it deterministically instead.

    Recomputes the *authoritative* slot per date the same way expand_strength_session_slots() will
    later (continuing the rotation from get_next_strength_slot(), by chronological order) rather
    than trusting the LLM's own `slot` field — that field can drift from what's actually delivered
    (see the focus-label mismatch bug fixed the same day), so leg-detection here must match reality,
    not the LLM's guess.

    For each violation, tries moving the leg-carrying strength session up to 3 days either direction
    onto a rest/easy day (closest shift first), provided the new date (a) still keeps 24h before
    every key run and (b) doesn't land within 1 day of any OTHER strength session whose slot shares
    a muscle-group bucket with this one — not just other leg sessions, since e.g. moving a
    leg+triceps+biceps slot next to an upper-only slot still violates Recovery Spacing on the
    shared upper-body work even though neither slot's legs are involved (this exact gap caused a
    real Recovery Spacing regression the first time this function ran for real — fixed by checking
    against every other strength date's bucket overlap, matching _check_strength_recovery_spacing's
    own logic, not just other leg dates). Swaps the full day content (not the `date` field) between
    the two days, and moves the matching entry in `strength_sessions`. Mutates both lists in place.
    Returns a warning for any violation it couldn't safely resolve within that window — visibility
    fallback, same philosophy as the other post-generation checks.

    NOTE (found investigating a real batch of 6 identical warnings, see MEMORY.md /
    project_leg_spacing_structural_limit): swapping *which slot* lands on which day-of-week
    (rather than relocating a session's date) was tried here and reverted — it doesn't survive
    expand_strength_session_slots() in services/supabase/plan_writer.py, which deliberately
    discards whatever `slot` this function assigns and re-derives every slot from strict
    chronological rotation continuation (by design, to block LLM slot-hallucination). Only a real
    date change (this function's actual mechanism) sticks. For this athlete's current template —
    3 strength sessions/week (Mon/Wed/Fri) where every slot includes some upper-body work by design
    ("bench every session"), plus fixed weekly key-run days — every non-strength day sits within 1
    day of *some* strength session, so the Recovery Spacing check below blocks every candidate
    keyed on "any shared bucket." That's a structural property of the current template, not a bug
    in this search: see the memory note for the tradeoffs (narrower bucket-check vs. moving strength
    off Wed/Fri vs. accepting the warning) — do not "fix" this again without re-reading it first.

    UPDATE (2026-08-26): the leg-spacing threshold moved from 48h to 24h after a research pass
    found no primary source validating 48h specifically (see spec_bootstrap.py's
    build_deterministic_leg_spacing_constraint docstring). Given this module's day-granularity
    approximation (gap = calendar-day-difference * 24), a 24h floor means only a leg session and a
    key run on the *same calendar day* violate it — the day-of-week structural conflict described
    above (every non-strength day sitting within 1 day of some strength session) no longer applies,
    since a 1-day gap now satisfies the rule. This function still runs for the non-check-in
    full-redraft path, but should rarely find anything to fix in practice now.
    """
    if not scheduled_days or not strength_sessions or not templates:
        return []

    slot_groups = _slot_muscle_groups(templates)
    days_by_date = {d["date"]: d for d in scheduled_days if d.get("date")}
    strength_by_date = {s["date"]: s for s in strength_sessions if s.get("date")}

    def is_leg_slot(slot: str | None) -> bool:
        return bool(slot and "legs" in slot_groups.get(slot, set()))

    sorted_strength_dates = sorted(strength_by_date.keys())
    true_slot_by_date: dict[str, str] = {}
    next_slot = get_next_strength_slot()
    for d in sorted_strength_dates:
        true_slot_by_date[d] = next_slot
        next_slot = _ROTATION[(_ROTATION.index(next_slot) + 1) % 3]

    key_run_dates = {
        d for d, day in days_by_date.items()
        if day.get("session_type") == "run" and day.get("is_key_session")
    }

    def violates_any_key_run(check_date_str: str) -> str | None:
        # 24h floor, day-granularity approximation (gap = day_diff * 24) — only the exact same
        # calendar day violates it now (see the 2026-08-26 UPDATE note above).
        check_d = date.fromisoformat(check_date_str)
        for run_date in key_run_dates:
            gap_days = (date.fromisoformat(run_date) - check_d).days
            if gap_days == 0:
                return run_date
        return None

    leg_dates = sorted(d for d, slot in true_slot_by_date.items() if is_leg_slot(slot))
    warnings: list[str] = []

    for leg_date in leg_dates:
        conflicting_run = violates_any_key_run(leg_date)
        if not conflicting_run:
            continue

        leg_d = date.fromisoformat(leg_date)
        moving_buckets = slot_groups.get(true_slot_by_date[leg_date], set())
        other_strength_dates = [d for d in true_slot_by_date if d != leg_date]
        # Closest shift first, alternating direction — a smaller disruption to the rest of the
        # week is preferred over a larger one when multiple candidates would work.
        shifts = sorted(range(-3, 4), key=lambda n: (abs(n), n))
        moved = False
        for shift in shifts:
            if shift == 0:
                continue
            candidate = (leg_d + timedelta(days=shift)).isoformat()
            candidate_day = days_by_date.get(candidate)
            if not candidate_day:
                continue
            if candidate_day.get("session_type") not in ("run", "rest", "cross") or candidate_day.get("is_key_session"):
                continue  # only swap onto a rest or genuinely-easy day
            if violates_any_key_run(candidate):
                continue  # would just relocate the same problem
            if any(
                abs((date.fromisoformat(d) - date.fromisoformat(candidate)).days) < 2
                and moving_buckets & slot_groups.get(true_slot_by_date[d], set())
                for d in other_strength_dates
            ):
                continue  # would violate Recovery Spacing against another strength session

            days_by_date[leg_date], days_by_date[candidate] = (
                {**days_by_date[candidate], "date": leg_date},
                {**days_by_date[leg_date], "date": candidate},
            )
            strength_by_date[candidate] = {**strength_by_date.pop(leg_date), "date": candidate}
            logger.info(
                "Auto-corrected Legs Before Hard Runs: moved leg-carrying strength session from "
                "%s to %s (was same-day as key run on %s)",
                leg_date, candidate, conflicting_run,
            )
            moved = True
            break

        if not moved:
            warnings.append(
                f"⚠️ Leg-carrying strength session on {leg_date} is scheduled the same day as the "
                f"key run on {conflicting_run} (needs 24h), and no safe day within 3 days either "
                "direction was available to auto-correct — please verify manually."
            )

    scheduled_days[:] = list(days_by_date.values())
    strength_sessions[:] = list(strength_by_date.values())
    return warnings


async def _execute_full_redraft(
    state: TrainingAnalysisState,
    supabase_user_id: str,
    agent_start_time: datetime,
) -> dict[str, Any]:
    """The original weekly-planner behavior: the LLM redrafts the entire multi-week schedule.

    Structure is patched by the hand-written _fix_* functions below. Still
    used for non-check-in (full pipeline) runs, which have no active
    ProgramSpec-driven alternative yet — see _execute_checkin for the
    solver-driven check-in path.
    """
    hitl_enabled = state.get("hitl_enabled", True)
    logger.info("Weekly planner node: HITL %s", "enabled" if hitl_enabled else "disabled")

    tools = configure_node_tools(
        agent_name="weekly_planner",
        plot_storage=None,
        plotting_enabled=False,
    )

    num_days = len(state.get("week_dates") or []) or 28
    checkin_mode = state.get("checkin_mode", False)

    strength_template_rows = get_strength_session_templates(supabase_user_id)
    strength_templates = build_strength_templates_context(supabase_user_id)
    next_strength_slot = get_next_strength_slot()
    training_paces = build_training_paces_context(state.get("garmin_data") or {})

    system_prompt = (
        get_workflow_context("weekly_planner")
        + WEEKLY_PLANNER_SYSTEM_PROMPT
        + (WEEKLY_PLANNER_CHECKIN_INSTRUCTIONS if checkin_mode else "")
        + (get_hitl_instructions("weekly_planner") if hitl_enabled else "")
        + WEEKLY_PLANNER_FINAL_CHECKLIST.format(num_days=num_days)
        + get_language_instructions(state.get("language"))
    )

    qa_messages = normalize_langchain_messages(state.get("weekly_planner_messages", []))
    user_message = {
        "role": "user",
        "content": WEEKLY_PLANNER_USER_PROMPT.format(
            num_days=num_days,
            season_plan=extract_agent_content(state.get("season_plan")),
            athlete_name=state["athlete_name"],
            current_date=json.dumps(state["current_date"], indent=2),
            week_dates=json.dumps(state["week_dates"], indent=2),
            competitions=json.dumps(state["competitions"], indent=2),
            planning_context=state["planning_context"],
            strength_templates=strength_templates,
            next_strength_slot=next_strength_slot,
            training_paces=training_paces,
            metrics_analysis=_safe_expert(state.get("metrics_outputs"), "for_weekly_planner"),
            activity_analysis=_safe_expert(state.get("activity_outputs"), "for_weekly_planner"),
            physiology_analysis=_safe_expert(state.get("physiology_outputs"), "for_weekly_planner"),
        ),
    }
    base_messages = [{"role": "system", "content": system_prompt}, user_message]

    base_llm = ModelSelector.get_llm(AgentRole.WEEKLY_PLANNER)
    llm_with_tools = base_llm.bind_tools(tools) if tools else base_llm
    llm_with_structure = llm_with_tools.with_structured_output(WeeklyPlanOutput)

    async def call_weekly_planning():
        messages_with_qa = base_messages + qa_messages
        if tools:
            return await handle_tool_calling_in_node(
                llm_with_tools=llm_with_structure,
                messages=messages_with_qa,
                tools=tools,
                max_iterations=15,
            )
        return await llm_with_structure.ainvoke(messages_with_qa)

    agent_output: WeeklyPlanOutput = await retry_with_backoff(
        call_weekly_planning, AI_ANALYSIS_CONFIG, "Weekly Planning"
    )

    execution_time = (datetime.now() - agent_start_time).total_seconds()
    log_node_completion("Weekly planning", execution_time)

    strength_sessions = None
    if agent_output.strength_sessions:
        strength_sessions = [s.model_dump() for s in agent_output.strength_sessions]
        logger.info("Weekly planner produced %d strength session(s)", len(strength_sessions))

    scheduled_days = None
    if agent_output.scheduled_days:
        scheduled_days = [d.model_dump() for d in agent_output.scheduled_days]
        logger.info("Weekly planner produced %d scheduled day(s)", len(scheduled_days))

    running_sessions = None
    if agent_output.running_sessions:
        running_sessions = [r.model_dump() for r in agent_output.running_sessions]
        logger.info("Weekly planner produced %d running session(s)", len(running_sessions))

    coach_feedback = agent_output.coach_feedback
    # Run the auto-correcting fix first — it mutates scheduled_days/strength_sessions in
    # place, so the checks below see the corrected dates, not the LLM's raw (possibly
    # violating) ones.
    # Volume first: it inserts sessions, and the legs/spacing fix below must then see
    # (and be able to correct) the inserted placements, not the pre-insert schedule.
    volume_warnings = _fix_weekly_volume(
        scheduled_days, strength_sessions, running_sessions,
        state.get("recurring_session_requests"),
        language=state.get("language", "en"),
    )
    legs_warnings = _fix_legs_before_hard_runs(scheduled_days, strength_sessions, strength_template_rows)
    recurring_warnings = _check_recurring_requests_honored(
        scheduled_days, state.get("recurring_session_requests")
    )
    spacing_warnings = _check_strength_recovery_spacing(scheduled_days, strength_sessions, strength_template_rows)
    all_warnings = volume_warnings + recurring_warnings + spacing_warnings + legs_warnings
    if all_warnings:
        logger.warning(
            "Post-generation checks: %d recurring-request miss(es), %d recovery-spacing issue(s), "
            "%d legs-before-hard-run issue(s)",
            len(recurring_warnings), len(spacing_warnings), len(legs_warnings),
        )
        warning_text = "\n".join(all_warnings)
        coach_feedback = f"{coach_feedback.rstrip()}\n\n{warning_text}" if coach_feedback else warning_text

    if coach_feedback:
        logger.info("Coach feedback: %s", coach_feedback[:120])
    logger.info("Schedule updated: %s", agent_output.schedule_updated)

    return {
        "weekly_plan": agent_output.model_dump(),
        "strength_sessions": strength_sessions,
        "scheduled_days": scheduled_days,
        "running_sessions": running_sessions,
        "coach_feedback": coach_feedback,
        "schedule_updated": agent_output.schedule_updated,
        "timings": [create_timing_entry("weekly_planner", execution_time)],
    }


async def _execute_checkin(
    state: TrainingAnalysisState,
    supabase_user_id: str,
    agent_start_time: datetime,
) -> dict[str, Any]:
    """Solver-driven check-in path (Phase 4): solve_schedule() decides placement, not the LLM.

    The LLM only translates the athlete's note into overrides the solver must
    honor, then authors content for whatever run dates the solver actually
    placed fresh.
    """
    active_spec = get_active_program_spec(supabase_user_id)
    if active_spec is None:
        raise ValueError(
            "No active program_specs row for this athlete — run a full season-planning pass "
            "first (New Season) before checking in."
        )

    window_dates = [date.fromisoformat(d["date"]) for d in state["week_dates"]]
    today = date.today()

    today_row, today_strength_row, existing = fetch_checkin_context(supabase_user_id, window_dates)
    today_pin = resolve_today_pin(today, today_row, today_strength_row, active_spec)

    valid_keys = [st.key for st in active_spec.session_types]
    existing_summary = {
        d.isoformat(): row.get("session_type") for (d, _time_slot), row in sorted(existing.items())
    }

    base_llm = ModelSelector.get_llm(AgentRole.WEEKLY_PLANNER)
    qa_messages = normalize_langchain_messages(state.get("weekly_planner_messages", []))
    translation_messages = [
        {"role": "system", "content": (
            get_workflow_context("weekly_planner")
            + WEEKLY_PLANNER_SYSTEM_PROMPT
            + get_language_instructions(state.get("language"))
        )},
        {"role": "user", "content": CHECKIN_TRANSLATION_PROMPT.format(
            season_plan=extract_agent_content(state.get("season_plan")),
            session_type_keys=json.dumps(valid_keys, indent=2),
            athlete_name=state["athlete_name"],
            current_date=json.dumps(state["current_date"], indent=2),
            week_dates=json.dumps(state["week_dates"], indent=2),
            planning_context=state["planning_context"],
            existing_summary=json.dumps(existing_summary, indent=2),
            metrics_analysis=_safe_expert(state.get("metrics_outputs"), "for_weekly_planner"),
            activity_analysis=_safe_expert(state.get("activity_outputs"), "for_weekly_planner"),
            physiology_analysis=_safe_expert(state.get("physiology_outputs"), "for_weekly_planner"),
        )},
        *qa_messages,
    ]
    translation_llm = base_llm.with_structured_output(CheckinTranslationOutput)

    # Bounded corrective retry (narrower than season_planner_node's 3-attempt budget — this is
    # only validating that override keys are real, not re-authoring a whole spec) for an
    # override referencing an unknown session_type_key.
    translation_output: CheckinTranslationOutput | None = None
    feedback: str | None = None
    overrides: dict[date, str] = {}
    for _attempt in range(2):
        messages = (
            translation_messages if not feedback
            else [*translation_messages, {"role": "user", "content": feedback}]
        )

        async def call_translation(messages: list = messages) -> CheckinTranslationOutput:
            return await translation_llm.ainvoke(messages)

        translation_output = await retry_with_backoff(
            call_translation, AI_ANALYSIS_CONFIG, "Check-in Translation"
        )
        bad = [o for o in translation_output.translation.overrides if o.session_type_key not in valid_keys]
        if not bad:
            overrides = {
                date.fromisoformat(o.date): o.session_type_key
                for o in translation_output.translation.overrides
            }
            break
        feedback = (
            f"These overrides referenced unknown session_type_key values: "
            f"{[o.session_type_key for o in bad]}. Valid keys are: {valid_keys}. Revise."
        )
    else:
        # Exhausted retries with bad keys — drop the invalid ones rather than fail the whole
        # check-in over a translation mistake; still solve with whatever's valid.
        assert translation_output is not None  # set on every loop iteration above
        overrides = {
            date.fromisoformat(o.date): o.session_type_key
            for o in translation_output.translation.overrides
            if o.session_type_key in valid_keys
        }
        logger.warning("Check-in translation kept referencing unknown session_type_keys — dropped them")

    assert translation_output is not None  # set on every loop iteration or the else branch above
    assessment = translation_output.translation.assessment

    fixed, fixed_slots = compute_checkin_fixed_days(window_dates, existing, overrides, active_spec)
    fixed.update(today_pin)
    result = solve_schedule(active_spec, window_dates, pinned_events=fixed, pinned_slot_events=fixed_slots)

    fallback_warning = None
    if not result.feasible:
        logger.warning("Check-in solve infeasible with overrides %s: %s", overrides, result.infeasible_reasons)
        fixed_without_overrides, fixed_slots_without_overrides = compute_checkin_fixed_days(
            window_dates, existing, {}, active_spec
        )
        fixed_without_overrides.update(today_pin)
        result = solve_schedule(
            active_spec, window_dates,
            pinned_events=fixed_without_overrides, pinned_slot_events=fixed_slots_without_overrides,
        )
        if not result.feasible:
            raise ValueError(
                "The athlete's active program is infeasible independent of this check-in "
                f"({result.infeasible_reasons}) — run a new season-planning pass."
            )
        template = _CHECKIN_FALLBACK_WARNING.get(state.get("language") or "en", _CHECKIN_FALLBACK_WARNING["en"])
        fallback_warning = template.format(reasons="; ".join(result.infeasible_reasons or []))
        overrides = {}
        fixed = fixed_without_overrides
        fixed_slots = fixed_slots_without_overrides

    # Normalize both solver modes into one (date, time_slot) -> key shape so the rest of this
    # function only has to handle one shape. Single-session mode's plain dict[date, str] becomes
    # every entry at the 'day' slot — exactly how solve_schedule's own whole-day pins already
    # surface in slot_assignments under multi-session mode (a fixed date gets one synthetic
    # (date, "day") cell, never 4 real slots), so a whole-day-fixed date behaves identically
    # either way below.
    if active_spec.allow_multi_session_days:
        cell_assignments: dict[tuple[date, str], str] = dict(result.slot_assignments or {})
    else:
        cell_assignments = {(d, "day"): key for d, key in (result.assignments or {}).items()}

    def _slot_sort_key(slot: str) -> int:
        return SLOTS.index(slot) if slot in SLOTS else -1  # "day" sorts first, there's only one

    # Content is only needed for cells the solver actually decided (not carried forward
    # unchanged from `fixed`) that turned out to be run-kind — everything else either isn't a
    # run or already has real content written to Supabase from a prior check-in.
    content_needed = [
        cell for cell, key in cell_assignments.items()
        if key and key != FREE
        and cell[0] not in fixed and cell not in fixed_slots
        and active_spec.session_type(key).session_kind == "run"
    ]
    content_needed.sort(key=lambda cell: (cell[0], _slot_sort_key(cell[1])))

    running_content_by_cell: dict[tuple[date, str], list[dict]] = {}
    if content_needed:
        content_targets = [
            {
                "date": cell[0].isoformat(),
                "time_slot": cell[1] if cell[1] != "day" else None,
                "session_type_key": cell_assignments[cell],
                "label": active_spec.session_type(cell_assignments[cell]).label,
            }
            for cell in content_needed
        ]
        content_messages = [
            {"role": "system", "content": (
                WEEKLY_PLANNER_SYSTEM_PROMPT + get_language_instructions(state.get("language"))
            )},
            {"role": "user", "content": CHECKIN_CONTENT_PROMPT.format(
                run_dates_json=json.dumps(content_targets, indent=2),
                training_paces=build_training_paces_context(state.get("garmin_data") or {}),
                running_session_rules=RUNNING_SESSION_CONTENT_RULES,
            )},
        ]
        content_llm = base_llm.with_structured_output(CheckinContentOutput)
        content_output: CheckinContentOutput = await retry_with_backoff(
            lambda: content_llm.ainvoke(content_messages), AI_ANALYSIS_CONFIG, "Check-in Content"
        )
        for entry in content_output.running_content:
            try:
                entry_date = date.fromisoformat(entry.date)
            except ValueError:
                continue
            running_content_by_cell[(entry_date, entry.time_slot or "day")] = [
                s.model_dump() for s in entry.segments
            ]

    # Reconstruct scheduled_days/strength_sessions/running_sessions for the whole window from
    # the solver's assignments + spec metadata — write_plan() replaces the full overlapping
    # date range, so this must be complete, not a diff. Under single-session mode (the default)
    # every date contributes at most one cell here, so this is byte-identical to the old
    # date-keyed loop; under multi-session mode a date can contribute several.
    scheduled_days: list[dict] = []
    strength_sessions: list[dict] = []
    running_sessions: list[dict] = []
    for d in window_dates:
        day_name = d.strftime("%A")
        day_cells = sorted(
            (cell for cell in cell_assignments if cell[0] == d),
            key=lambda cell: _slot_sort_key(cell[1]),
        )
        active_cells = [c for c in day_cells if cell_assignments[c] and cell_assignments[c] != FREE]

        if not active_cells:
            scheduled_days.append({
                "date": d.isoformat(), "day_name": day_name, "session_type": "rest",
                "focus": "Rest", "description": "", "is_key_session": False, "is_rest": True,
                "time_slot": "day",
            })
            continue

        for cell in active_cells:
            key = cell_assignments[cell]
            row_slot = cell[1]
            st = active_spec.session_type(key)
            if st.session_kind == "strength":
                template_slot = key.rsplit("-", 1)[-1].upper()
                strength_sessions.append({"date": d.isoformat(), "slot": template_slot, "time_slot": row_slot})
                scheduled_days.append({
                    "date": d.isoformat(), "day_name": day_name, "session_type": "strength",
                    "focus": st.label, "description": "Strength session (from saved template)",
                    "is_key_session": st.is_key, "is_rest": False, "time_slot": row_slot,
                })
            elif st.session_kind == "run":
                existing_row = existing.get((d, row_slot))
                segments = running_content_by_cell.get(cell)
                if segments is None and existing_row and existing_row.get("running_segments"):
                    segments = existing_row["running_segments"]
                if segments is None:
                    # Missing content degrades to a plain easy-aerobic placeholder, not a hard
                    # failure — mirrors _fix_weekly_volume's old insertion fallback.
                    segments = [{
                        "segment_type": "steady", "zone": "Z2", "duration_secs": 2700,
                        "distance_meters": None, "pace_low": None, "pace_high": None,
                        "repeat_count": 1, "note": None,
                    }]
                running_sessions.append({"date": d.isoformat(), "segments": segments, "time_slot": row_slot})
                scheduled_days.append({
                    "date": d.isoformat(), "day_name": day_name, "session_type": "run",
                    "focus": st.label, "description": st.label,
                    "is_key_session": st.is_key, "is_rest": False, "time_slot": row_slot,
                })
            elif st.session_kind == "rest":
                scheduled_days.append({
                    "date": d.isoformat(), "day_name": day_name, "session_type": "rest",
                    "focus": "Rest", "description": "", "is_key_session": False, "is_rest": True,
                    "time_slot": row_slot,
                })
            else:
                scheduled_days.append({
                    "date": d.isoformat(), "day_name": day_name, "session_type": "cross",
                    "focus": st.label, "description": st.label,
                    "is_key_session": st.is_key, "is_rest": False, "time_slot": row_slot,
                })

    coach_feedback = assessment
    if fallback_warning:
        coach_feedback = f"{coach_feedback.rstrip()}\n\n{fallback_warning}" if coach_feedback else fallback_warning

    schedule_updated = bool(overrides) or bool(content_needed)
    if coach_feedback:
        logger.info("Check-in coach feedback: %s", coach_feedback[:120])
    logger.info("Check-in schedule updated: %s", schedule_updated)

    execution_time = (datetime.now() - agent_start_time).total_seconds()
    log_node_completion("Weekly planning (check-in)", execution_time)

    return {
        "weekly_plan": {"output": assessment},
        "strength_sessions": strength_sessions if schedule_updated else None,
        "scheduled_days": scheduled_days if schedule_updated else None,
        "running_sessions": running_sessions if schedule_updated else None,
        "coach_feedback": coach_feedback,
        "schedule_updated": schedule_updated,
        "timings": [create_timing_entry("weekly_planner", execution_time)],
    }


async def weekly_planner_node(state: TrainingAnalysisState) -> dict[str, list | str]:
    logger.info("Starting weekly planner node")

    checkin_mode = state.get("checkin_mode", False)
    logger.info("Weekly planner node: check-in mode %s", "on" if checkin_mode else "off")

    supabase_user_id = os.environ.get("SUPABASE_USER_ID")
    if not supabase_user_id:
        raise ValueError("SUPABASE_USER_ID must be set to load strength session templates")

    agent_start_time = datetime.now()

    async def node_execution():
        if checkin_mode:
            return await _execute_checkin(state, supabase_user_id, agent_start_time)
        return await _execute_full_redraft(state, supabase_user_id, agent_start_time)

    return await execute_node_with_error_handling(
        node_name="Weekly planner",
        node_function=node_execution,
        error_message_prefix="Weekly planning failed",
    )
