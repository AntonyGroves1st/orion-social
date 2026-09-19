-- Orion Social — Postgres schema for Supabase (free tier, ~1000 users)
-- After push: Dashboard → Database → Replication → enable for `messages`, `webrtc_signals`, `conversation_members`

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
DROP POLICY IF EXISTS "convmembers_insert_self" ON public.conversation_members;
DROP POLICY IF EXISTS "convmem_self" ON public.conversation_members;
DROP POLICY IF EXISTS "convmember_read_own_convs" ON public.conversation_members;

CREATE POLICY "convmembers_select"
  ON public.conversation_members FOR SELECT TO authenticated
  USING (public.is_conv_member(conversation_id));

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

DROP POLICY IF EXISTS "rtc_read_room" ON public.webrtc_signals;
DROP POLICY IF EXISTS "rtc_insert_own" ON public.webrtc_signals;
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

-- ── Helpers ───────────────────────────────────────────────────────────────
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
  WHERE (SELECT COUNT(*)::int FROM conversation_members m WHERE m.conversation_id = c.id) = 2;

  IF cid IS NOT NULL THEN RETURN cid; END IF;

  INSERT INTO conversations DEFAULT VALUES RETURNING id INTO cid;
  INSERT INTO conversation_members (conversation_id, user_id) VALUES (cid, me);
  INSERT INTO conversation_members (conversation_id, user_id) VALUES (cid, peer_id);
  RETURN cid;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_dm(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_dm(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
