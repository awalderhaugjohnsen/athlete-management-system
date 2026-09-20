-- 048: Chat tab history.
--
-- New feature: a Chat tab where the athlete can ask their AI coach open-ended
-- questions ("why are we doing it this way", stats/trends/readiness) instead of
-- being limited to the structured dashboard/plan views. This table is the
-- persisted transcript for that feature — one continuous history per athlete,
-- matching an ongoing coaching relationship rather than per-session tickets, so
-- there is no conversation_id. Only final user/assistant text is stored; the
-- intermediate tool-call round trips a single answer makes are scaffolding, not
-- part of the readable transcript, and are not persisted.

CREATE TABLE chat_messages (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own chat messages"
  ON chat_messages FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- The chat API route runs server-side under the service-role client (web/lib/supabase-server.ts)
-- and is the only writer; RLS above covers any future direct client-side reads.
GRANT SELECT, INSERT ON public.chat_messages TO service_role;
GRANT SELECT ON public.chat_messages TO authenticated;

CREATE INDEX chat_messages_user_id_created_at_idx ON chat_messages (user_id, created_at);
