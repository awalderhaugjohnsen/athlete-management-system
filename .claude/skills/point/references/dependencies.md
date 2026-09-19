# Dependency detection and resolution

Two separate problems: **detecting** that two points overlap (done at `new` and refined at
`spec`), and **resolving** what that means for branching (done at `run`). Keep them separate —
detection is a judgment call made once per point-pair; resolution is mechanical and re-checked
every time `run` fires.

## Detecting overlap (`new`, refined at `spec`)

Run this against every other point currently at `tests-written`, `waiting`, or `in-progress`
(i.e. active and unmerged — a `done-pending-review` point whose PR already merged needs no
special handling, since `main` already reflects it; Sync retires those before this check runs).

Combine two signals; either one firing is enough to call it a dependency:

1. **Structural (file/area overlap).** Before finalizing acceptance criteria, do a quick,
   targeted read of the codebase relative to what the new point describes — the same look-around
   that naturally happens while drafting criteria — and note the files/modules it's likely to
   touch. Record this as `touches`. Compare against every active point's own `touches` list. Any
   overlap → dependency.
2. **Semantic (judgment).** Read the new point's draft Goal and acceptance criteria against each
   active point's Goal and acceptance criteria, and reason directly: would implementing this
   plausibly build on, assume something about, or conflict with the other, even without touching
   the same files? (Example: one point changes an API's response shape; another's criteria were
   written assuming the old shape.) This is inherently a judgment call — make it, state the
   reasoning in one line to the user, don't hedge by asking them to make it instead for the
   routine case.

At `spec` time, redo this check with real information: writing the tests means actually reading
the relevant code, which is much better grounds for `touches` than the guess made at `new` time.
Correct `depends_on` if the earlier guess was wrong in either direction — missed a real overlap,
or flagged a false one.

If overlap is found against more than one active point, pick the most recently created one as
`depends_on` — chains resolve fine one link at a time (see Resolution below), no need to record
more than the direct parent.

## Resolving a dependency (`run`, every invocation)

At the start of `run`, if `depends_on` is set, look up that point's current status and decide:

| Dependency status | What this point does |
|---|---|
| Retired (merged, file gone) | Clear `depends_on`. Branch off current `main`. |
| `done-pending-review`, PR still open | Branch off the dependency's `point/<slug>` branch. |
| `tests-written` / `waiting` / `in-progress` | Set this point's status to `waiting`, stop. No attempt consumed. |
| `blocked` | Cascade: set this point to `blocked` too, with a note ("blocked transitively via `<dep-slug>`"), delete any `schedule_task_id`. |

A chain resolves naturally without extra bookkeeping: if point C depends on B which depends on A,
and A is still in progress, B's own status will already read `waiting` — so C checking B's status
sees `waiting`, not a terminal state, and C also waits. No need to walk the whole chain manually.

## The rebase-and-retest cascade

A dependency's branch can move after this point already branched off it — CI auto-fix pushed a
commit, or review feedback changed something. Immediately before opening or updating a PR (Run
step 8 in `SKILL.md`), check whether the resolved base has moved since this branch was created:

- If yes: rebase this point's branch onto the new tip, re-run the full test suite, and only then
  proceed to open/update the PR. Treat a rebase that reintroduces red tests the same as any other
  implementation failure — fix it within the normal attempt budget, or fall through to the
  `blocked` path if attempts run out.
- If the dependency merged while this point was running: the rebase target becomes `main`
  (which now includes it) instead of the dependency's branch — same mechanism, just a different
  target.

## Concurrency guard

Before doing anything else, `run` fetches/pulls latest `main`, then checks: is status already
`in-progress`? If so, compare `updated` against now. Within the last 30 minutes → assume another
invocation (manual or scheduled) is genuinely mid-loop right now, and stop without touching
anything. Older than that → treat it as a crashed or interrupted run rather than a live one, and
proceed normally (this invocation takes over).

This guard only works if entering `in-progress` is pushed to `main` immediately, not deferred
until the point finishes — see `SKILL.md` Run step 5. A `github-actions` firing and a separate
interactive `run` each start from their own checkout; if the first invocation's `in-progress`
marker sits uncommitted or unpushed while it works, the second invocation's fetch in this step
still sees the last-pushed status (`tests-written`/`waiting`), finds the point "eligible," and
starts on it too — both then implement the same point independently and race to push. This
happened in practice (see the `food-nutrient-detail-modal` and `per-exercise-progress-tab`
backlog notes from 2026-09-18/19): neither invocation was wrong to proceed given what it could
see, the marker just wasn't visible yet. Pushing it as its own commit *before* dispatching the
worktree agent closes that window.

## The honest limit, and why it's fine to automate anyway

No heuristic here is perfect — the semantic check especially is a judgment call, not a proof. That
is an acceptable tradeoff only because the PR-not-merge gate (see `references/workflow.md`) is
still the backstop: if detection misses a real dependency, the worst case is an ordinary GitHub
merge conflict on the second PR — a normal, cheap problem for a human to resolve at merge time,
not silent breakage. If detection over-triggers, the worst case is some unnecessary serialization
— slower, not wrong. Optimize for the common case being right and automatic; lean on the existing
review gate for the rare miss rather than trying to make the classifier perfect.
