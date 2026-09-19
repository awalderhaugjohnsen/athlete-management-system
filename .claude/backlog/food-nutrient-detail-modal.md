---
title: Clickable food log entries with expandable nutrient profile
status: done-pending-review
created: 2026-09-15
updated: 2026-09-19
tests: [web/tests/component/food-nutrient-detail-modal.spec.tsx]
touches: [web/app/(app)/nutrition/NutritionClient.tsx, web/app/(app)/nutrition/FoodNutrientModal.tsx]
depends_on:
attempts: 0
schedule_backend: github-actions
schedule_task_id:
schedule_created_at: 2026-09-18T10:48:29Z
max_background_hours: 48
pr_url: https://github.com/awalderhaugjohnsen/athlete-management-system/pull/29
---

## Goal

Logged foods in the nutrition diary currently render as plain rows with no way to see their full
nutrient breakdown. All the underlying data already exists — `nutrition_diary` (migration
`010_nutrition.sql`) and the `DiaryEntry` type
(`web/app/(app)/nutrition/NutritionClient.tsx:23-73`) already store fiber, sugar, sodium, all
major vitamins (A/C/D/E/K, B-complex), minerals (calcium, iron, magnesium, phosphorus, potassium,
zinc, copper), and fat subtypes (saturated/mono/poly/omega3/cholesterol) per entry. This is a
UI-only point: make each logged food row clickable and show that data in an overlay, reusing the
existing centered-overlay modal idiom already used for `ExpandedChart`
(`web/app/(app)/report/ProgressTabs.tsx:991-1008`) and the food-search modal
(`NutritionClient.tsx` ~line 1827+), rather than inventing a new drawer/panel pattern.

Meal entries already have an inline expand/collapse for their ingredient rows
(`expandedEntries` state, `NutritionClient.tsx:1580-1598`) — that stays as-is; this point adds
the nutrient-detail overlay on top, triggered by clicking a food/ingredient row (standalone entry
or an ingredient row inside an expanded meal).

## Acceptance criteria

- [ ] Each logged food entry row (standalone, non-meal) in the diary is clickable via mouse and
  keyboard (e.g. Enter/Space when focused), and does not conflict with any existing row-level
  controls (e.g. delete).
- [ ] Each ingredient row inside an expanded meal entry is independently clickable the same way.
- [ ] Clicking opens a centered overlay modal (matching the existing `ExpandedChart`/food-search
  overlay style: fixed, full-screen backdrop, dismiss on backdrop click) showing that entry's
  full nutrient profile: calories; macros (protein, carbs, fat, fiber, sugar); fat subtypes
  (saturated, mono, poly, omega-3, cholesterol); sodium; vitamins (A, C, D, E, K, B-complex); and
  minerals (calcium, iron, magnesium, phosphorus, potassium, zinc, copper).
- [ ] A nutrient field that is null/missing for a given entry is omitted or shown as "—" rather
  than rendered as 0 or causing an error.
- [ ] The modal closes on Escape and via an explicit close control.
- [ ] No new database columns or API fields are introduced — all displayed data is sourced from
  existing `nutrition_diary` columns already present on `DiaryEntry`.

## Notes

