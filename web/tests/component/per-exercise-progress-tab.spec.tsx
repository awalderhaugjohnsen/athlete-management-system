import { test, expect } from "@playwright/experimental-ct-react";
import { ExerciseProgressTab } from "@/app/(app)/report/ExerciseProgressTab";
import type { CompletedActivity, CompletedExerciseSet, ScheduledDay } from "@/lib/types";

// Spec for .claude/backlog/per-exercise-progress-tab.md — rendering/selection behavior of the
// new tab. The date-matching/grouping logic itself is covered without a browser in
// tests/unit/exerciseProgress.spec.ts; this file assumes that logic is wired in correctly and
// checks what the tab actually shows and lets you select.

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

test.describe("ExerciseProgressTab", () => {
  test("lists each distinct strength exercise once, not once per set", async ({ mount }) => {
    const sets = [
      set({ id: "a", date: "2026-09-01", set_index: 0 }),
      set({ id: "b", date: "2026-09-01", set_index: 1 }),
      set({ id: "c", display_name: "Back squat", date: "2026-09-01" }),
    ];
    const component = await mount(
      <ExerciseProgressTab completedSets={sets} completedActivities={[]} scheduledDays={[]} />
    );
    const list = component.getByTestId("exercise-list");
    await expect(list.getByText("Barbell bench press")).toBeVisible();
    await expect(list.getByText("Back squat")).toBeVisible();
    await expect(list.getByRole("listitem")).toHaveCount(2);
  });

  test("lists a running session type derived from completed activities matched to scheduled days", async ({ mount }) => {
    const activities = [activity({ date: "2026-09-01" })];
    const days = [scheduledDay({ date: "2026-09-01", session_type: "tempo" })];
    const component = await mount(
      <ExerciseProgressTab completedSets={[]} completedActivities={activities} scheduledDays={days} />
    );
    await expect(component.getByTestId("session-type-list").getByText("tempo")).toBeVisible();
  });

  test("excludes a completed run with no matching scheduled day from the session-type list", async ({ mount }) => {
    const activities = [
      activity({ activity_id: 1, date: "2026-09-01" }),
      activity({ activity_id: 2, date: "2026-09-05" }), // no matching scheduled day
    ];
    const days = [scheduledDay({ date: "2026-09-01", session_type: "tempo" })];
    const component = await mount(
      <ExerciseProgressTab completedSets={[]} completedActivities={activities} scheduledDays={days} />
    );
    await expect(component.getByTestId("session-type-list").getByRole("listitem")).toHaveCount(1);
  });

  test("selecting a strength exercise renders a chart with one point per session", async ({ mount }) => {
    const sets = [
      set({ id: "a", date: "2026-09-01", weight_kg: 80 }),
      set({ id: "b", date: "2026-09-08", weight_kg: 82.5 }),
      set({ id: "c", date: "2026-09-15", weight_kg: 85 }),
    ];
    const component = await mount(
      <ExerciseProgressTab completedSets={sets} completedActivities={[]} scheduledDays={[]} />
    );
    await component.getByTestId("exercise-list").getByText("Barbell bench press").click();
    const chart = component.getByTestId("exercise-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-point-count", "3");
  });

  test("an exercise with a single logged session still renders its chart without crashing", async ({ mount }) => {
    const sets = [set({ id: "a", date: "2026-09-01", weight_kg: 80 })];
    const component = await mount(
      <ExerciseProgressTab completedSets={sets} completedActivities={[]} scheduledDays={[]} />
    );
    await component.getByTestId("exercise-list").getByText("Barbell bench press").click();
    const chart = component.getByTestId("exercise-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-point-count", "1");
  });

  test("selecting a running session type renders its own chart", async ({ mount }) => {
    const activities = [
      activity({ activity_id: 1, date: "2026-09-01" }),
      activity({ activity_id: 2, date: "2026-09-08" }),
    ];
    const days = [
      scheduledDay({ date: "2026-09-01", session_type: "long" }),
      scheduledDay({ date: "2026-09-08", session_type: "long" }),
    ];
    const component = await mount(
      <ExerciseProgressTab completedSets={[]} completedActivities={activities} scheduledDays={days} />
    );
    await component.getByTestId("session-type-list").getByText("long").click();
    const chart = component.getByTestId("exercise-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-point-count", "2");
  });
});
