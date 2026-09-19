-- Dashboard paste: same as migrations/20260211193000_delta_rls_is_conv_member_realtime.sql
-- Run once on any project that already ran an older Orion bootstrap (idempotent).

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

CREATE OR REPLACE FUNCTION public.ensure_dm(peer_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  cid UUID;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF peer_id IS NULL OR peer_id = me THEN RAISE EXCEPTION 'Bad peer'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = peer_id) THEN RAISE EXCEPTION 'Peer not registered'; END IF;

  SELECT c.id INTO cid
  FROM conversations c
  JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = me
  JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = peer_id
  WHERE c.kind = 'dm'
    AND (SELECT COUNT(*)::int FROM conversation_members m WHERE m.conversation_id = c.id) = 2
  ORDER BY c.created_at ASC
  LIMIT 1;

  IF cid IS NOT NULL THEN RETURN cid; END IF;

  INSERT INTO conversations (kind, title, live_listed)
  VALUES ('dm', '', false)
  RETURNING id INTO cid;

  INSERT INTO conversation_members (conversation_id, user_id) VALUES (cid, me);
  INSERT INTO conversation_members (conversation_id, user_id) VALUES (cid, peer_id);
  RETURN cid;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_dm(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_dm(UUID) TO authenticated;

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

  IF NOT FOUND THEN RAISE EXCEPTION 'Live room not joinable'; END IF;

  IF EXISTS (
    SELECT 1
    FROM public.conversation_members
    WHERE conversation_id = p_conversation_id
      AND user_id = me
  ) THEN
    RETURN;
  END IF;

  SELECT COUNT(*)::INTEGER INTO cnt
  FROM public.conversation_members
  WHERE conversation_id = p_conversation_id;

  IF cnt >= 8 THEN RAISE EXCEPTION 'Live room full (max 8)'; END IF;

  INSERT INTO public.conversation_members (conversation_id, user_id)
  VALUES (p_conversation_id, me);
END;
$$;

REVOKE ALL ON FUNCTION public.join_live_room(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_live_room(UUID) TO authenticated;

CREATE INDEX IF NOT EXISTS webrtc_signals_created_at ON public.webrtc_signals(created_at);

CREATE OR REPLACE FUNCTION public.cleanup_webrtc_signals(max_age INTERVAL DEFAULT INTERVAL '2 hours')
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_rows INTEGER;
BEGIN
  DELETE FROM public.webrtc_signals
  WHERE created_at < now() - max_age;

  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  RETURN deleted_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_webrtc_signals(INTERVAL) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_webrtc_signals(INTERVAL) TO authenticated;

CREATE TABLE IF NOT EXISTS public.friend_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  addressee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_low UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_high UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  CHECK (requester_id <> addressee_id),
  CHECK (status IN ('pending', 'accepted')),
  CHECK (user_low = LEAST(requester_id, addressee_id)),
  CHECK (user_high = GREATEST(requester_id, addressee_id)),
  UNIQUE (user_low, user_high)
);

CREATE INDEX IF NOT EXISTS friend_connections_requester_idx
  ON public.friend_connections(requester_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS friend_connections_addressee_idx
  ON public.friend_connections(addressee_id, status, created_at DESC);

ALTER TABLE public.friend_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "friends_select_involved" ON public.friend_connections;
CREATE POLICY "friends_select_involved"
  ON public.friend_connections FOR SELECT TO authenticated
  USING (requester_id = auth.uid() OR addressee_id = auth.uid());

CREATE OR REPLACE FUNCTION public.send_friend_request(peer_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  low_id UUID;
  high_id UUID;
  row friend_connections%ROWTYPE;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF peer_id IS NULL OR peer_id = me THEN RAISE EXCEPTION 'Bad peer'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = peer_id) THEN
    RAISE EXCEPTION 'Peer not registered';
  END IF;

  low_id := LEAST(me, peer_id);
  high_id := GREATEST(me, peer_id);

  SELECT * INTO row
  FROM public.friend_connections
  WHERE user_low = low_id AND user_high = high_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.friend_connections (requester_id, addressee_id, user_low, user_high, status)
    VALUES (me, peer_id, low_id, high_id, 'pending')
    RETURNING * INTO row;
    RETURN row.id;
  END IF;

  IF row.status = 'accepted' THEN
    RETURN row.id;
  END IF;

  IF row.status = 'pending' AND row.addressee_id = me THEN
    UPDATE public.friend_connections
    SET status = 'accepted', responded_at = now()
    WHERE id = row.id
    RETURNING * INTO row;
    RETURN row.id;
  END IF;

  IF row.status = 'pending' AND row.requester_id = me THEN
    RETURN row.id;
  END IF;

  UPDATE public.friend_connections
  SET requester_id = me,
      addressee_id = peer_id,
      user_low = low_id,
      user_high = high_id,
      status = 'pending',
      created_at = now(),
      responded_at = NULL
  WHERE id = row.id
  RETURNING * INTO row;

  RETURN row.id;
END;
$$;

REVOKE ALL ON FUNCTION public.send_friend_request(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_friend_request(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.respond_friend_request(request_id UUID, accept BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  row friend_connections%ROWTYPE;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO row
  FROM public.friend_connections
  WHERE id = request_id
    AND addressee_id = me
    AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Friend request not found'; END IF;

  IF accept THEN
    UPDATE public.friend_connections
    SET status = 'accepted', responded_at = now()
    WHERE id = row.id;
  ELSE
    DELETE FROM public.friend_connections WHERE id = row.id;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.respond_friend_request(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_friend_request(UUID, BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.remove_friend(peer_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF peer_id IS NULL OR peer_id = me THEN RAISE EXCEPTION 'Bad peer'; END IF;

  DELETE FROM public.friend_connections
  WHERE user_low = LEAST(me, peer_id)
    AND user_high = GREATEST(me, peer_id)
    AND (requester_id = me OR addressee_id = me);

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_friend(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_friend(UUID) TO authenticated;

-- If the Supabase SQL editor ever reports "unterminated dollar-quoted string"
-- here, the pasted query was cut off. Run FIX_REALTIME_PUBLICATION.sql instead.
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
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'friend_connections'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.friend_connections';
    END IF;
  END IF;
END;
$pub$;

NOTIFY pgrst, 'reload schema';
