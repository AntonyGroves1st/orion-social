-- Fix: leave live actually removes membership; friend presence; join drops other lives.
-- Run: npm run db:friend-presence   (or paste into Supabase SQL editor)

-- ── Columns ──────────────────────────────────────────────────────────────────
ALTER TABLE public.conversation_members
  ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

COMMENT ON COLUMN public.conversation_members.last_active_at IS
  'Heartbeat while in a live room — Friends Live treats stale rows as gone.';
COMMENT ON COLUMN public.profiles.last_seen_at IS
  'App heartbeat — friends dashboard shows ONLINE when recent and not in a live.';

CREATE INDEX IF NOT EXISTS conversation_members_last_active_idx
  ON public.conversation_members (last_active_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS profiles_last_seen_idx
  ON public.profiles (last_seen_at DESC NULLS LAST);

-- Allow users to delete their own membership (belt + suspenders with leave RPC).
DROP POLICY IF EXISTS "convmembers_delete_self" ON public.conversation_members;
CREATE POLICY "convmembers_delete_self"
  ON public.conversation_members FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- Allow users to update their own last_active_at (optional; prefer RPC).
DROP POLICY IF EXISTS "convmembers_update_self" ON public.conversation_members;
CREATE POLICY "convmembers_update_self"
  ON public.conversation_members FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ── leave_live_room ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.leave_live_room(p_conversation_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  was_host BOOLEAN := false;
  remaining INT;
  next_host UUID;
  slots JSONB;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT (lower(coalesce(role, '')) = 'host') INTO was_host
  FROM public.conversation_members
  WHERE conversation_id = p_conversation_id AND user_id = me;

  IF NOT FOUND THEN
    /* Still clear creator / stage if somehow stuck as creator with no row. */
    UPDATE public.conversations c
    SET creator_id = NULL,
        live_stage_slots = CASE
          WHEN c.live_stage_slots IS NULL THEN '[]'::jsonb
          ELSE (
            SELECT coalesce(jsonb_agg(CASE WHEN elem = to_jsonb(me::text) THEN 'null'::jsonb ELSE elem END), '[]'::jsonb)
            FROM jsonb_array_elements(c.live_stage_slots) AS elem
          )
        END
    WHERE c.id = p_conversation_id AND c.kind = 'live' AND c.creator_id = me;
    RETURN;
  END IF;

  DELETE FROM public.conversation_members
  WHERE conversation_id = p_conversation_id AND user_id = me;

  /* Pull leaver out of stage slots. */
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
    UPDATE public.conversations
    SET creator_id = NULL,
        live_stage_slots = '[]'::jsonb
    WHERE id = p_conversation_id AND kind = 'live';
    RETURN;
  END IF;

  IF was_host OR NOT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE conversation_id = p_conversation_id AND lower(coalesce(role, '')) = 'host'
  ) THEN
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

-- ── join_live_room: drop other live memberships + touch activity ─────────────
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
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT c.live_listed INTO listed
  FROM public.conversations c
  WHERE c.id = p_conversation_id AND c.kind = 'live';

  IF listed IS NULL THEN RAISE EXCEPTION 'Live room not found'; END IF;
  IF NOT listed THEN RAISE EXCEPTION 'This live room is not listed'; END IF;

  /* Leave every other live room so Friends Live cannot stick on ghosts. */
  FOR other_id IN
    SELECT cm.conversation_id
    FROM public.conversation_members cm
    JOIN public.conversations c ON c.id = cm.conversation_id
    WHERE cm.user_id = me
      AND c.kind = 'live'
      AND cm.conversation_id <> p_conversation_id
  LOOP
    PERFORM public.leave_live_room(other_id);
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE conversation_id = p_conversation_id AND user_id = me
  ) THEN
    UPDATE public.conversation_members
    SET last_active_at = now()
    WHERE conversation_id = p_conversation_id AND user_id = me;
    UPDATE public.profiles SET last_seen_at = now() WHERE id = me;
    RETURN;
  END IF;

  SELECT COUNT(*)::int INTO member_count
  FROM public.conversation_members
  WHERE conversation_id = p_conversation_id;

  IF member_count >= 8 THEN RAISE EXCEPTION 'Room is full (max 8)'; END IF;

  IF member_count = 0 THEN
    INSERT INTO public.conversation_members (conversation_id, user_id, role, last_active_at)
    VALUES (p_conversation_id, me, 'host', now());

    UPDATE public.conversations
    SET creator_id = me,
        live_stage_slots = CASE
          WHEN live_stage_slots = '[]'::jsonb OR live_stage_slots IS NULL
            THEN jsonb_build_array(me::text, null)
          ELSE live_stage_slots
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

