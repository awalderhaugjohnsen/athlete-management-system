-- 049: Athlete-facing opt-in for more than one session per calendar day.
--
-- services/scheduling/solver.py has supported allow_multi_session_days=True since the
-- multi-session-per-day scheduling work (see its module docstring and
-- tests/test_program_spec_solver.py::TestMultiSessionPerDay) — solver-shape-safe (it does not
-- force doubling up sessions; a spec with no day_pins targeting multiple slots on one date can
-- still solve to the old one-session-per-day shape) but never exposed anywhere. Off by default
-- so nobody's schedule shape changes until they opt in from the setup page.
--
-- season_planner_node.py reads this and threads it into the ProgramSpec it authors; the
-- check-in path (fetch_checkin_context/compute_checkin_fixed_days) was made slot-aware in the
-- same change so an already-committed session doesn't become a whole-day pin that blocks a
-- second session landing on that date once this is on.

ALTER TABLE athlete_profile
  ADD COLUMN IF NOT EXISTS allow_multi_session_days boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN athlete_profile.allow_multi_session_days IS
  'Athlete opt-in: when true, the season planner authors a ProgramSpec with allow_multi_session_days=true, letting the solver place more than one session on a calendar day (morning/midday/afternoon/evening). Off by default — every athlete who has not explicitly turned this on keeps exactly one session/day.';
