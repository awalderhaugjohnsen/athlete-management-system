// See .claude/backlog/per-exercise-progress-tab.md. Pure data-derivation for the per-exercise
// and per-running-session-type progress tab — no React, no Supabase client, so it's testable
// head-on in Node (tests/unit/exerciseProgress.spec.ts) without a browser.
import type { CompletedActivity, CompletedExerciseSet, ScheduledDay } from "./types";

export interface ExerciseHistoryPoint {
  date: string;
  topWeightKg: number;
}

/**
 * Groups completed sets by `display_name` (not `exercise_id` — see the backlog Goal for why)
 * into one history point per date, keeping only that date's heaviest set (top-set weight).
 */
export function groupSetsByExercise(
  sets: CompletedExerciseSet[]
): Map<string, ExerciseHistoryPoint[]> {
  // display_name -> date -> heaviest weight_kg logged that date
  const byExerciseThenDate = new Map<string, Map<string, number>>();

  for (const s of sets) {
    let byDate = byExerciseThenDate.get(s.display_name);
    if (!byDate) {
      byDate = new Map();
      byExerciseThenDate.set(s.display_name, byDate);
    }
    const current = byDate.get(s.date);
    if (current === undefined || s.weight_kg > current) {
      byDate.set(s.date, s.weight_kg);
    }
  }

  const result = new Map<string, ExerciseHistoryPoint[]>();
  for (const [displayName, byDate] of byExerciseThenDate) {
    const points = [...byDate.entries()]
      .map(([date, topWeightKg]) => ({ date, topWeightKg }))
      .sort((a, b) => a.date.localeCompare(b.date));
    result.set(displayName, points);
  }
  return result;
}

export interface RunningSessionTypePoint {
  date: string;
  distanceMeters: number | null;
  durationSecs: number | null;
}

/**
 * Matches each completed run to the `scheduled_days` row for the same date to derive its
 * session type. Runs with no matching scheduled day are excluded, not bucketed as "unknown".
 *
 * The map key (session_type) already identifies the bucket, so individual points don't carry
 * a redundant `sessionType` field.
 */
export function deriveRunningSessionTypeHistory(
  activities: CompletedActivity[],
  scheduledDays: ScheduledDay[]
): Map<string, RunningSessionTypePoint[]> {
  // Last row wins on a date collision (e.g. multiple time_slots on one day) — a reasonable
  // default for this heuristic; there's no way to disambiguate which slot a completed run
  // matches without a slot on CompletedActivity itself.
  const dayByDate = new Map<string, ScheduledDay>();
  for (const day of scheduledDays) dayByDate.set(day.date, day);

  const result = new Map<string, RunningSessionTypePoint[]>();
  const runs = activities.filter(a => a.activity_type === "running");

  for (const run of runs) {
    const day = dayByDate.get(run.date);
    if (!day) continue; // no matching scheduled day — excluded, not bucketed as "unknown"

    const point: RunningSessionTypePoint = {
      date: run.date,
      distanceMeters: run.distance_meters,
      durationSecs: run.duration_secs,
    };
    const existing = result.get(day.session_type);
    if (existing) existing.push(point);
    else result.set(day.session_type, [point]);
  }

  for (const points of result.values()) {
    points.sort((a, b) => a.date.localeCompare(b.date));
  }
  return result;
}
