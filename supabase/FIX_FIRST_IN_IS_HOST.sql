-- Run in Supabase Dashboard → SQL Editor.
-- Empty listed live room: first joiner becomes host + gets stage slot 1.

CREATE OR REPLACE FUNCTION public.join_live_room(p_conversation_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  listed BOOLEAN;
  member_count INT;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT c.live_listed INTO listed
  FROM public.conversations c
  WHERE c.id = p_conversation_id AND c.kind = 'live';

  IF listed IS NULL THEN RAISE EXCEPTION 'Live room not found'; END IF;
  IF NOT listed THEN RAISE EXCEPTION 'This live room is not listed'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE conversation_id = p_conversation_id AND user_id = me
  ) THEN
    RETURN;
  END IF;

  SELECT COUNT(*)::int INTO member_count
  FROM public.conversation_members
  WHERE conversation_id = p_conversation_id;

  IF member_count >= 8 THEN RAISE EXCEPTION 'Room is full (max 8)'; END IF;

  IF member_count = 0 THEN
    INSERT INTO public.conversation_members (conversation_id, user_id, role)
    VALUES (p_conversation_id, me, 'host');

    UPDATE public.conversations
    SET creator_id = me,
        live_stage_slots = CASE
          WHEN live_stage_slots = '[]'::jsonb OR live_stage_slots IS NULL
            THEN jsonb_build_array(me::text, null)
          ELSE live_stage_slots
        END
    WHERE id = p_conversation_id AND kind = 'live';

    RETURN;
  END IF;

  INSERT INTO public.conversation_members (conversation_id, user_id, role)
  VALUES (p_conversation_id, me, 'member');
END;
$$;

REVOKE ALL ON FUNCTION public.join_live_room(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_live_room(UUID) TO authenticated;