-- ── Heartbeats ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_live_presence(p_conversation_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  UPDATE public.conversation_members
  SET last_active_at = now()
  WHERE conversation_id = p_conversation_id AND user_id = me;

  UPDATE public.profiles
  SET last_seen_at = now()
  WHERE id = me;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_live_presence(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_live_presence(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.touch_friend_presence()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE public.profiles SET last_seen_at = now() WHERE id = me;
END;
$$;

REVOKE ALL ON FUNCTION public.touch_friend_presence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_friend_presence() TO authenticated;

-- Purge ghost live memberships (no heartbeat for 3+ minutes).
CREATE OR REPLACE FUNCTION public.cleanup_stale_live_memberships()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INT := 0;
  r RECORD;
BEGIN
  FOR r IN
    SELECT cm.conversation_id, cm.user_id
    FROM public.conversation_members cm
    JOIN public.conversations c ON c.id = cm.conversation_id
    WHERE c.kind = 'live'
      AND (
        cm.last_active_at IS NULL
        OR cm.last_active_at < now() - interval '12 minutes'
      )
      /* Keep very fresh joins that have not heartbeated yet (grace 3 min). */
      AND coalesce(cm.joined_at, cm.last_active_at, now() - interval '1 day')
          < now() - interval '3 minutes'
  LOOP
    /* Inline leave without auth.uid — cleanup is service-style. */
    DELETE FROM public.conversation_members
    WHERE conversation_id = r.conversation_id AND user_id = r.user_id;

    UPDATE public.conversations c
    SET live_stage_slots = CASE
      WHEN c.live_stage_slots IS NULL THEN '[]'::jsonb
      ELSE (
        SELECT coalesce(jsonb_agg(
          CASE WHEN elem = to_jsonb(r.user_id::text) THEN 'null'::jsonb ELSE elem END
        ), '[]'::jsonb)
        FROM jsonb_array_elements(c.live_stage_slots) AS elem
      )
    END
    WHERE c.id = r.conversation_id AND c.kind = 'live';

    IF NOT EXISTS (
      SELECT 1 FROM public.conversation_members WHERE conversation_id = r.conversation_id
    ) THEN
      UPDATE public.conversations
      SET creator_id = NULL, live_stage_slots = '[]'::jsonb
      WHERE id = r.conversation_id AND kind = 'live';
    ELSIF NOT EXISTS (
      SELECT 1 FROM public.conversation_members
      WHERE conversation_id = r.conversation_id AND lower(coalesce(role, '')) = 'host'
    ) THEN
      UPDATE public.conversation_members cm
      SET role = 'host'
      WHERE cm.ctid = (
        SELECT cm2.ctid FROM public.conversation_members cm2
        WHERE cm2.conversation_id = r.conversation_id
        ORDER BY cm2.joined_at ASC NULLS LAST
        LIMIT 1
      );
      UPDATE public.conversations
      SET creator_id = (
        SELECT user_id FROM public.conversation_members
        WHERE conversation_id = r.conversation_id AND lower(coalesce(role, '')) = 'host'
        LIMIT 1
      )
      WHERE id = r.conversation_id AND kind = 'live';
    END IF;

    n := n + 1;
  END LOOP;

  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_stale_live_memberships() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_live_memberships() TO authenticated;

-- One-shot: wipe ALL ghost live members that never heartbeated (pre-fix world)
-- and any last_active older than 3 minutes.
SELECT public.cleanup_stale_live_memberships();

-- Also wipe pre-heartbeat ghosts that are hours old (joined_at only).
DELETE FROM public.conversation_members cm
USING public.conversations c
WHERE c.id = cm.conversation_id
  AND c.kind = 'live'
  AND cm.last_active_at IS NULL
  AND coalesce(cm.joined_at, now() - interval '1 day') < now() - interval '3 minutes';

UPDATE public.conversations c
SET creator_id = NULL,
    live_stage_slots = '[]'::jsonb
WHERE c.kind = 'live'
  AND NOT EXISTS (
    SELECT 1 FROM public.conversation_members cm WHERE cm.conversation_id = c.id
  )
  AND (c.creator_id IS NOT NULL OR coalesce(c.live_stage_slots, '[]'::jsonb) <> '[]'::jsonb);
