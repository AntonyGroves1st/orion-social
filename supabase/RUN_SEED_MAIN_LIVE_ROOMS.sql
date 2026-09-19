-- Standalone seed for SQL Editor (no \ir). Paste entire file into Dashboard → SQL.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS live_category TEXT;

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

CREATE OR REPLACE FUNCTION public.reset_and_seed_main_live_rooms(p_admin_secret TEXT DEFAULT NULL)
RETURNS TABLE(out_category TEXT, out_room_id UUID, out_title TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  row RECORD;
  new_id UUID;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND COALESCE(p_admin_secret, '') <> 'orion-main-rooms-2026' THEN
    RAISE EXCEPTION 'Not authorized to reset main live rooms';
  END IF;

  DELETE FROM public.webrtc_signals AS ws
  WHERE ws.room_id ~ '^[0-9a-fA-F-]{36}$'
    AND ws.room_id::uuid IN (SELECT c.id FROM public.conversations AS c WHERE c.kind = 'live');

  DELETE FROM public.conversations WHERE kind = 'live';

  FOR row IN
    SELECT *
    FROM (
      VALUES
        ('sports',    'Sports'),
        ('shopping',  'Shopping'),
        ('tech',      'Tech'),
        ('general',   'General'),
        ('news',      'News'),
        ('truth',     'Truth'),
        ('community', 'Community'),
        ('music',     'Music'),
        ('gaming',    'Gaming'),
        ('culture',   'Culture')
    ) AS t(cat, label)
  LOOP
    INSERT INTO public.conversations (
      kind, title, live_listed, live_category, creator_id,
      mods_enabled, live_cam_count, live_stage_slots
    )
    VALUES (
      'live', row.label, true, row.cat, NULL, true, 2, '[]'::jsonb
    )
    RETURNING id INTO new_id;

    out_category := row.cat;
    out_title := row.label;
    out_room_id := new_id;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_and_seed_main_live_rooms(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_and_seed_main_live_rooms(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reset_and_seed_main_live_rooms(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.reset_and_seed_main_live_rooms(TEXT) TO authenticated;

SELECT out_category AS category, out_room_id AS room_id, out_title AS title
FROM public.reset_and_seed_main_live_rooms('orion-main-rooms-2026')
ORDER BY out_category;
