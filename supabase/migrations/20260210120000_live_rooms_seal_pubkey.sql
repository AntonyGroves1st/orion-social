-- Live rooms (≤7 on-camera publishers), browseable directory, DM-only unchanged.
-- Orion DM wrapping: profiles.seal_pubkey_jwk holds public ECDH key only — private never leaves browser.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'dm',
  ADD COLUMN IF NOT EXISTS title TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS live_listed BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_kind_check;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_kind_check CHECK (kind IN ('dm', 'live'));

-- Allow listing public LIVE rooms without being a member (for TikTok-like discovery).
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

DROP POLICY IF EXISTS "convmembers_select" ON public.conversation_members;

CREATE POLICY "convmembers_select"
  ON public.conversation_members FOR SELECT TO authenticated
  USING (public.is_conv_member(conversation_id));

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS seal_pubkey_jwk TEXT;

COMMENT ON COLUMN public.profiles.seal_pubkey_jwk IS 'P-256 ECDH public JWK generated in browser — private counterpart never uploaded.';

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
