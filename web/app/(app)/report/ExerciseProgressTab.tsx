"use client";

// Stub only — see .claude/backlog/per-exercise-progress-tab.md. Exists so
// tests/component/per-exercise-progress-tab.spec.tsx (and this project's tsc --noEmit gate) can
// resolve the module and its props type; deliberately renders nothing yet, so those tests fail
// on missing behavior rather than a missing import.
import type { CompletedActivity, CompletedExerciseSet, ScheduledDay } from "@/lib/types";

export interface ExerciseProgressTabProps {
  completedSets: CompletedExerciseSet[];
  completedActivities: CompletedActivity[];
  scheduledDays: ScheduledDay[];
}

export function ExerciseProgressTab(_props: ExerciseProgressTabProps) {
  return null;
}
