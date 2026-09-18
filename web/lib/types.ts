// Single source of truth for the weight-goal vocabulary (mirrored by the DB CHECK
// constraint in migration 024 and the prompt branches in the Python workflows).
export type WeightGoalDirection = "lose" | "maintain" | "gain";

export interface Plan {
  id: string;
  created_at: string;
  start_date: string;
  end_date: string;
  markdown: string;
}

export interface ScheduledDay {
  id: string;
  plan_id: string;
  date: string;
  session_type: string;
  focus: string | null;
  description: string | null;
  is_key: boolean;
  is_rest: boolean;
  running_segments: unknown[] | null;
  garmin_workout_id: number | null;
}

export interface StrengthSession {
  id: string;
  plan_id: string;
  date: string;
  name: string;
  garmin_workout_id: number | null;
  estimated_duration_secs: number;
  exercises: Exercise[];
}

export interface Exercise {
  id: string;
  display_order: number;
  garmin_category: string | null;
  garmin_exercise_key: string | null;
  display_name: string;
  sets: number;
  reps_min: number;
  reps_max: number;
  rest_seconds: number;
  rir: number | null;
}

export interface CompletedActivity {
  activity_id: number;
  date: string;
  activity_type: string | null;
  activity_name: string | null;
  duration_secs: number | null;
  distance_meters: number | null;
  avg_heart_rate: number | null;
  max_heart_rate: number | null;
  calories: number | null;
  activity_training_load: number | null;
}

// Mirrors migration 031 (completed_exercise_sets) — see .claude/backlog/per-exercise-progress-tab.md.
export interface CompletedExerciseSet {
  id: string;
  date: string;
  exercise_id: string | null;
  display_name: string;
  garmin_category: string | null;
  set_index: number;
  reps: number;
  weight_kg: number;
  prescribed_reps_min: number | null;
  prescribed_reps_max: number | null;
}

export type SessionRequestDayOfWeek =
  | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
export type SessionRequestType = "run" | "strength" | "cross" | "other";
export type SessionRequestImportance = "must" | "nice_to_have";

export interface RecurringSessionRequest {
  id: string;
  label: string;
  day_of_week: SessionRequestDayOfWeek | null;
  session_type: SessionRequestType;
  description: string;
  importance: SessionRequestImportance;
}
