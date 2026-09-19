-- Production hardening: DM lookup isolation, live-room capacity lock, and WebRTC signal cleanup.

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

NOTIFY pgrst, 'reload schema';