- 2026-09-18: implemented and PR opened (#29). Replaced the `FoodNutrientModal` stub with a
  working centered overlay (reusing the `ExpandedChart`/food-search fixed-overlay idiom): macros,
  fat subtypes, sodium, vitamins and minerals each render via a `data-testid="nutrient-<field>"`
  row, with every optional field sourcing its label from the existing `nt.macroLabels` /
  `nt.micronutrients` dictionary entries (no new i18n strings needed — the labels used by the
  existing micronutrients card already covered every field, in both `en` and `no`). Null/missing
  fields render "—", not "0". Wired click + Enter/Space handling onto the standalone diary row and
  each meal-ingredient row in `NutritionClient.tsx`, with `stopPropagation` added to the existing
  delete and meal-expand-toggle buttons so they still work independently of the new row click.
  All 4 component tests passed on the first implementation cycle; `tsc --noEmit` and `npm run
  lint` also clean. As anticipated in the 2026-09-16 note, the row-click wiring itself has no
  automated test (documented as an explicit scope decision, not an oversight) and was **not**
  verified in a real browser this run — no `claude-in-chrome` MCP access in this headless
  environment and no dev server was started, per project convention. Flagged in the PR for a
  manual check before merge.
- 2026-09-15: created via `/point new`. Confirmed via codebase exploration that no nutrient data
  is missing — this is UI-only. No existing drawer/slide-in component in the app; the idiom to
  reuse is the centered fixed-overlay pattern already used twice (`ExpandedChart`, food-search
  modal). No dependency on the other two points confirmed in this same batch (per-exercise
  progress tab touches `web/app/(app)/report/`, not `nutrition/`; sidebar gap fix touches
  `globals.css`/`Sidebar.tsx` only).
- 2026-09-16: spec drafted, awaiting review. `web/` had no test framework at all before this pass
  — Adrian chose Playwright (component testing via `@playwright/experimental-ct-react`) over the
  alternatives; that shared harness (`web/playwright-ct.config.ts`, `web/playwright/`) is new
  infrastructure this point's commit carries, since it's the first of the three new points to
  land tests. Setting it up surfaced two real compatibility issues, both fixed: (1) mounting any
  component wrapped in the real `LanguageProvider` hung indefinitely because it transitively
  imports a Next.js Server Action (`saveLanguage`) that Vite's CT bundler can't execute in a
  browser context — fixed by aliasing `@/app/actions/user-settings` to a no-op stub
  (`web/playwright/stubs/user-settings.ts`) in `ctViteConfig`, scoped to tests only; (2)
  `@playwright/test` and `@playwright/experimental-ct-react`'s `playwright` core versions had
  drifted (1.63.0 vs 1.62.1), producing a "two different versions of @playwright/test" duplicate-
  module error — fixed by pinning `@playwright/test` to `1.62.1` to match.
  New `web/app/(app)/nutrition/FoodNutrientModal.tsx` is a non-functional stub (renders `null`)
  so the spec test file resolves for `tsc --noEmit` and Playwright import — all 4 tests fail
  against it for the right reason (missing behavior: no rows, no close handling), not a build
  error.
  Scope decision: the two acceptance criteria about clicking a *row in the diary* to open the
  modal are **not** covered by an automated test here. Mounting the real `NutritionClient` in
  Playwright CT would need to work around its `BarcodeScanner`/`PhotoFoodCapture` (camera APIs)
  and several more Server Actions beyond `saveLanguage` — disproportionate fragility for a
  personal single-user app. The modal's own rendering, null-field handling, and close behavior
  (the actual substance of the feature) are fully covered; the one-line `onClick` wiring onto
  each row is small enough to verify by hand in the real browser at implementation time, per this
  project's own established verification approach (`web/CLAUDE.md`).
- 2026-09-18: tests-written PR merged (#25). Backgrounded on `github-actions` — the repo's
  one-time setup (`CLAUDE_CODE_OAUTH_TOKEN`/`GH_PAT` secrets, `.github/workflows/point-loop.yml`,
  `.claude/skills/point/` synced, daytime-toggle issue) was already in place from an earlier
  point. `max_background_hours` left at the skill's default (48h) — not specified by Adrian.
- 2026-09-19: an unrecorded background firing (shortly after the #25 merge, ~2026-09-18T11:00Z —
  before this file's `schedule_created_at` timestamp was even written, so this must have been the
  very first scheduled firing) had already implemented this point and opened PR #29, green on
  all CI checks (`python`, `web`, Vercel), but the backlog file itself was never updated to
  `done-pending-review` — status was still `tests-written` with no `pr_url` when a manual
  `/point run` was invoked here. Root cause not confirmed (crash after push but before the backlog
  commit, or a race with another concurrent firing), but worth watching for on the other two
  points backgrounded at the same time — check their PRs directly, not just backlog status.
  This `run` invocation independently re-implemented the same feature from scratch in a fresh
  worktree (not knowing #29 existed), got all 4 tests green on the first cycle, lint/type-check
  clean, then discovered the already-pushed, already-green PR #29 on the shared remote branch
  when its own push was rejected as non-fast-forward. Correctly did not force-push a duplicate
  over already-green work. That redundant local worktree was discarded. Reconciling: `pr_url` set
  to #29, status set to `done-pending-review` directly (skipping a second PR) since #29 already
  satisfies every acceptance criterion with the same test file and passing CI. PR #29 itself
  flags, honestly, that real-browser verification of the row-click wiring was never done (headless
  CI runner, no dev server) — recommend Adrian do that quick manual check before merging.
