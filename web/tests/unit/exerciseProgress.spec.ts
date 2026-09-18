import { test, expect } from "@playwright/test";
import { groupSetsByExercise, deriveRunningSessionTypeHistory } from "../../lib/exerciseProgress";
import type { CompletedActivity, CompletedExerciseSet, ScheduledDay } from "../../lib/types";

// Spec for .claude/backlog/per-exercise-progress-tab.md — pure data-derivation logic, tested
// without a browser. Rendering/selection behavior of ExerciseProgressTab is covered separately
// in tests/component/per-exercise-progress-tab.spec.tsx.

function set(overrides: Partial<CompletedExerciseSet>): CompletedExerciseSet {
  return {
    id: "s1",
    date: "2026-09-01",
    exercise_id: "ex-1",
    display_name: "Barbell bench press",
    garmin_category: "bench_press",
    set_index: 0,
    reps: 5,
    weight_kg: 80,
    prescribed_reps_min: 4,
    prescribed_reps_max: 6,
    ...overrides,
  };
}

function activity(overrides: Partial<CompletedActivity>): CompletedActivity {
  return {
    activity_id: 1,
    date: "2026-09-01",
    activity_type: "running",
    activity_name: "Morning Run",
    duration_secs: 1800,
    distance_meters: 5000,
    avg_heart_rate: 150,
    max_heart_rate: 165,
    calories: 400,
    activity_training_load: 50,
    ...overrides,
  };
}

function scheduledDay(overrides: Partial<ScheduledDay>): ScheduledDay {
  return {
    id: "d1",
    plan_id: "p1",
    date: "2026-09-01",
    session_type: "easy",
    focus: null,
    description: null,
    is_key: false,
    is_rest: false,
    running_segments: null,
    garmin_workout_id: null,
    ...overrides,
  };
}

test.describe("groupSetsByExercise", () => {
  test("keeps the heaviest set per date as that date's top-set weight", async () => {
    const sets = [
      set({ id: "a", date: "2026-09-01", set_index: 0, weight_kg: 80 }),
      set({ id: "b", date: "2026-09-01", set_index: 1, weight_kg: 85 }),
      set({ id: "c", date: "2026-09-01", set_index: 2, weight_kg: 82.5 }),
    ];
    const grouped = groupSetsByExercise(sets);
    const points = grouped.get("Barbell bench press");
    expect(points).toEqual([{ date: "2026-09-01", topWeightKg: 85 }]);
  });

  test("produces one point per date, ordered oldest to newest", async () => {
    const sets = [
      set({ id: "a", date: "2026-09-08", weight_kg: 87.5 }),
      set({ id: "b", date: "2026-09-01", weight_kg: 80 }),
      set({ id: "c", date: "2026-09-15", weight_kg: 90 }),
    ];
    const grouped = groupSetsByExercise(sets);
    expect(grouped.get("Barbell bench press")).toEqual([
      { date: "2026-09-01", topWeightKg: 80 },
      { date: "2026-09-08", topWeightKg: 87.5 },
      { date: "2026-09-15", topWeightKg: 90 },
    ]);
  });

  test("keeps distinct exercises under separate map entries", async () => {
    const sets = [
      set({ id: "a", display_name: "Barbell bench press", weight_kg: 80 }),
      set({ id: "b", display_name: "Back squat", weight_kg: 120 }),
    ];
    const grouped = groupSetsByExercise(sets);
    expect([...grouped.keys()].sort()).toEqual(["Back squat", "Barbell bench press"]);
  });

  test("keeps an exercise with only a single logged session (single data point)", async () => {
    const sets = [set({ id: "a", date: "2026-09-01", weight_kg: 80 })];
    const grouped = groupSetsByExercise(sets);
    expect(grouped.get("Barbell bench press")).toHaveLength(1);
  });
});

test.describe("deriveRunningSessionTypeHistory", () => {
  test("buckets a completed run under the scheduled day's session_type for the same date", async () => {
    const activities = [activity({ date: "2026-09-01" })];
    const days = [scheduledDay({ date: "2026-09-01", session_type: "tempo" })];
    const history = deriveRunningSessionTypeHistory(activities, days);
    expect(history.get("tempo")).toEqual([
      { date: "2026-09-01", distanceMeters: 5000, durationSecs: 1800 },
    ]);
  });

  test("groups multiple runs of the same session_type across dates into one bucket", async () => {
    const activities = [
      activity({ activity_id: 1, date: "2026-09-01", distance_meters: 5000, duration_secs: 1800 }),
      activity({ activity_id: 2, date: "2026-09-08", distance_meters: 6000, duration_secs: 2100 }),
    ];
    const days = [
      scheduledDay({ date: "2026-09-01", session_type: "easy" }),
      scheduledDay({ date: "2026-09-08", session_type: "easy" }),
    ];
    const history = deriveRunningSessionTypeHistory(activities, days);
    expect(history.get("easy")).toHaveLength(2);
  });

  test("excludes a completed run with no scheduled_days row for its date", async () => {
    const activities = [
      activity({ activity_id: 1, date: "2026-09-01" }),
      activity({ activity_id: 2, date: "2026-09-02" }), // no matching scheduled day below
    ];
    const days = [scheduledDay({ date: "2026-09-01", session_type: "easy" })];
    const history = deriveRunningSessionTypeHistory(activities, days);
    const allPoints = [...history.values()].flat();
    expect(allPoints).toHaveLength(1);
    expect(allPoints[0].date).toBe("2026-09-01");
  });

  test("passes distance and duration through unmodified", async () => {
    const activities = [activity({ date: "2026-09-01", distance_meters: 12345, duration_secs: 4321 })];
    const days = [scheduledDay({ date: "2026-09-01", session_type: "long" })];
    const history = deriveRunningSessionTypeHistory(activities, days);
    expect(history.get("long")?.[0]).toMatchObject({ distanceMeters: 12345, durationSecs: 4321 });
  });
});
