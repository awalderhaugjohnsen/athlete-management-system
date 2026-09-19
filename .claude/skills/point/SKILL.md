---
name: point
description: This skill should be used when the user asks to "add a point", "start a point loop", "track a future change", "add a backlog item", "spec out a change", "write tests for a point then implement it", "run the point loop", "let this run in the background", or invokes "/point". It manages a per-repo backlog of future changes ("points"), each gated by a reviewed, failing-tests-first spec before an implementation loop is allowed to touch code — with automatic dependency detection between concurrent points, a structured PR at the end, and CI auto-fix — optionally running unattended via a scheduled cloud agent.
version: 0.2.0
---

# Point: spec-driven, TDD-gated backlog loop

A "point" is one goal for a project — a bug fix, a feature, a refactor — tracked as a file in
`.claude/backlog/<slug>.md` and moved through: `planned` → `tests-written` → (`waiting` ↔)
`in-progress` → `done-pending-review` (or `blocked`). The core rule, backed by real-world
experience running autonomous coding loops: **the step that writes the tests and the step that
writes the implementation must be separate, with a human checkpoint between them.** An agent that
can edit its own tests will eventually edit them to pass rather than fix the code. See
`references/workflow.md` for the reasoning and failure modes this guards against.

Full field/status reference: `references/backlog-format.md`. Read it before creating or editing
a backlog file — do not guess the schema.

## Before anything else

