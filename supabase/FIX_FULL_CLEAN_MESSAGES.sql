-- CHAT-ONLY clean (safe). Does NOT touch admins, creators, stage layouts, or members.
-- Run in Supabase SQL Editor as postgres.
-- WARNING: Deletes ALL chat (live rooms AND DMs) + WebRTC signal cache. Cannot undo.

-- ── 1) Chat messages ─────────────────────────────────────────────────────────
TRUNCATE TABLE public.messages RESTART IDENTITY CASCADE;

-- ── 2) WebRTC signaling cache (Realtime quota) ───────────────────────────────
TRUNCATE TABLE public.webrtc_signals RESTART IDENTITY CASCADE;

-- ── 3) Live like events (optional session noise) ─────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.live_like_events') IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE public.live_like_events RESTART IDENTITY CASCADE';
  END IF;
END $$;

-- Intentionally does NOT clear creator_id, live_stage_slots, live_cam_count,
-- conversation_members, or moderator/host roles.
-- (Old FIX_FULL_CLEAN_MESSAGES wiped those — that broke admins + layouts.)

-- ── Verify ───────────────────────────────────────────────────────────────────
SELECT
  (SELECT count(*) FROM public.messages) AS messages_left,
  (SELECT count(*) FROM public.webrtc_signals) AS signals_left,
  (SELECT count(*) FROM public.conversation_members cm
   JOIN public.conversations c ON c.id = cm.conversation_id
   WHERE c.kind = 'live' AND lower(coalesce(cm.role, '')) = 'host') AS live_hosts_intact;
