-- Deploy the invite RPC Supabase REST can reliably see: one jsonb argument.
-- Run in Supabase → SQL → same project as VITE_SUPABASE_URL.
--
-- Prereqs: invite_codes + profiles (and RLS) from RUN_ONCE. If missing, run RUN_ONCE_IN_SQL_EDITOR.sql instead.

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

NOTIFY pgrst, 'reload schema';