Read the target repo's own `CLAUDE.md` / `AGENTS.md` (root, and any subdirectory ones — e.g. a
`web/AGENTS.md`) and follow its conventions: how to run tests, what not to do (don't start a dev
server, don't use a bare `python`, etc.), and its own architectural rules. This skill supplies
the *loop*; the project supplies the *how*. Never override a project's own stated conventions.

## Sync first

`list`, `new`, and `run` all start with this reconciliation pass, before doing anything else:

1. For every backlog file at `done-pending-review` with a `pr_url`, check whether that PR
   merged (`gh pr view <pr_url> --json state,mergedAt`). If merged: `git rm` the backlog file and
   commit ("retire merged point `<slug>`") — don't track "merged" state twice. If closed without
   merging, leave it as-is and surface it in the output; that needs a human decision, not an
   automatic one.
2. For every backlog file at `waiting`, check its `depends_on` point. If that point is gone
   (merged and retired by step 1), clear `depends_on` and set status back to `tests-written` —
   it's ready to run against current `main`. If the dependency is now `blocked`, cascade: set
   this point to `blocked` too, with a note that it's blocked transitively, and delete any
   `schedule_task_id` so it stops firing against a dead dependency.

This keeps `list` honest and keeps the dependency check in `new` from comparing against points
that are actually already finished.

## Dispatch on `args`

- No args, or `list` → **List**
- `status <slug>` → show one item's full content
- `new <description(s)>`, or free text matching no other subcommand → **New** (one description or
  several — see New below)
- `spec <slug>` → **Spec** (red)
- `run <slug>` → **Run** (green)
- `background <slug> [cadence]` → **Background**

## List

Run Sync first. Then read every remaining file in `.claude/backlog/` and print a table: slug,
status, `depends_on` (if any), one-line title, updated date. If the directory doesn't exist, say
so and suggest `new`.

## New

`args` may describe one point or several (a numbered/bulleted list, or several clearly distinct
goals in one message). One description is just the N=1 case of the same procedure below — nothing
changes about it. If it's genuinely unclear whether the user gave one nuanced description or
several intended items, treat it as one; don't guess-split.

For each described point, independently:

1. If the goal as stated is genuinely ambiguous (no clear "done" condition even loosely), note
   what needs asking — don't interrogate per-item.
2. Draft acceptance criteria: a short list of concrete, testable statements. Push back
   internally on anything not falsifiable (e.g. "make it nicer" isn't one; "the settings page
   loads in under 2s with 500 rows" is).
3. Slugify a short kebab-case name from the title; disambiguate with `-2`, `-3`, etc. against
   both existing `.claude/backlog/*.md` files and other items in this same batch.

Then, once every item has a draft:

4. If any item needed a clarifying question (step 1), ask all of them together in one message —
   not one round-trip per item — before drafting further on those specific items.
5. Run Sync first, then check every drafted item for overlap — against every other active point
   (status `tests-written`, `waiting`, or `in-progress`) *and* against every other item in this
   same batch — using the detection procedure in `references/dependencies.md`. Set `depends_on`
   accordingly and state each decision in one line; don't ask permission for the routine case.
6. Show every drafted title, its acceptance criteria, and any dependency decision together in one
   message, clearly separated per item, and get explicit confirmation or edits before writing
   anything — this is cheap to get right early and expensive to fix after tests are written
   against it. The user may approve all, approve some and edit or drop others — write backlog
   files only for the ones actually confirmed.
7. For each confirmed item, write `.claude/backlog/<slug>.md` per `references/backlog-format.md`,
   status `planned`. Do not write any tests or code in this step, for any item.

## Spec (red)

Only proceed from status `planned` (or `blocked`, if the user wants to redefine a stuck point —
confirm that's the intent first).

1. Read the point's acceptance criteria and the project's existing test setup (framework, test
   directory, naming conventions — check `CLAUDE.md`/`AGENTS.md` and existing tests, don't
   assume pytest/jest/etc.).
2. Write failing tests that encode each acceptance criterion — one test per criterion where
   practical. Write no implementation code in this step, not even a stub beyond what makes the
   test file itself importable.
3. Now that the actual code has been read to write these tests, re-run the dependency check from
   `references/dependencies.md` and correct `depends_on` if the coarse guess made at `new` time
   was wrong (missed a real overlap, or flagged one that isn't real). This is metadata, not the
   acceptance criteria — adjusting it doesn't reopen the "what does done mean" question.
4. Run the tests and show the failures to the user. Confirm each fails for the *right* reason
   (missing behavior), not an import error or typo — a test that fails for the wrong reason is
   worse than no test.
5. Present the test code to the user for review. Wait for explicit approval before committing —
   this is the human checkpoint the research calls out as non-negotiable. Do not skip it even in
   an otherwise unattended session; if running unattended (see Background), stop here and leave
   the point at `planned` with the draft tests in a note rather than auto-approving.
6. On approval: commit the test file(s) alone, in one commit, message noting they're
   pre-implementation tests for `<slug>` (no `Co-Authored-By` needed unless the project's own
   commit convention requires one). Update the backlog file: status `tests-written`, `tests:`
   field listing the committed test file paths, `attempts: 0`.

## Run (green)

Only proceed from status `tests-written`, `waiting`, or `in-progress`. If `blocked`, stop and
tell the user why rather than retrying blindly.

1. **Ceiling check, before anything else costs money:** if `schedule_backend` is set to anything
   (`app` or `github-actions` — not just when `schedule_task_id` happens to be set, since
   `github-actions` never sets that field), compare now against `schedule_created_at` +
   `max_background_hours` (see `references/cost-control.md`). Past the ceiling and still not
   terminal → this is a runaway, independent of whether `attempts` ever incremented (e.g. it's
   been sitting in `waiting` the whole time). Set status `blocked` with a note ("exceeded max
   background duration without reaching a terminal state — needs human review"), delete
   `schedule_task_id` if one is set, stop. This check itself must be a single cheap read of the
   backlog file's frontmatter — no codebase or test access yet.
2. **Concurrency guard:** fetch/pull the latest `main` first — this check is only meaningful
   against the shared remote state, not a possibly-stale local checkout. Then: if status is
   already `in-progress` and `updated` is within the last 30 minutes, stop — another invocation
   is very likely already working on this point. If `updated` is older than that, treat it as a
   crashed or interrupted run and resume it.
3. **Resolve the dependency**, per `references/dependencies.md`: this is also a cheap status-file
   read, not a reason to load the full codebase — do it before any expensive work. If `depends_on`
   is unset, branch off `main` as usual. If set, decide the branch base (main, or the dependency's
   own branch) — or, if the dependency isn't ready yet, set status to `waiting` and stop. A
   `waiting` exit consumes no attempt; it's a queue state, not a failure.
4. **Never edit the files listed in the point's `tests:` field.** This is the hard guardrail —
   see `references/workflow.md` for why. If the tests turn out to be wrong or ambiguous, stop and
   flag it to the user instead of "fixing" them yourself.
5. Delegate steps 6-8 to a fresh `Agent` call with `isolation: "worktree"`, on a branch named
   `point/<slug>` based on whatever step 3 resolved — always, not only for background/scheduled
   runs. This keeps the (possibly several file-reads-and-test-runs-deep) implement loop out of
   whatever session called `run`, whether that's an interactive session the user is actively
   using for something else or a background firing. See `references/context-control.md` for why
   this matters even for on-demand runs. Set status `in-progress` (with `updated` set to now) and
   **commit and push that single change to `main` immediately, before dispatching** — its own
   small commit, distinct from the point's eventual implementation commit. This is what makes the
   concurrency guard in step 2 actually visible to any other invocation (a different scheduled
   firing, or a separate interactive session) instead of only to this one's local checkout.
6. Inside that delegated call: run the failing tests first to reconfirm current state, then
   implement the minimal code to pass them, re-running after each change with the project's
   fast/quiet test invocation, not its verbose default — see `references/context-control.md`.
   Also run the project's lint/type-check if it has one — green tests with a broken lint gate
   isn't done.
7. Bound the effort: up to ~6 implement/test cycles inside that delegated call. If still red
   after that, go to the failure path below.
8. **Immediately before opening or updating the PR:** if the dependency base has moved since this
   branch was created (the dependency's branch got new commits, or it merged while this point was
   running), rebase onto the current tip and re-run tests. Don't open a PR against a stale base.
9. **On green:** commit, push, open a PR filled in exactly per `references/pr-template.md` — every
   section, not a subset. **If `mcp__ccd_pr__*` tools are available in this session** (true for the
   `app` backend and any interactive on-demand `run` — not true for a headless `claude -p`
   invocation inside the `github-actions` backend, which has no such tools), wire up CI auto-fix
   per `references/ci-monitoring.md`: `mcp__ccd_pr__set_monitor` with `auto_fix: true` on the new
   PR, never `mcp__ccd_pr__set_auto_merge`. When those tools aren't available, skip this step
   entirely rather than erroring — don't invent a substitute; see `references/ci-monitoring.md` for
   what that means for the `github-actions` backend specifically. Update the backlog file: status
   `done-pending-review`, `pr_url` set. If `schedule_task_id` is set, delete that scheduled task
   now — the point is done, it shouldn't keep firing.
10. **On repeated failure:** update status to `blocked`, write a clear, specific note in the
    backlog file (what's failing, what was tried, what looks wrong about the spec or the
    approach), increment `attempts`. If `attempts` reaches 5, also delete any
    `schedule_task_id` and tell the user directly rather than letting it fire again unattended.

## Background

Only from status `tests-written` or `waiting` (spec must already be reviewed and committed —
never schedule unattended runs against unreviewed tests). A `waiting` point can be backgrounded
too; it'll just keep checking its dependency each firing until it clears.

1. Ask which backend, if not already clear from context: **`app`** (default — fires via this
   app's own scheduler; requires the app running and the machine awake, pauses otherwise and
   catches up on next launch) or **`github-actions`** (fires on GitHub's runners, survives the
   laptop being asleep or closed, but is a bigger one-time setup — see
   `references/github-actions.md`). The `github-actions` backend works continuously through a
   configured night window (back to back, one point after another, until nothing's eligible, the
   window ends, or a real usage/rate limit is hit — not a self-imposed spend cap, see
   `references/github-actions.md` for why there deliberately isn't one) and stays off outside
   that window unless manually triggered or a toggle (a GitHub issue, openable from the phone
   app) is switched on. Record the choice as `schedule_backend`.
2. Count how many other backlog files already have background scheduling active (`schedule_backend:
   app` with a `schedule_task_id` set, or `schedule_backend: github-actions`). At 3 or more, warn
   the user before adding another ("N points are already running in the background — add a
   fourth?") rather than silently letting concurrent background spend grow unbounded. Proceed on
   confirmation.
3. Ask the user for a cadence if not given (suggest something like "every 3 hours" as a
   starting default — background runs cost tokens each firing, so don't default to anything
   tight; see `references/cost-control.md` for how cadence, cycle bounds, and duration interact).
   For `github-actions`, there's no per-point cadence to set — the workflow's own night
   window/toggle design (`references/github-actions.md`) governs all points on that backend at
   once; skip this question for that backend.
4. Ask for a max background duration if not given (default 48 hours) — the hard ceiling `run`
   checks on every firing regardless of `attempts`. Record it as `max_background_hours`, and
   record `schedule_created_at` as now.
5. **If `app`:** invoke the `schedule` skill to create a recurring cloud-scheduled task whose
   prompt is `/point run <slug>` against this repo's path. Store the resulting task id in the
   backlog file's `schedule_task_id` field.
   **If `github-actions`:** follow `references/github-actions.md` — confirm the one-time repo
   setup is done (GitHub app installed, `CLAUDE_CODE_OAUTH_TOKEN` secret set, the workflow file
   present, `.claude/skills/point/` synced into the repo), walking the user through whatever part
   is missing rather than assuming it's already there. No per-point task id to store — one
   workflow serves every `github-actions`-backed point in the repo.
6. Tell the user it will keep firing until the point reaches `done-pending-review` or `blocked`
   (including hitting the duration ceiling), and that they can check progress any time with
   `/point status <slug>`.

## Additional resources

- **`references/backlog-format.md`** — exact frontmatter schema and status values for backlog
  files.
- **`references/workflow.md`** — the reasoning behind the test/implementation separation, the
  no-edit-tests guardrail, dependency stacking, and cleanup.
- **`references/dependencies.md`** — the exact procedure for detecting overlap between points and
  resolving branch bases, including the rebase-and-retest cascade.
- **`references/pr-template.md`** — the structured PR body template; fill it in completely, every
  time.
- **`references/ci-monitoring.md`** — how to wire up CI auto-fix on an opened PR and what to do
  when it fires.
- **`references/cost-control.md`** — every bound on spend in this skill (attempts, per-run cycle
  cap, background duration ceiling, concurrent-background cap) in one place, and how to tune them.
- **`references/context-control.md`** — why context doesn't accumulate across firings, and the two
  places it can still build up within one, plus the concrete fix for each.
- **`references/github-actions.md`** — the `github-actions` background backend: one-time repo
  setup, the night-window continuous loop and daytime toggle, real-rate-limit-as-stop-signal
  instead of a self-imposed budget, and what it actually guarantees versus the `app` backend.
