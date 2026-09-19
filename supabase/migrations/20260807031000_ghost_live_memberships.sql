-- Scrub ghost live memberships + ensure presence columns exist.
-- Fixes: "column cm.last_active_at does not exist"
-- Run whole file in Supabase SQL Editor (role: postgres).

-- ── 0) Ensure columns exist FIRST ────────────────────────────────────────────
ALTER TABLE public.conversation_members
  ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS conversation_members_last_active_idx
  ON public.conversation_members (last_active_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS profiles_last_seen_idx
  ON public.profiles (last_seen_at DESC NULLS LAST);

-- ── 1) Clear stage slots for users who are no longer members of that room ────
UPDATE public.conversations c
SET live_stage_slots = (
  SELECT coalesce(jsonb_agg(
    CASE
      WHEN elem IS NULL OR jsonb_typeof(elem) = 'null' THEN 'null'::jsonb
      WHEN jsonb_typeof(elem) = 'string'
           AND EXISTS (
             SELECT 1 FROM public.conversation_members cm
             WHERE cm.conversation_id = c.id
               AND cm.user_id::text = trim(both '"' from elem::text)
           )
        THEN elem
      ELSE 'null'::jsonb
    END
  ), '[]'::jsonb)
  FROM jsonb_array_elements(coalesce(c.live_stage_slots, '[]'::jsonb)) AS elem
)
WHERE c.kind = 'live'
  AND c.live_listed = true
  AND c.live_stage_slots IS NOT NULL
  AND jsonb_typeof(c.live_stage_slots) = 'array';

-- ── 2) Multiple live memberships → keep only the freshest room per user ──────
WITH ranked AS (
  SELECT
    cm.ctid,
    cm.user_id,
    cm.conversation_id,
    row_number() OVER (
      PARTITION BY cm.user_id
      ORDER BY
        coalesce(cm.last_active_at, cm.joined_at, '-infinity'::timestamptz) DESC,
        cm.joined_at DESC NULLS LAST
    ) AS rn
  FROM public.conversation_members cm
  JOIN public.conversations c ON c.id = cm.conversation_id
  WHERE c.kind = 'live' AND c.live_listed = true
)
DELETE FROM public.conversation_members cm
USING ranked r
WHERE cm.ctid = r.ctid
  AND r.rn > 1;

-- ── 3) Empty rooms: wipe chat/cache if helper exists ─────────────────────────
DO $$
DECLARE
  r RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'purge_live_room_chat_and_cache'
  ) THEN
    FOR r IN
      SELECT c.id
      FROM public.conversations c
      WHERE c.kind = 'live'
        AND NOT EXISTS (
          SELECT 1 FROM public.conversation_members cm WHERE cm.conversation_id = c.id
        )
    LOOP
      PERFORM public.purge_live_room_chat_and_cache(r.id);
    END LOOP;
  ELSE
    /* Fallback without purge helper: clear creator/stage on empty lives */
    UPDATE public.conversations c
    SET creator_id = NULL,
        live_stage_slots = '[]'::jsonb
    WHERE c.kind = 'live'
      AND NOT EXISTS (
        SELECT 1 FROM public.conversation_members cm WHERE cm.conversation_id = c.id
      );
  END IF;
END $$;

-- Done. Friends Live should now show the real room (e.g. Sports, not Culture).
