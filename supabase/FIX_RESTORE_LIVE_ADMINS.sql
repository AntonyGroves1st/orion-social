-- RESTORE live hosts + stop chat cleanup from wiping admins/layouts.
-- Run whole file in Supabase SQL Editor (postgres / SQL Editor).
--
-- What went wrong:
--   FIX_FULL_CLEAN_MESSAGES + purge_live_room_chat_and_cache + empty-room leave
--   cleared creator_id and live_stage_slots. Ghost scrub also deleted memberships.
--   Without host → layout pills hidden → “layouts gone” + “admins lost”.
--
-- This does NOT recreate old moderator promotions (those rows are gone).
-- Hosts can re-promote mods after reclaim.

-- ── 1) Chat/cache purge must NEVER wipe room owner or permanent layout meta ───
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

  /* Chat only — KEEP creator_id (admin) and live_cam_count. Clear people off stage. */
  UPDATE public.conversations
  SET live_stage_slots = '[]'::jsonb
  WHERE id = p_conversation_id AND kind = 'live';
END;
$$;

REVOKE ALL ON FUNCTION public.purge_live_room_chat_and_cache(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_live_room_chat_and_cache(UUID) TO authenticated;

-- ── 2) join_live_room: reclaim host if you are creator / room has no host ────
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

  /* Leave other listed lives so Friends Live stays accurate. */
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

    /* Reclaim admin: room owner, or nobody is host. */
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

-- ── 3) leave empty room: keep creator on permanent category map rooms ────────
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
  keep_creator BOOLEAN := false;
  room_creator UUID;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT (c.kind = 'live'),
         (c.live_category IS NOT NULL AND length(trim(c.live_category)) > 0),
         c.creator_id
    INTO is_live, keep_creator, room_creator
  FROM public.conversations c
  WHERE c.id = p_conversation_id;

  IF is_live IS DISTINCT FROM TRUE THEN
    RETURN;
  END IF;

  SELECT lower(coalesce(role, '')) INTO my_role
  FROM public.conversation_members
  WHERE conversation_id = p_conversation_id AND user_id = me;

  IF NOT FOUND THEN
    BEGIN
      PERFORM public.purge_live_user_signal_cache(p_conversation_id, me);
    EXCEPTION
      WHEN undefined_function THEN NULL;
    END;
    UPDATE public.conversations c
    SET creator_id = CASE
          WHEN keep_creator THEN c.creator_id
          WHEN c.creator_id = me THEN NULL
          ELSE c.creator_id
        END,
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
      BEGIN
        PERFORM public.purge_live_room_chat_and_cache(p_conversation_id);
      EXCEPTION
        WHEN undefined_function THEN NULL;
      END;
    END IF;
    RETURN;
  END IF;

  was_admin := my_role IN ('host', 'moderator');

  DELETE FROM public.conversation_members
  WHERE conversation_id = p_conversation_id AND user_id = me;

  BEGIN
    PERFORM public.purge_live_user_signal_cache(p_conversation_id, me);
  EXCEPTION
    WHEN undefined_function THEN NULL;
  END;

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
    BEGIN
      PERFORM public.purge_live_room_chat_and_cache(p_conversation_id);
    EXCEPTION
      WHEN undefined_function THEN
        UPDATE public.conversations
        SET live_stage_slots = '[]'::jsonb
        WHERE id = p_conversation_id AND kind = 'live';
    END;
    /* Permanent map rooms keep owner so they reclaim host on return. */
    IF NOT keep_creator THEN
      UPDATE public.conversations
      SET creator_id = NULL
      WHERE id = p_conversation_id AND kind = 'live';
    ELSIF room_creator IS NULL THEN
      UPDATE public.conversations
      SET creator_id = me
      WHERE id = p_conversation_id AND kind = 'live' AND creator_id IS NULL;
    END IF;
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
    ORDER BY
      CASE WHEN user_id = room_creator THEN 0 ELSE 1 END,
      joined_at ASC NULLS LAST,
      user_id ASC
    LIMIT 1;

    IF next_host IS NOT NULL THEN
      UPDATE public.conversation_members
      SET role = 'host'
      WHERE conversation_id = p_conversation_id AND user_id = next_host;

      UPDATE public.conversations
      SET creator_id = next_host
      WHERE id = p_conversation_id AND kind = 'live'
        AND (creator_id IS NULL OR my_role = 'host');
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.leave_live_room(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.leave_live_room(UUID) TO authenticated;

-- ── 4) One-shot restore: hosts from creator_id + rooms missing a host ────────
UPDATE public.conversation_members cm
SET role = 'host'
FROM public.conversations c
WHERE c.id = cm.conversation_id
  AND c.kind = 'live'
  AND c.creator_id IS NOT NULL
  AND cm.user_id = c.creator_id
  AND lower(coalesce(cm.role, '')) <> 'host';

