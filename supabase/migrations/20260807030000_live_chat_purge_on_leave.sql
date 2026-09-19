-- Live room chat destruction + WebRTC cache cleanup on leave / empty room.
-- Run in Supabase SQL Editor (or: npm run db:live-chat-purge)
--
-- Rules:
-- 1) Regular member leaves  → delete THEIR messages in that live + their signal cache
-- 2) Host/mod (admin) leaves while others still live → keep their chat (do NOT wipe admins mid-live)
-- 3) Room becomes empty     → destroy ALL chat + ALL signal cache for that live room
-- 4) Never touches DM / non-live conversations

-- ── Helpers ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purge_live_user_signal_cache(
  p_conversation_id UUID,
  p_user_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INT := 0;
  rid TEXT := p_conversation_id::text;
BEGIN
  IF p_conversation_id IS NULL OR p_user_id IS NULL THEN
    RETURN 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = p_conversation_id AND c.kind = 'live'
  ) THEN
    RETURN 0;
  END IF;

  DELETE FROM public.webrtc_signals ws
  WHERE ws.room_id = rid
    AND (
      ws.sender_id = p_user_id
      OR (ws.payload ? 'to' AND ws.payload->>'to' = p_user_id::text)
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_live_user_signal_cache(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_live_user_signal_cache(UUID, UUID) TO authenticated;

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
  SET creator_id = NULL,
      live_stage_slots = '[]'::jsonb
  WHERE id = p_conversation_id AND kind = 'live';
END;
$$;

REVOKE ALL ON FUNCTION public.purge_live_room_chat_and_cache(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_live_room_chat_and_cache(UUID) TO authenticated;

-- ── leave_live_room ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.leave_live_room(p_conversation_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  my_role TEXT := '';
  was_admin BOOLEAN := false;
  remaining INT;
  next_host UUID;
  slots JSONB;
  is_live BOOLEAN := false;
  need_host BOOLEAN := false;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT (c.kind = 'live') INTO is_live
  FROM public.conversations c
  WHERE c.id = p_conversation_id;

  IF is_live IS DISTINCT FROM TRUE THEN
    RETURN;
  END IF;

  SELECT lower(coalesce(role, '')) INTO my_role
  FROM public.conversation_members
  WHERE conversation_id = p_conversation_id AND user_id = me;

  IF NOT FOUND THEN
    PERFORM public.purge_live_user_signal_cache(p_conversation_id, me);
    UPDATE public.conversations c
    SET creator_id = CASE WHEN c.creator_id = me THEN NULL ELSE c.creator_id END,
        live_stage_slots = CASE
          WHEN c.live_stage_slots IS NULL THEN '[]'::jsonb
          ELSE (
            SELECT coalesce(jsonb_agg(
              CASE WHEN elem = to_jsonb(me::text) THEN 'null'::jsonb ELSE elem END
            ), '[]'::jsonb)
            FROM jsonb_array_elements(c.live_stage_slots) AS elem
          )
        END
    WHERE c.id = p_conversation_id AND c.kind = 'live';

    IF NOT EXISTS (
      SELECT 1 FROM public.conversation_members WHERE conversation_id = p_conversation_id
    ) THEN
      PERFORM public.purge_live_room_chat_and_cache(p_conversation_id);
    END IF;
    RETURN;
  END IF;

  was_admin := my_role IN ('host', 'moderator');

  DELETE FROM public.conversation_members
  WHERE conversation_id = p_conversation_id AND user_id = me;

  /* Always clean THIS user's WebRTC / mesh cache on every exit. */
  PERFORM public.purge_live_user_signal_cache(p_conversation_id, me);

  /*
   * Chat destruction per user on leave:
   * - Members: delete their live messages now
   * - Admins (host/mod) while room still live: KEEP their messages
   */
  IF NOT was_admin THEN
    DELETE FROM public.messages
    WHERE conversation_id = p_conversation_id
      AND sender_id = me;
  END IF;

  SELECT live_stage_slots INTO slots
  FROM public.conversations
  WHERE id = p_conversation_id AND kind = 'live';

  IF slots IS NOT NULL AND jsonb_typeof(slots) = 'array' THEN
    UPDATE public.conversations
    SET live_stage_slots = (
      SELECT coalesce(jsonb_agg(
        CASE WHEN elem = to_jsonb(me::text) THEN 'null'::jsonb ELSE elem END
      ), '[]'::jsonb)
      FROM jsonb_array_elements(slots) AS elem
    )
    WHERE id = p_conversation_id AND kind = 'live';
  END IF;

  SELECT COUNT(*)::int INTO remaining
  FROM public.conversation_members
  WHERE conversation_id = p_conversation_id;

  IF remaining = 0 THEN
    /* Room empty → destroy ALL chat + cache (including leftover admin messages). */
    PERFORM public.purge_live_room_chat_and_cache(p_conversation_id);
    RETURN;
  END IF;

  need_host := (my_role = 'host') OR NOT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE conversation_id = p_conversation_id AND lower(coalesce(role, '')) = 'host'
  );

  IF need_host THEN
    SELECT user_id INTO next_host
    FROM public.conversation_members
    WHERE conversation_id = p_conversation_id
    ORDER BY joined_at ASC NULLS LAST, user_id ASC
    LIMIT 1;

    IF next_host IS NOT NULL THEN
      UPDATE public.conversation_members
      SET role = 'host'
      WHERE conversation_id = p_conversation_id AND user_id = next_host;

      UPDATE public.conversations
      SET creator_id = next_host
      WHERE id = p_conversation_id AND kind = 'live';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.leave_live_room(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.leave_live_room(UUID) TO authenticated;

-- One-shot: empty live rooms that still have leftover chat / signals
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.id
    FROM public.conversations c
    WHERE c.kind = 'live'
      AND NOT EXISTS (
        SELECT 1 FROM public.conversation_members cm WHERE cm.conversation_id = c.id
      )
      AND (
        EXISTS (SELECT 1 FROM public.messages m WHERE m.conversation_id = c.id)
        OR EXISTS (SELECT 1 FROM public.webrtc_signals ws WHERE ws.room_id = c.id::text)
      )
  LOOP
    PERFORM public.purge_live_room_chat_and_cache(r.id);
  END LOOP;
END $$;
