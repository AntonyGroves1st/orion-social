-- Missing from earlier migrations: ban_live_member + host reclaim on rejoin.
-- Safe to re-run (CREATE OR REPLACE / IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS public.live_room_bans (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  banned_by UUID NOT NULL REFERENCES auth.users(id),
  banned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

ALTER TABLE public.live_room_bans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS live_room_bans_host_read ON public.live_room_bans;
CREATE POLICY live_room_bans_host_read ON public.live_room_bans
  FOR SELECT TO authenticated
  USING (public.is_live_host(conversation_id));

CREATE OR REPLACE FUNCTION public.ban_live_member(p_conversation_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  target_role TEXT := public.room_member_role(p_conversation_id, p_user_id);
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_live_host(p_conversation_id) THEN
    RAISE EXCEPTION 'Only the room admin can ban members';
  END IF;
  IF target_role = 'host' THEN
    RAISE EXCEPTION 'Cannot ban the host';
  END IF;
  DELETE FROM public.conversation_members
  WHERE conversation_id = p_conversation_id AND user_id = p_user_id;
  INSERT INTO public.live_room_bans (conversation_id, user_id, banned_by)
  VALUES (p_conversation_id, p_user_id, me)
  ON CONFLICT (conversation_id, user_id) DO UPDATE
    SET banned_by = EXCLUDED.banned_by,
        banned_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.ban_live_member(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ban_live_member(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.purge_live_room_chat_and_cache(p_conversation_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rid TEXT := p_conversation_id::text;
BEGIN
  IF p_conversation_id IS NULL THEN RETURN; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = p_conversation_id AND c.kind = 'live'
  ) THEN
    RETURN;
  END IF;

  DELETE FROM public.messages
  WHERE conversation_id = p_conversation_id;

  DELETE FROM public.webrtc_signals
  WHERE room_id = rid;

  BEGIN
    DELETE FROM public.live_like_events
    WHERE conversation_id = p_conversation_id;
  EXCEPTION
    WHEN undefined_table THEN NULL;
  END;

  UPDATE public.conversations
  SET live_stage_slots = '[]'::jsonb
  WHERE id = p_conversation_id AND kind = 'live';
END;
$$;

REVOKE ALL ON FUNCTION public.purge_live_room_chat_and_cache(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_live_room_chat_and_cache(UUID) TO authenticated;

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
  other_id UUID;
  room_creator UUID;
  has_host BOOLEAN;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT c.live_listed, c.creator_id
    INTO listed, room_creator
  FROM public.conversations c
  WHERE c.id = p_conversation_id AND c.kind = 'live';

  IF listed IS NULL THEN RAISE EXCEPTION 'Live room not found'; END IF;
  IF NOT listed THEN RAISE EXCEPTION 'This live room is not listed'; END IF;

  FOR other_id IN
    SELECT cm.conversation_id
    FROM public.conversation_members cm
    JOIN public.conversations c ON c.id = cm.conversation_id
    WHERE cm.user_id = me
      AND c.kind = 'live'
      AND c.live_listed = true
      AND cm.conversation_id <> p_conversation_id
  LOOP
    BEGIN
      PERFORM public.leave_live_room(other_id);
    EXCEPTION
      WHEN OTHERS THEN NULL;
    END;
  END LOOP;

  SELECT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE conversation_id = p_conversation_id
      AND lower(coalesce(role, '')) = 'host'
  ) INTO has_host;

  IF EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE conversation_id = p_conversation_id AND user_id = me
  ) THEN
    UPDATE public.conversation_members
    SET last_active_at = now()
    WHERE conversation_id = p_conversation_id AND user_id = me;

    IF room_creator = me OR NOT has_host THEN
      UPDATE public.conversation_members
      SET role = 'member'
      WHERE conversation_id = p_conversation_id
        AND lower(coalesce(role, '')) = 'host'
        AND user_id <> me;

      UPDATE public.conversation_members
      SET role = 'host'
      WHERE conversation_id = p_conversation_id AND user_id = me;

      UPDATE public.conversations
      SET creator_id = me
      WHERE id = p_conversation_id AND kind = 'live'
        AND (creator_id IS NULL OR creator_id = me OR NOT has_host);
    END IF;

    UPDATE public.profiles SET last_seen_at = now() WHERE id = me;
    RETURN;
  END IF;

  SELECT COUNT(*)::int INTO member_count
  FROM public.conversation_members
  WHERE conversation_id = p_conversation_id;

  IF member_count >= 8 THEN RAISE EXCEPTION 'Room is full (max 8)'; END IF;

  IF member_count = 0 OR room_creator = me OR NOT has_host THEN
    IF member_count > 0 AND (room_creator = me OR NOT has_host) THEN
      UPDATE public.conversation_members
      SET role = 'member'
      WHERE conversation_id = p_conversation_id
        AND lower(coalesce(role, '')) = 'host'
        AND user_id <> me;
    END IF;

    INSERT INTO public.conversation_members (conversation_id, user_id, role, last_active_at)
    VALUES (p_conversation_id, me, 'host', now());

    UPDATE public.conversations
    SET creator_id = me,
        live_stage_slots = CASE
          WHEN live_stage_slots = '[]'::jsonb OR live_stage_slots IS NULL
            THEN jsonb_build_array(me::text, null)
          ELSE live_stage_slots
        END,
        live_cam_count = CASE
          WHEN live_cam_count IS NULL OR live_cam_count < 2 THEN 2
          ELSE live_cam_count
        END
    WHERE id = p_conversation_id AND kind = 'live';

    UPDATE public.profiles SET last_seen_at = now() WHERE id = me;
    RETURN;
  END IF;

  INSERT INTO public.conversation_members (conversation_id, user_id, role, last_active_at)
  VALUES (p_conversation_id, me, 'member', now());

  UPDATE public.profiles SET last_seen_at = now() WHERE id = me;
END;
$$;

REVOKE ALL ON FUNCTION public.join_live_room(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_live_room(UUID) TO authenticated;
