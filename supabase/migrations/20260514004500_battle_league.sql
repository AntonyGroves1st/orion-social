-- Battle League: top 100 winners for host-vs-host Battle Mode.

CREATE TABLE IF NOT EXISTS public.battle_league_wins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  display_name_snapshot TEXT NOT NULL DEFAULT '',
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  winner_team TEXT NOT NULL,
  loser_team TEXT NOT NULL,
  break_score INTEGER NOT NULL DEFAULT 25,
  points INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (winner_team IN ('alpha', 'omega')),
  CHECK (loser_team IN ('alpha', 'omega')),
  CHECK (winner_team <> loser_team),
  CHECK (break_score > 0),
  CHECK (points > 0)
);

CREATE INDEX IF NOT EXISTS battle_league_wins_user_idx
  ON public.battle_league_wins(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS battle_league_wins_feed_idx
  ON public.battle_league_wins(created_at DESC);

ALTER TABLE public.battle_league_wins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "battle_league_select_authed" ON public.battle_league_wins;
CREATE POLICY "battle_league_select_authed"
  ON public.battle_league_wins FOR SELECT TO authenticated
  USING (true);

CREATE OR REPLACE FUNCTION public.record_battle_win(
  p_conversation_id UUID DEFAULT NULL,
  p_winner_team TEXT DEFAULT 'alpha',
  p_loser_team TEXT DEFAULT 'omega',
  p_break_score INTEGER DEFAULT 25
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  pname TEXT;
  win_id UUID;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_winner_team NOT IN ('alpha', 'omega') OR p_loser_team NOT IN ('alpha', 'omega') THEN
    RAISE EXCEPTION 'Bad team';
  END IF;
  IF p_winner_team = p_loser_team THEN RAISE EXCEPTION 'Winner and loser must differ'; END IF;
  IF COALESCE(p_break_score, 0) <= 0 THEN RAISE EXCEPTION 'Bad break score'; END IF;

  SELECT display_name INTO pname
  FROM public.profiles
  WHERE id = me;

  IF pname IS NULL THEN RAISE EXCEPTION 'Profile not found'; END IF;

  INSERT INTO public.battle_league_wins (
    user_id,
    display_name_snapshot,
    conversation_id,
    winner_team,
    loser_team,
    break_score,
    points
  )
  VALUES (
    me,
    pname,
    p_conversation_id,
    p_winner_team,
    p_loser_team,
    p_break_score,
    3
  )
  RETURNING id INTO win_id;

  RETURN win_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_battle_win(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_battle_win(UUID, TEXT, TEXT, INTEGER) TO authenticated;

DO $pub$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'battle_league_wins'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.battle_league_wins';
    END IF;
  END IF;
END
$pub$;

NOTIFY pgrst, 'reload schema';
