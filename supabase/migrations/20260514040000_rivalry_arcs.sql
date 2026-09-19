-- Orion Rivalry Arcs: head-to-head battle records between members

CREATE TABLE IF NOT EXISTS public.orion_rivalries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenger_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  opponent_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  challenger_wins INT NOT NULL DEFAULT 0,
  opponent_wins INT NOT NULL DEFAULT 0,
  total_battles INT NOT NULL DEFAULT 0,
  declared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_battle_at TIMESTAMPTZ,
  CONSTRAINT no_self_rivalry CHECK (challenger_id <> opponent_id)
);

-- Expression-based unique index: one rivalry row per pair regardless of who declared it
CREATE UNIQUE INDEX IF NOT EXISTS orion_rivalries_pair_idx
  ON public.orion_rivalries (
    LEAST(challenger_id::text, opponent_id::text),
    GREATEST(challenger_id::text, opponent_id::text)
  );

CREATE INDEX IF NOT EXISTS orion_rivalries_challenger_idx ON public.orion_rivalries(challenger_id);
CREATE INDEX IF NOT EXISTS orion_rivalries_opponent_idx ON public.orion_rivalries(opponent_id);

ALTER TABLE public.orion_rivalries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rivalries_select" ON public.orion_rivalries;
CREATE POLICY "rivalries_select"
  ON public.orion_rivalries FOR SELECT TO authenticated
  USING (challenger_id = auth.uid() OR opponent_id = auth.uid());

DROP POLICY IF EXISTS "rivalries_insert" ON public.orion_rivalries;
CREATE POLICY "rivalries_insert"
  ON public.orion_rivalries FOR INSERT TO authenticated
  WITH CHECK (challenger_id = auth.uid());

DROP POLICY IF EXISTS "rivalries_update" ON public.orion_rivalries;
CREATE POLICY "rivalries_update"
  ON public.orion_rivalries FOR UPDATE TO authenticated
  USING (challenger_id = auth.uid() OR opponent_id = auth.uid());

DO $pub$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'orion_rivalries'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.orion_rivalries';
    END IF;
  END IF;
END $pub$;
