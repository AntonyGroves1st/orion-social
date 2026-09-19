-- Orion Reels: vertical video posts now, upload/transcode-ready later.

CREATE TABLE IF NOT EXISTS public.orion_reels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  video_url TEXT NOT NULL,
  hls_url TEXT,
  thumbnail_url TEXT,
  caption TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public',
  moderation_status TEXT NOT NULL DEFAULT 'published',
  duration_seconds INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (visibility IN ('public', 'friends', 'private')),
  CHECK (moderation_status IN ('draft', 'published', 'held', 'removed')),
  CHECK (length(trim(video_url)) > 8)
);

CREATE INDEX IF NOT EXISTS orion_reels_feed_idx
  ON public.orion_reels(moderation_status, visibility, created_at DESC);

CREATE INDEX IF NOT EXISTS orion_reels_creator_idx
  ON public.orion_reels(creator_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.orion_reel_likes (
  reel_id UUID NOT NULL REFERENCES public.orion_reels(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (reel_id, user_id)
);

CREATE INDEX IF NOT EXISTS orion_reel_likes_user_idx
  ON public.orion_reel_likes(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.orion_reel_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reel_id UUID NOT NULL REFERENCES public.orion_reels(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(trim(body)) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS orion_reel_comments_reel_idx
  ON public.orion_reel_comments(reel_id, created_at DESC);

ALTER TABLE public.orion_reels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orion_reel_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orion_reel_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reels_select_visible" ON public.orion_reels;
CREATE POLICY "reels_select_visible"
  ON public.orion_reels FOR SELECT TO authenticated
  USING (
    moderation_status = 'published'
    AND (
      visibility = 'public'
      OR creator_id = auth.uid()
      OR (
        visibility = 'friends'
        AND EXISTS (
          SELECT 1
          FROM public.friend_connections fc
          WHERE fc.status = 'accepted'
            AND fc.user_low = LEAST(auth.uid(), creator_id)
            AND fc.user_high = GREATEST(auth.uid(), creator_id)
        )
      )
    )
  );

DROP POLICY IF EXISTS "reels_insert_own" ON public.orion_reels;
CREATE POLICY "reels_insert_own"
  ON public.orion_reels FOR INSERT TO authenticated
  WITH CHECK (
    creator_id = auth.uid()
    AND moderation_status IN ('draft', 'published')
  );

DROP POLICY IF EXISTS "reels_update_own" ON public.orion_reels;
CREATE POLICY "reels_update_own"
  ON public.orion_reels FOR UPDATE TO authenticated
  USING (creator_id = auth.uid())
  WITH CHECK (creator_id = auth.uid());

DROP POLICY IF EXISTS "reels_delete_own" ON public.orion_reels;
CREATE POLICY "reels_delete_own"
  ON public.orion_reels FOR DELETE TO authenticated
  USING (creator_id = auth.uid());

DROP POLICY IF EXISTS "reel_likes_select_visible" ON public.orion_reel_likes;
CREATE POLICY "reel_likes_select_visible"
  ON public.orion_reel_likes FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.orion_reels r
      WHERE r.id = reel_id
        AND r.moderation_status = 'published'
    )
  );

DROP POLICY IF EXISTS "reel_likes_insert_own" ON public.orion_reel_likes;
CREATE POLICY "reel_likes_insert_own"
  ON public.orion_reel_likes FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "reel_likes_delete_own" ON public.orion_reel_likes;
CREATE POLICY "reel_likes_delete_own"
  ON public.orion_reel_likes FOR DELETE TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "reel_comments_select_visible" ON public.orion_reel_comments;
CREATE POLICY "reel_comments_select_visible"
  ON public.orion_reel_comments FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.orion_reels r
      WHERE r.id = reel_id
        AND r.moderation_status = 'published'
    )
  );

DROP POLICY IF EXISTS "reel_comments_insert_own" ON public.orion_reel_comments;
CREATE POLICY "reel_comments_insert_own"
  ON public.orion_reel_comments FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "reel_comments_delete_own" ON public.orion_reel_comments;
CREATE POLICY "reel_comments_delete_own"
  ON public.orion_reel_comments FOR DELETE TO authenticated
  USING (user_id = auth.uid());

DO $pub$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'orion_reels'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.orion_reels';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'orion_reel_likes'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.orion_reel_likes';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'orion_reel_comments'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.orion_reel_comments';
    END IF;
  END IF;
END
$pub$;

NOTIFY pgrst, 'reload schema';
