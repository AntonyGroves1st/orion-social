-- Orion Social friend system: pending requests, accepted friends, and safe RPC mutations.

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

DO $pub$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'friend_connections'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.friend_connections';
    END IF;
  END IF;
END
$pub$;

NOTIFY pgrst, 'reload schema';
