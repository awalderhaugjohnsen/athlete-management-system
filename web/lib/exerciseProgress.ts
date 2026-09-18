// Stub only — see .claude/backlog/per-exercise-progress-tab.md. Exists so
// tests/unit/exerciseProgress.spec.ts and this project's tsc --noEmit gate can resolve these
// exports; deliberately unimplemented so the tests fail on missing behavior, not a missing
// module.
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
  _sets: CompletedExerciseSet[]
): Map<string, ExerciseHistoryPoint[]> {
  return new Map();
}

export interface RunningSessionTypePoint {
  date: string;
  sessionType: string;
  distanceMeters: number | null;
  durationSecs: number | null;
}

/**
 * Matches each completed run to the `scheduled_days` row for the same date to derive its
 * session type. Runs with no matching scheduled day are excluded, not bucketed as "unknown".
 */
export function deriveRunningSessionTypeHistory(
  _activities: CompletedActivity[],
  _scheduledDays: ScheduledDay[]
): Map<string, RunningSessionTypePoint[]> {
  return new Map();
}
