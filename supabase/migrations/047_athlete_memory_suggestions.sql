-- 047: Pending suggestions queue for athlete_memory.
--
-- Reported bug: a fact mentioned in a check-in comment (e.g. "I've been getting shin
-- splints") had no effect on any later check-in — athlete_profile's setup-time fields
-- were always re-read correctly (see build_planning_context), but anything typed into
-- a check-in comment was only ever folded into that single replan's prompt and then
-- discarded. athlete_memory (009/022) was built to be the durable, evolving store for
-- exactly this, but nothing wrote check-in facts into it.
--
-- This does NOT wire check-in extraction straight into athlete_memory: an LLM's read of
-- a free-text comment is a guess, and Adrian asked to be asked before anything is saved
-- to his profile. So extracted candidates land here first, pending review, and only
-- move into athlete_memory (via the existing upsert_athlete_memory RPC) once confirmed
-- from the dashboard. Keeping this as a separate table rather than a status column on
-- athlete_memory avoids a pending guess ever colliding with — and momentarily
-- overwriting — an already-confirmed row under the same (user_id, category, key).

CREATE TABLE athlete_memory_suggestions (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category       TEXT NOT NULL,
  key            TEXT NOT NULL,
  value          TEXT NOT NULL,
  source_note    TEXT,
  replan_job_id  UUID REFERENCES replan_jobs(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
  created_at     TIMESTAMPTZ DEFAULT now(),
  resolved_at    TIMESTAMPTZ
);

ALTER TABLE athlete_memory_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own memory suggestions"
  ON athlete_memory_suggestions FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Service role writes suggestions (pipeline) and the web app reads/resolves them.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.athlete_memory_suggestions TO service_role;
GRANT SELECT, UPDATE ON public.athlete_memory_suggestions TO authenticated;

CREATE INDEX athlete_memory_suggestions_pending ON athlete_memory_suggestions (user_id, status);

COMMENT ON COLUMN athlete_memory_suggestions.source_note IS
  'The check-in comment this suggestion was extracted from, shown to the athlete for context when reviewing.';
COMMENT ON COLUMN athlete_memory_suggestions.status IS
  'pending: awaiting athlete review. accepted: upserted into athlete_memory. dismissed: athlete declined it — never re-surfaced automatically.';
