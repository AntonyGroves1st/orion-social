-- Live room host / moderator roles + host-controlled stage layout.
-- Run in Supabase SQL Editor if not using CLI migrate.

ALTER TABLE public.conversation_members
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('host', 'moderator', 'member'));

ALTER TABLE public.conversation_members
  ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS mods_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS live_cam_count INTEGER NOT NULL DEFAULT 2
    CHECK (live_cam_count >= 2 AND live_cam_count <= 8);

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS live_stage_slots JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.conversation_members.role IS
  'live room: host (room owner), moderator (when mods_enabled), member (guest viewer/participant)';

-- Backfill host from creator_id
UPDATE public.conversation_members cm
SET role = 'host'
FROM public.conversations c
WHERE c.id = cm.conversation_id
  AND c.kind = 'live'
  AND c.creator_id IS NOT NULL
  AND cm.user_id = c.creator_id
  AND cm.role <> 'host';

-- Rooms without creator_id: first member by joined_at becomes host
UPDATE public.conversation_members cm
SET role = 'host'
FROM (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    user_id
  FROM public.conversation_members
  ORDER BY conversation_id, joined_at ASC NULLS LAST, user_id ASC
) first_m
JOIN public.conversations c ON c.id = first_m.conversation_id
WHERE cm.conversation_id = first_m.conversation_id
  AND cm.user_id = first_m.user_id
  AND c.kind = 'live'
  AND c.creator_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.conversation_members x
    WHERE x.conversation_id = cm.conversation_id AND x.role = 'host'
  );

CREATE OR REPLACE FUNCTION public.room_member_role(p_conversation_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT cm.role FROM public.conversation_members cm
     WHERE cm.conversation_id = p_conversation_id AND cm.user_id = p_user_id),
    'member'
  );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_live_room(p_conversation_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.conversation_members cm
    JOIN public.conversations c ON c.id = cm.conversation_id
    WHERE cm.conversation_id = p_conversation_id
      AND cm.user_id = p_user_id
      AND c.kind = 'live'
      AND (
        cm.role = 'host'
        OR (cm.role = 'moderator' AND c.mods_enabled = true)
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.is_live_host(p_conversation_id UUID, p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.room_member_role(p_conversation_id, p_user_id) = 'host';
$$;

REVOKE ALL ON FUNCTION public.room_member_role(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.room_member_role(UUID, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.can_manage_live_room(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_live_room(UUID, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.is_live_host(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_live_host(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_live_room(display_title TEXT DEFAULT 'Live')
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  cid UUID;
  t TEXT := COALESCE(trim(display_title), 'Live');
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF length(t) < 1 THEN t := 'Live'; END IF;

  INSERT INTO public.conversations (kind, title, live_listed, creator_id, mods_enabled, live_cam_count, live_stage_slots)
  VALUES ('live', t, true, me, true, 2, jsonb_build_array(me::text, null))
  RETURNING id INTO cid;

  INSERT INTO public.conversation_members (conversation_id, user_id, role)
  VALUES (cid, me, 'host');

  RETURN cid;
END;
$$;

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

  -- First joiner into an empty listed room becomes host (main category orbits).
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

CREATE OR REPLACE FUNCTION public.set_live_mods_enabled(p_conversation_id UUID, p_enabled BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_live_host(p_conversation_id) THEN
    RAISE EXCEPTION 'Only the room host can change moderator settings';
  END IF;
  UPDATE public.conversations
  SET mods_enabled = COALESCE(p_enabled, false)
  WHERE id = p_conversation_id AND kind = 'live';
END;
$$;

CREATE OR REPLACE FUNCTION public.promote_live_moderator(p_conversation_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_live_host(p_conversation_id) THEN
    RAISE EXCEPTION 'Only the room host can promote moderators';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.conversations
    WHERE id = p_conversation_id AND kind = 'live' AND mods_enabled = true
  ) THEN
    RAISE EXCEPTION 'Moderators are disabled in this room';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE conversation_id = p_conversation_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'User is not in this room';
  END IF;
  IF public.room_member_role(p_conversation_id, p_user_id) = 'host' THEN
    RAISE EXCEPTION 'Cannot change host role';
  END IF;
  UPDATE public.conversation_members
  SET role = 'moderator'
  WHERE conversation_id = p_conversation_id AND user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.demote_live_moderator(p_conversation_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_live_host(p_conversation_id) THEN
    RAISE EXCEPTION 'Only the room host can demote moderators';
  END IF;
  UPDATE public.conversation_members
  SET role = 'member'
  WHERE conversation_id = p_conversation_id
    AND user_id = p_user_id
    AND role = 'moderator';
END;
$$;

CREATE OR REPLACE FUNCTION public.kick_live_member(p_conversation_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  my_role TEXT := public.room_member_role(p_conversation_id);
  target_role TEXT := public.room_member_role(p_conversation_id, p_user_id);
BEGIN
  IF NOT public.can_manage_live_room(p_conversation_id) THEN
    RAISE EXCEPTION 'Not allowed to remove members';
  END IF;
  IF target_role = 'host' THEN
    RAISE EXCEPTION 'Cannot remove the host';
  END IF;
  IF my_role = 'moderator' AND target_role = 'moderator' THEN
    RAISE EXCEPTION 'Moderators cannot remove other moderators';
  END IF;
  DELETE FROM public.conversation_members
  WHERE conversation_id = p_conversation_id AND user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_live_stage(
  p_conversation_id UUID,
  p_cam_count INTEGER,
  p_slots JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cnt INTEGER := LEAST(8, GREATEST(2, COALESCE(p_cam_count, 2)));
BEGIN
  IF NOT public.can_manage_live_room(p_conversation_id) THEN
    RAISE EXCEPTION 'Only host or moderators can change stage layout';
  END IF;
  UPDATE public.conversations
  SET live_cam_count = cnt,
      live_stage_slots = COALESCE(p_slots, '[]'::jsonb)
  WHERE id = p_conversation_id AND kind = 'live';
END;
$$;

REVOKE ALL ON FUNCTION public.create_live_room(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_live_room(TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.join_live_room(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_live_room(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.set_live_mods_enabled(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_live_mods_enabled(UUID, BOOLEAN) TO authenticated;
REVOKE ALL ON FUNCTION public.promote_live_moderator(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.promote_live_moderator(UUID, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.demote_live_moderator(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.demote_live_moderator(UUID, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.kick_live_member(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kick_live_member(UUID, UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.set_live_stage(UUID, INTEGER, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_live_stage(UUID, INTEGER, JSONB) TO authenticated;
