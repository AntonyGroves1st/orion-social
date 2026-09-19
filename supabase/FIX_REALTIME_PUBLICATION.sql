-- Orion Social realtime repair.
-- Run this whole short file in Supabase Dashboard -> SQL Editor if the long
-- DELTA_RUN_IN_SQL_EDITOR.sql paste was cut off around `DO $pub$`.

DO $orion_realtime$
DECLARE
  realtime_table text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'supabase_realtime publication was not found; enable Realtime from Supabase Dashboard if needed.';
    RETURN;
  END IF;

  FOREACH realtime_table IN ARRAY ARRAY[
    'conversation_members',
    'messages',
    'webrtc_signals',
    'friend_connections'
  ]
  LOOP
    IF to_regclass(format('public.%I', realtime_table)) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = realtime_table
      )
    THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', realtime_table);
    END IF;
  END LOOP;
END;
$orion_realtime$;

NOTIFY pgrst, 'reload schema';
