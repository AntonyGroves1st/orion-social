-- Delta migration — safe to run if you already applied an older Orion SQL bootstrap.
--
-- Applies (idempotently): `is_conv_member`, non-recursive RLS, listed-live read,
-- and Realtime publication for mesh join discovery + chat/signaling clients.
--
-- Same file can be pasted into Dashboard → SQL if you don’t use `supabase db push`.

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

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_kind_check;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_kind_check CHECK (kind IN ('dm', 'live'));

DROP POLICY IF EXISTS "conv_member_read" ON public.conversations;
DROP POLICY IF EXISTS "conv_select_member_or_listed_live" ON public.conversations;

CREATE POLICY "conv_select_member_or_listed_live"
  ON public.conversations FOR SELECT TO authenticated
  USING (
    public.is_conv_member(id)
    OR (
      conversations.kind = 'live'
      AND conversations.live_listed = true
    )
  );

DROP POLICY IF EXISTS "convmembers_select" ON public.conversation_members;

CREATE POLICY "convmembers_select"
  ON public.conversation_members FOR SELECT TO authenticated
  USING (public.is_conv_member(conversation_id));

DROP POLICY IF EXISTS "msgs_read_members" ON public.messages;

CREATE POLICY "msgs_read_members"
  ON public.messages FOR SELECT TO authenticated
  USING (public.is_conv_member(conversation_id));

DROP POLICY IF EXISTS "msgs_insert_own" ON public.messages;

CREATE POLICY "msgs_insert_own"
  ON public.messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND public.is_conv_member(conversation_id)
  );

DROP POLICY IF EXISTS "webrtc_select_room" ON public.webrtc_signals;

CREATE POLICY "webrtc_select_room"
  ON public.webrtc_signals FOR SELECT TO authenticated
  USING (
    webrtc_signals.room_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND public.is_conv_member((webrtc_signals.room_id)::uuid)
  );

DROP POLICY IF EXISTS "webrtc_insert_own" ON public.webrtc_signals;

CREATE POLICY "webrtc_insert_own"
  ON public.webrtc_signals FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND webrtc_signals.room_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND public.is_conv_member((webrtc_signals.room_id)::uuid)
  );

-- Realtime publication (solo host reacts when guests INSERT into conversation_members).
DO $pub$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'conversation_members'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_members';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'messages'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.messages';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'webrtc_signals'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.webrtc_signals';
    END IF;
  END IF;
END
$pub$;

NOTIFY pgrst, 'reload schema';
