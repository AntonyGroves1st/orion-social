ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS orion_login_pubkey_jwk TEXT,
  ADD COLUMN IF NOT EXISTS orion_key_required BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS orion_key_enrolled_at TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.orion_login_pubkey_jwk IS
  'P-256 ECDSA public JWK used for Orion Key login proof. Private key remains on the member device.';

COMMENT ON COLUMN public.profiles.orion_key_required IS
  'When true, Orion Social requires a browser Orion Key challenge after Supabase auth.';

COMMENT ON COLUMN public.profiles.orion_key_enrolled_at IS
  'Timestamp when the member first enrolled or replaced the Orion login key.';

NOTIFY pgrst, 'reload schema';
