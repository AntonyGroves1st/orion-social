-- Run in Supabase SQL Editor to verify live hosts + mods after migrations.
-- If hosts = 0 but creator_id is set, run FIX_RESTORE_LIVE_ADMINS.sql (one-shot repair).

SELECT
  c.id,
  c.title,
  c.live_category,
  c.creator_id,
  c.mods_enabled,
  c.live_cam_count,
  (SELECT count(*) FROM public.conversation_members cm WHERE cm.conversation_id = c.id) AS members,
  (SELECT count(*) FROM public.conversation_members cm
   WHERE cm.conversation_id = c.id AND lower(coalesce(cm.role, '')) = 'host') AS hosts,
  (SELECT count(*) FROM public.conversation_members cm
   WHERE cm.conversation_id = c.id AND lower(coalesce(cm.role, '')) = 'moderator') AS mods
FROM public.conversations c
WHERE c.kind = 'live'
ORDER BY c.live_category NULLS LAST, c.title;

-- Rooms that should have a host but do not:
SELECT c.id, c.title, c.creator_id, c.live_category
FROM public.conversations c
WHERE c.kind = 'live'
  AND NOT EXISTS (
    SELECT 1 FROM public.conversation_members cm
    WHERE cm.conversation_id = c.id AND lower(coalesce(cm.role, '')) = 'host'
  );

-- RPC sanity (should return 3 rows: ban, join, purge):
SELECT proname
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND proname IN ('ban_live_member', 'join_live_room', 'promote_live_moderator', 'demote_live_moderator')
ORDER BY proname;