/* Demote duplicate hosts — keep creator, else oldest */
WITH ranked AS (
  SELECT
    cm.ctid,
    row_number() OVER (
      PARTITION BY cm.conversation_id
      ORDER BY
        CASE WHEN cm.user_id = c.creator_id THEN 0 ELSE 1 END,
        CASE WHEN lower(coalesce(cm.role, '')) = 'host' THEN 0 ELSE 1 END,
        cm.joined_at ASC NULLS LAST,
        cm.user_id ASC
    ) AS rn
  FROM public.conversation_members cm
  JOIN public.conversations c ON c.id = cm.conversation_id
  WHERE c.kind = 'live'
    AND lower(coalesce(cm.role, '')) = 'host'
)
UPDATE public.conversation_members cm
SET role = 'member'
FROM ranked r
WHERE cm.ctid = r.ctid AND r.rn > 1;

/* Rooms with people but no host → promote best candidate + set creator */
WITH need AS (
  SELECT c.id AS conversation_id
  FROM public.conversations c
  WHERE c.kind = 'live'
    AND EXISTS (
      SELECT 1 FROM public.conversation_members cm WHERE cm.conversation_id = c.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.conversation_members cm
      WHERE cm.conversation_id = c.id AND lower(coalesce(cm.role, '')) = 'host'
    )
),
pick AS (
  SELECT DISTINCT ON (cm.conversation_id)
    cm.conversation_id,
    cm.user_id
  FROM public.conversation_members cm
  JOIN need n ON n.conversation_id = cm.conversation_id
  JOIN public.conversations c ON c.id = cm.conversation_id
  ORDER BY
    cm.conversation_id,
    CASE WHEN cm.user_id = c.creator_id THEN 0 ELSE 1 END,
    cm.joined_at ASC NULLS LAST,
    cm.user_id ASC
)
UPDATE public.conversation_members cm
SET role = 'host'
FROM pick p
WHERE cm.conversation_id = p.conversation_id AND cm.user_id = p.user_id;

UPDATE public.conversations c
SET creator_id = p.user_id
FROM (
  SELECT cm.conversation_id, cm.user_id
  FROM public.conversation_members cm
  WHERE lower(coalesce(cm.role, '')) = 'host'
) p
WHERE c.id = p.conversation_id
  AND c.kind = 'live'
  AND c.creator_id IS NULL;

/* Broken empty stage arrays → default 2-cam layout capacity */
UPDATE public.conversations
SET live_cam_count = GREATEST(2, LEAST(8, coalesce(live_cam_count, 2)))
WHERE kind = 'live'
  AND (live_cam_count IS NULL OR live_cam_count < 2 OR live_cam_count > 8);

-- ── 5) Verify ────────────────────────────────────────────────────────────────
SELECT
  c.id,
  c.title,
  c.live_category,
  c.creator_id,
  c.live_cam_count,
  (SELECT count(*) FROM public.conversation_members cm WHERE cm.conversation_id = c.id) AS members,
  (SELECT count(*) FROM public.conversation_members cm
   WHERE cm.conversation_id = c.id AND lower(coalesce(cm.role, '')) = 'host') AS hosts,
  (SELECT count(*) FROM public.conversation_members cm
   WHERE cm.conversation_id = c.id AND lower(coalesce(cm.role, '')) = 'moderator') AS mods
FROM public.conversations c
WHERE c.kind = 'live' AND c.live_listed = true
ORDER BY c.live_category NULLS LAST, c.title;
