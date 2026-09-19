-- Orion Storage: orion-reels bucket (video uploads) + orion-avatars (profile photos)

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'orion-reels',
  'orion-reels',
  true,
  524288000,
  ARRAY['video/mp4','video/quicktime','video/webm','video/x-m4v','video/mov','image/jpeg','image/png','image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 524288000,
      allowed_mime_types = ARRAY['video/mp4','video/quicktime','video/webm','video/x-m4v','video/mov','image/jpeg','image/png','image/webp'];

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'orion-avatars',
  'orion-avatars',
  true,
  10485760,
  ARRAY['image/jpeg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 10485760,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif'];

-- orion-reels policies (path: {user_id}/{filename})
DROP POLICY IF EXISTS "reels_obj_select" ON storage.objects;
CREATE POLICY "reels_obj_select"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'orion-reels');

DROP POLICY IF EXISTS "reels_obj_insert" ON storage.objects;
CREATE POLICY "reels_obj_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'orion-reels'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "reels_obj_update" ON storage.objects;
CREATE POLICY "reels_obj_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'orion-reels'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "reels_obj_delete" ON storage.objects;
CREATE POLICY "reels_obj_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'orion-reels'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- orion-avatars policies (path: {user_id}/{filename})
DROP POLICY IF EXISTS "avatars_obj_select" ON storage.objects;
CREATE POLICY "avatars_obj_select"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'orion-avatars');

DROP POLICY IF EXISTS "avatars_obj_insert" ON storage.objects;
CREATE POLICY "avatars_obj_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'orion-avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "avatars_obj_update" ON storage.objects;
CREATE POLICY "avatars_obj_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'orion-avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "avatars_obj_delete" ON storage.objects;
CREATE POLICY "avatars_obj_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'orion-avatars'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
