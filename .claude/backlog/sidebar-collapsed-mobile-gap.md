---
title: Fix left-side gap when collapsed sidebar switches to mobile viewport
status: tests-written
created: 2026-09-15
updated: 2026-09-18
tests: [web/tests/component/sidebar-collapsed-mobile-gap.spec.tsx]
touches: [web/app/globals.css]
depends_on:
attempts: 0
schedule_backend:
schedule_task_id:
schedule_created_at:
max_background_hours:
pr_url:
---

## Goal

When the sidebar is collapsed on desktop (persisted via `localStorage` "sb-collapsed", read in
`web/app/Sidebar.tsx:19-26`) and the viewport then changes to mobile width (≤768px), `.main-area`
is left with an empty gap on the left where the sidebar used to be, even though the sidebar itself
is hidden on mobile (`display:none`, `web/app/globals.css:246`).

Root cause confirmed: `web/app/globals.css:242` sets
`.app-shell:has(.sb-collapsed) .main-area { margin-left: 60px; }` with `:has()` selector
specificity (0,3,0) that outranks the mobile reset at `globals.css:245-248`
(`@media (max-width: 768px) { .main-area { margin-left: 0; ... } }`, specificity 0,1,0) —
regardless of source order, the desktop-collapsed rule wins even under the mobile media query as
long as the `sb-collapsed` class is still present. A second, narrower version of the same issue
exists for the pre-hydration blocking-script snapshot: `html.sb-collapsed-init .main-area {
margin-left: 60px; }` (`globals.css:177`, specificity 0,2,1) is also not scoped out of the mobile
breakpoint.

## Acceptance criteria

- [ ] With the sidebar collapsed on desktop, resizing the viewport to ≤768px in the same session
  (no reload) results in `.main-area` having no left margin/gap — content starts flush at the left
  edge, matching the normal mobile layout.
- [ ] Loading the app fresh at a ≤768px viewport when `sb-collapsed` was persisted from a prior
  desktop session also results in no left-side gap (covers the `html.sb-collapsed-init`
  pre-hydration case, not just the live-resize case).
- [ ] Desktop behavior above 768px is unchanged: collapsed sidebar still yields `margin-left: 60px`
  on `.main-area`, expanded sidebar still yields the normal (non-collapsed) margin.
- [ ] The fix is expressed as a CSS specificity/scoping correction (e.g. scoping the `:has()` rule
  to a min-width media query, or adding an explicit higher-specificity mobile override) rather than
  removing the `sb-collapsed` class tracking mechanism itself.

## Notes

- 2026-09-15: created via `/point new`. Root cause located via `globals.css:242` vs `:245-248`
  specificity conflict, plus the secondary `html.sb-collapsed-init` case at `globals.css:177`.
  Fully independent of the other two points in this batch — touches only
  `web/app/globals.css`/`web/app/Sidebar.tsx`, no file overlap.
- 2026-09-16: spec drafted, awaiting review. Tests
  (`web/tests/component/sidebar-collapsed-mobile-gap.spec.tsx`) mount a minimal harness
  (`web/tests/component/SidebarGapHarness.tsx`) reproducing just the real
  `.app-shell > .sidebar.sb-collapsed + .main-area` class structure with the real `globals.css`
  loaded, rather than the actual `Sidebar` component — `Sidebar.tsx` depends on
  `next/navigation`'s `usePathname` and `next/link`, neither of which resolve under Playwright's
  Vite-based component-test runner (this is a generic React harness, not a real Next.js app
  router), and the bug itself lives entirely in CSS selectors keyed off those class names, so the
  harness is a faithful, much cheaper reproduction. Dropped `web/app/Sidebar.tsx` from `touches`
  accordingly — confirmed the fix is CSS-only (`globals.css`), no component changes needed.
  Ran the 4 tests against the current (unfixed) CSS: the 2 tests encoding the actual bug both
  fail with the exact predicted wrong value (`60px` instead of `0px`), and the 2 no-regression
  tests for existing desktop behavior already pass — the expected mixed red/green state for a
  bug-fix spec, not "all red."
