-- Member profile extras for the profile dashboard.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS bio TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_avatar_url_len'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_avatar_url_len CHECK (avatar_url IS NULL OR length(trim(avatar_url)) <= 1000) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_bio_len'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_bio_len CHECK (bio IS NULL OR length(bio) <= 280) NOT VALID;
  END IF;
END
$$;

COMMENT ON COLUMN public.profiles.avatar_url IS 'Optional user-provided avatar image URL.';
COMMENT ON COLUMN public.profiles.bio IS 'Short public member bio shown on the Orion profile dashboard.';

NOTIFY pgrst, 'reload schema';
