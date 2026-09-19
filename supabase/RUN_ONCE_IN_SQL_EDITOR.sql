-- Orion Social — run once in Supabase Dashboard → SQL → New query (paste entire file → Run).
-- Then: Database → Replication → enable realtime for `messages`, `webrtc_signals`,
-- and `conversation_members` (solo host hears late joiners and opens mesh legs).

-- ── Migration 20260209160000_orion_social ─────────────────────────────────

CREATE TABLE IF NOT EXISTS public.invite_codes (
  code TEXT PRIMARY KEY,
  uses_left INTEGER NOT NULL DEFAULT 1 CHECK (uses_left >= 0)
);

INSERT INTO public.invite_codes (code, uses_left)
VALUES ('ORION-FOUNDER-2026', 1000)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_authed" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;

CREATE POLICY "profiles_select_authed"
  ON public.profiles FOR SELECT TO authenticated USING (true);

CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- Single-jsonb RPC: PostgREST reliably publishes this; two TEXT args historically confused schema cache/errors.
DROP FUNCTION IF EXISTS public.claim_invite_and_profile(text, text);

CREATE OR REPLACE FUNCTION public.orion_claim_invite(payload JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
  rows INTEGER;
  pname TEXT;
  em TEXT;
  invite TEXT := COALESCE(trim(payload->>'invite'), '');
  display_name TEXT := COALESCE(trim(payload->>'display_name'), '');
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE id = uid) THEN RETURN true; END IF;
  IF LENGTH(invite) < 4 THEN RAISE EXCEPTION 'Invite code required'; END IF;
  IF (SELECT COUNT(*) FROM profiles) >= 1000 THEN RAISE EXCEPTION 'Community is full (1000 members)'; END IF;

  UPDATE invite_codes SET uses_left = uses_left - 1
  WHERE code = invite AND uses_left > 0;
  GET DIAGNOSTICS rows = ROW_COUNT;
  IF rows <> 1 THEN RAISE EXCEPTION 'Invalid or exhausted invite code'; END IF;

  SELECT email INTO em FROM auth.users WHERE id = uid;
  pname := LEFT(COALESCE(NULLIF(display_name, ''), split_part(em, '@', 1), 'Friend'), 120);
  INSERT INTO public.profiles (id, display_name) VALUES (uid, pname);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.orion_claim_invite(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.orion_claim_invite(JSONB) TO authenticated;

CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.conversation_members (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  is_orion_sealed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conv_created ON public.messages(conversation_id, created_at DESC);

-- Breaks RLS recursion: policies must not subquery `conversation_members` directly (Postgres re-applies RLS).
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

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conv_member_read" ON public.conversations;
DROP POLICY IF EXISTS "conv_insert" ON public.conversations;

CREATE POLICY "conv_member_read"
  ON public.conversations FOR SELECT TO authenticated
  USING (public.is_conv_member(id));

CREATE POLICY "conv_insert"
  ON public.conversations FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "convmembers_select" ON public.conversation_members;

CREATE POLICY "convmembers_select"
  ON public.conversation_members FOR SELECT TO authenticated
  USING (public.is_conv_member(conversation_id));

DROP POLICY IF EXISTS "convmembers_insert_self" ON public.conversation_members;

CREATE POLICY "convmembers_insert_self"
  ON public.conversation_members FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "msgs_read_members" ON public.messages;
DROP POLICY IF EXISTS "msgs_insert_own" ON public.messages;

CREATE POLICY "msgs_read_members"
  ON public.messages FOR SELECT TO authenticated
  USING (public.is_conv_member(conversation_id));

CREATE POLICY "msgs_insert_own"
  ON public.messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND public.is_conv_member(conversation_id)
  );

CREATE TABLE IF NOT EXISTS public.webrtc_signals (
  id BIGSERIAL PRIMARY KEY,
  room_id TEXT NOT NULL,
  sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webrtc_room_created ON public.webrtc_signals(room_id, id DESC);

ALTER TABLE public.webrtc_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webrtc_select_room" ON public.webrtc_signals;
DROP POLICY IF EXISTS "webrtc_insert_own" ON public.webrtc_signals;

CREATE POLICY "webrtc_select_room"
  ON public.webrtc_signals FOR SELECT TO authenticated
  USING (
    webrtc_signals.room_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND public.is_conv_member((webrtc_signals.room_id)::uuid)
  );

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

-- ── Migration 20260210120000_live_rooms_seal_pubkey ────────────────────────

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'dm',
  ADD COLUMN IF NOT EXISTS title TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS live_listed BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_kind_check;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_kind_check CHECK (kind IN ('dm', 'live'));

DROP POLICY IF EXISTS "conv_member_read" ON public.conversations;

CREATE POLICY "conv_select_member_or_listed_live"
  ON public.conversations FOR SELECT TO authenticated
  USING (
    public.is_conv_member(id)
    OR (
      conversations.kind = 'live'
      AND conversations.live_listed = true
    )
  );

DROP POLICY IF EXISTS "conv_insert" ON public.conversations;
CREATE POLICY "conv_insert"
  ON public.conversations FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "convmembers_select" ON public.conversation_members;

CREATE POLICY "convmembers_select"
  ON public.conversation_members FOR SELECT TO authenticated
  USING (public.is_conv_member(conversation_id));

DROP POLICY IF EXISTS "convmembers_insert_self" ON public.conversation_members;
CREATE POLICY "convmembers_insert_self"
  ON public.conversation_members FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS seal_pubkey_jwk TEXT;

COMMENT ON COLUMN public.profiles.seal_pubkey_jwk IS 'P-256 ECDH public JWK generated in browser — private counterpart never uploaded.';

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS orion_login_pubkey_jwk TEXT,
  ADD COLUMN IF NOT EXISTS orion_key_required BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS orion_key_enrolled_at TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.orion_login_pubkey_jwk IS 'P-256 ECDSA public JWK used for Orion Key login proof. Private key remains on the member device.';
COMMENT ON COLUMN public.profiles.orion_key_required IS 'When true, Orion Social requires a browser Orion Key challenge after Supabase auth.';
COMMENT ON COLUMN public.profiles.orion_key_enrolled_at IS 'Timestamp when the member first enrolled or replaced the Orion login key.';

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

  INSERT INTO public.conversation_members (conversation_id, user_id) VALUES (cid, me);
  RETURN cid;
END;
$$;

REVOKE ALL ON FUNCTION public.create_live_room(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_live_room(TEXT) TO authenticated;

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
    SELECT 1 FROM public.conversation_members
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
  VALUES (p_conversation_id, me)
  ON CONFLICT DO NOTHING;
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

-- ── Migration 20260514001000_friend_system ───────────────────────────────

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

-- Expose new RPCs/tables to the REST API immediately (fixes "not in the schema cache").
NOTIFY pgrst, 'reload schema';
