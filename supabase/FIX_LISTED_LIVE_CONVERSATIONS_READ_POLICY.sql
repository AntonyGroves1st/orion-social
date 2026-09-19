-- Orion Social — fix RLS on chats + listed live discovery
-- Prefer **`DELTA_RUN_IN_SQL_EDITOR.sql`** for new installs hitting an old snapshot;
-- this file remains a minimal policy-only shortcut (no Realtime publication block).
--
-- (1) "infinite recursion detected in policy for relation conversation_members"
--     Postgres re-applies RLS when policies subquery `conversation_members` directly.
--     Mitigation: `public.is_conv_member(uuid)` SECURITY DEFINER reads membership once.
-- (2) Shared live URLs: authenticated users must be able to SELECT listed `live` rows
--     before `join_live_room` adds them to `conversation_members`.
--
-- Run once in Dashboard → SQL (same DB as web/.env). Then reload the app.

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

NOTIFY pgrst, 'reload schema';
