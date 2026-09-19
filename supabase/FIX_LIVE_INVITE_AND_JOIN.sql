-- Run once in Supabase Dashboard → SQL Editor (project: udfgqyiusqsvmjkkvidw)
-- Fixes: guests joining live rooms via Lobby or invite link, WebRTC signals, duplicate members.

-- ── Membership helper (no RLS recursion) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_conv_member(p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversation_members cm
    WHERE cm.conversation_id = p_conversation_id
      AND cm.user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.is_conv_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_conv_member(uuid) TO authenticated;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'dm',
  ADD COLUMN IF NOT EXISTS title TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS live_listed BOOLEAN NOT NULL DEFAULT false;

-- ── Listed live rooms visible before join (Lobby map + invite landing) ───────
DROP POLICY IF EXISTS "conv_member_read" ON public.conversations;
DROP POLICY IF EXISTS "conv_select_member_or_listed_live" ON public.conversations;

CREATE POLICY "conv_select_member_or_listed_live"
  ON public.conversations FOR SELECT TO authenticated
  USING (
    public.is_conv_member(id)
    OR (
      kind = 'live'
      AND live_listed = true
    )
  );

-- ── One row per user per room (fixes duplicate TonyGees / Emperial entries) ──
DELETE FROM public.conversation_members a
USING public.conversation_members b
WHERE a.ctid < b.ctid
  AND a.conversation_id = b.conversation_id
  AND a.user_id = b.user_id;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_members_room_user_unique
  ON public.conversation_members (conversation_id, user_id);

-- ── create_live_room + join_live_room ────────────────────────────────────────
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

  INSERT INTO public.conversations (kind, title, live_listed)
  VALUES ('live', t, true)
  RETURNING id INTO cid;

  INSERT INTO public.conversation_members (conversation_id, user_id)
  VALUES (cid, me)
  ON CONFLICT (conversation_id, user_id) DO NOTHING;

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
  cnt INTEGER;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  PERFORM 1
  FROM public.conversations c
  WHERE c.id = p_conversation_id
    AND c.kind = 'live'
    AND c.live_listed = true
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Live room not joinable (not listed or wrong id)'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE conversation_id = p_conversation_id AND user_id = me
  ) THEN
    RETURN;
  END IF;

  SELECT COUNT(*)::INTEGER INTO cnt
  FROM public.conversation_members
  WHERE conversation_id = p_conversation_id;

  IF cnt >= 8 THEN RAISE EXCEPTION 'Live room full (max 8)'; END IF;

  INSERT INTO public.conversation_members (conversation_id, user_id)
  VALUES (p_conversation_id, me)
  ON CONFLICT (conversation_id, user_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.create_live_room(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_live_room(TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.join_live_room(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_live_room(UUID) TO authenticated;

-- ── Realtime: required for chat + WebRTC mesh on APK/EXE/web ─────────────────
DO $pub$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'conversation_members'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_members;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'webrtc_signals'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.webrtc_signals;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
    END IF;
  END IF;
END;
$pub$;

NOTIFY pgrst, 'reload schema';
