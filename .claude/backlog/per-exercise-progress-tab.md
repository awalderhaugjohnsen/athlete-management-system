---
title: Per-exercise and per-running-session-type progress tab
status: done-pending-review
created: 2026-09-15
updated: 2026-09-19
tests: [web/tests/unit/exerciseProgress.spec.ts, web/tests/component/per-exercise-progress-tab.spec.tsx]
touches: [web/app/(app)/report/ProgressTabs.tsx, web/app/(app)/report/page.tsx, web/app/(app)/report/ExerciseProgressTab.tsx, web/lib/exerciseProgress.ts, web/lib/types.ts]
depends_on:
attempts: 0
schedule_backend: github-actions
schedule_task_id:
schedule_created_at: 2026-09-18T10:48:29Z
max_background_hours: 48
pr_url: https://github.com/awalderhaugjohnsen/athlete-management-system/pull/30
---

## Goal

The Progress page (`/report`, `web/app/(app)/report/ProgressTabs.tsx`) currently has three tabs
(This Week / Trends / Season Analysis) built on generic `daily_metrics` columns plus one strength
metric (`bench_e1rm_kg`). There is no per-exercise or per-running-session-type history anywhere,
even though the data exists: `completed_exercise_sets` (migration `031`) records every completed
set (`exercise_id`, `display_name`, `garmin_category`, `date`, `set_index`, `reps`, `weight_kg`)
and is not queried anywhere in `web/` today.

Add a new tab that shows logged progress for commonly used/planned strength exercises and running
session types, plotted per session over time.

Strength side: group completed sets by `display_name` (not `exercise_id`, which doesn't survive
plan regeneration reliably per `web/lib/types.ts:36-47`) to identify "the same exercise across
sessions."

Running side: `completed_activities.activity_type`/`activity_name` are raw Garmin strings with no
session-type taxonomy (only a coarse strength/run/other split exists today, in
`web/app/(app)/ActivityHeatmap.tsx:8-22`). The session-type concept (easy/tempo/long/interval etc.)
only exists on the *planned* side, as `scheduled_days.session_type`/`focus`. Derive a completed
run's session type by matching it to the `scheduled_days` row for the same date.

No charting library exists in this app (`web/package.json` has none) — all charts in
`ProgressTabs.tsx` are hand-rolled inline SVG (`PMCChart`/`CompactChart`/`ExpandedChart`). Reuse
that same rendering approach rather than adding a dependency like recharts.

## Acceptance criteria

- [ ] A new tab appears under Progress alongside the existing three, listing strength exercises
  that have at least one completed set, grouped by `display_name`.
- [ ] Selecting a listed strength exercise renders a chart of its progress over time (one point
  per session containing that exercise) — at minimum, top-set weight and/or estimated 1RM per
  session — using the existing hand-rolled SVG chart machinery (no new charting library added to
  `package.json`).
- [ ] The same tab (or a clearly separated section within it) lists running session types derived
  by matching each completed run's date to that date's `scheduled_days.session_type`/`focus`, and
  selecting one renders a chart of a relevant metric (pace, distance, or duration) per session over
  time for that type.
- [ ] Completed runs with no matching `scheduled_days` row for their date are excluded from the
  running session-type list rather than causing an error or an "unknown" bucket that can't be
  selected.
- [ ] An exercise or session type with fewer than 2 data points still renders without a crash
  (single point or an explicit empty/insufficient-data state, not a broken axis/scale).
- [ ] No new database migration is required — the point only adds queries against existing
  `completed_exercise_sets`, `completed_activities`, and `scheduled_days` tables.

## Notes

- 2026-09-15: created via `/point new`. Confirmed `completed_exercise_sets` exists and is unused
  in `web/`. Confirmed no clean running-session-type taxonomy exists on the completed-activity
  side — matching to `scheduled_days` by date is the chosen approach rather than inventing a new
  classification. No overlap/dependency with the other two points in this batch (touches
  `web/app/(app)/report/`, distinct from `nutrition/` and `globals.css`/`Sidebar.tsx`).
- 2026-09-16: spec drafted, awaiting review. Added `CompletedExerciseSet` to `web/lib/types.ts`
  (mirrors migration `031` exactly — a type addition, not new behavior). Split the acceptance
  criteria across two test files by nature, not by acceptance-criterion count: pure
  date-matching/grouping logic (`web/lib/exerciseProgress.ts`:
  `groupSetsByExercise`/`deriveRunningSessionTypeHistory`) is tested in Node, no browser, via
  `web/tests/unit/exerciseProgress.spec.ts` (plain `@playwright/test`, new `web/playwright.config.ts`,
  separate from the component-test config); the new tab's rendering/selection behavior
  (`web/app/(app)/report/ExerciseProgressTab.tsx`) is tested via Playwright CT in
  `web/tests/component/per-exercise-progress-tab.spec.tsx`, which assumes the derivation logic is
  wired in correctly rather than re-testing it. Both files currently fail against non-functional
  stubs (empty `Map`s / `render null`) for the right reason — missing behavior, not a build error.
  Two scope notes for the reviewer: (1) tests assert the *count* of chart points and list entries,
  not exact rendered metric text (pace/weight formatting) — the acceptance criteria's "top-set
  weight and/or estimated 1RM" and "pace, distance, or duration" leave the exact metric choice
  open, and locking a test to one specific formula/format felt like over-specifying at spec time;
  (2) the tests don't verify the chart is built from the existing hand-rolled SVG machinery
  specifically (vs. some other rendering) — that's a code-structure constraint from the Goal
  section, better caught at code review than encoded as a runtime assertion.
- 2026-09-18: tests-written PR merged (#26). Backgrounded on `github-actions` — the repo's
  one-time setup (`CLAUDE_CODE_OAUTH_TOKEN`/`GH_PAT` secrets, `.github/workflows/point-loop.yml`,
  `.claude/skills/point/` synced, daytime-toggle issue) was already in place from an earlier
  point. `max_background_hours` left at the skill's default (48h) — not specified by Adrian.
- 2026-09-19: discovered while reconciling a sibling point (`food-nutrient-detail-modal`) that
  the same gap applies here — an unrecorded background firing shortly after the #26 merge had
  already implemented this point and opened PR #30 (green on `python`/`web`/Vercel CI,
  mergeable), but the backlog file was never updated to `done-pending-review`. Reconciling now
  without re-running: `pr_url` set to #30, status set to `done-pending-review` directly. Did not
  re-inspect the PR's diff in depth — only confirmed it targets this branch and CI is green;
  Adrian should review the actual chart/derivation logic against the two scope notes above
  (metric-format looseness, SVG-machinery-reuse not runtime-checked) as normal PR review.
