-- Live room likes: log every like (batched deltas OK) + rank hosts by likes received.

CREATE TABLE IF NOT EXISTS public.live_like_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  from_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  from_display_name TEXT NOT NULL DEFAULT '',
  to_display_name TEXT NOT NULL DEFAULT '',
  room_title_snapshot TEXT NOT NULL DEFAULT '',
  delta INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (delta > 0)
);

CREATE INDEX IF NOT EXISTS live_like_events_to_user_idx
  ON public.live_like_events(to_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS live_like_events_from_user_idx
  ON public.live_like_events(from_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS live_like_events_session_idx
  ON public.live_like_events(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS live_like_events_feed_idx
  ON public.live_like_events(created_at DESC);

ALTER TABLE public.live_like_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "live_like_events_select_authed" ON public.live_like_events;
CREATE POLICY "live_like_events_select_authed"
  ON public.live_like_events FOR SELECT TO authenticated
  USING (true);

CREATE OR REPLACE FUNCTION public.record_live_likes(
  p_conversation_id UUID,
  p_delta INTEGER DEFAULT 1
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  from_name TEXT;
  to_id UUID;
  to_name TEXT;
  room_title TEXT;
  event_id UUID;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_conversation_id IS NULL THEN RAISE EXCEPTION 'Missing room'; END IF;
  IF COALESCE(p_delta, 0) <= 0 THEN RAISE EXCEPTION 'Bad delta'; END IF;
  IF p_delta > 500 THEN RAISE EXCEPTION 'Delta too large'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE conversation_id = p_conversation_id AND user_id = me
  ) THEN
    RAISE EXCEPTION 'Not a room member';
  END IF;

  SELECT COALESCE(title, ''), creator_id
  INTO room_title, to_id
  FROM public.conversations
  WHERE id = p_conversation_id AND kind = 'live';

  IF NOT FOUND THEN RAISE EXCEPTION 'Live room not found'; END IF;

  IF to_id IS NULL THEN
    SELECT user_id INTO to_id
    FROM public.conversation_members
    WHERE conversation_id = p_conversation_id AND role = 'host'
    ORDER BY joined_at NULLS LAST, user_id
    LIMIT 1;
  END IF;

  IF to_id IS NULL THEN
    SELECT user_id INTO to_id
    FROM public.conversation_members
    WHERE conversation_id = p_conversation_id
    ORDER BY joined_at NULLS LAST, user_id
    LIMIT 1;
  END IF;

  IF to_id IS NULL THEN RAISE EXCEPTION 'No host to credit'; END IF;

  SELECT display_name INTO from_name FROM public.profiles WHERE id = me;
  SELECT display_name INTO to_name FROM public.profiles WHERE id = to_id;

  IF from_name IS NULL THEN RAISE EXCEPTION 'Profile not found'; END IF;

  INSERT INTO public.live_like_events (
    conversation_id,
    from_user_id,
    to_user_id,
    from_display_name,
    to_display_name,
    room_title_snapshot,
    delta
  )
  VALUES (
    p_conversation_id,
    me,
    to_id,
    from_name,
    COALESCE(to_name, ''),
    COALESCE(room_title, ''),
    p_delta
  )
  RETURNING id INTO event_id;

  RETURN event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_live_likes(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_live_likes(UUID, INTEGER) TO authenticated;

DO $pub$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'live_like_events'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.live_like_events';
    END IF;
  END IF;
END
$pub$;

NOTIFY pgrst, 'reload schema';
