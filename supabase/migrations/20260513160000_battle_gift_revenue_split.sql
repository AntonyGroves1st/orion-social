-- Battle gift purchase ledger.
-- Real-money purchase rows should be inserted by a trusted payment webhook/server only.
-- Revenue split: 85% to the creator/user, 15% to the network designers.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS creator_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;

COMMENT ON COLUMN public.profiles.stripe_account_id IS
  'Optional Stripe Connect account id for creator payouts via destination charges.';

UPDATE public.conversations c
SET creator_id = picked.user_id
FROM (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    user_id
  FROM public.conversation_members
  ORDER BY conversation_id, user_id
) picked
WHERE c.id = picked.conversation_id
  AND c.creator_id IS NULL;

CREATE OR REPLACE FUNCTION public.create_live_room(display_title TEXT DEFAULT 'Live')
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  cid UUID;
  t TEXT := COALESCE(trim(display_title), 'Live');
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF length(t) < 1 THEN t := 'Live'; END IF;

  INSERT INTO public.conversations (kind, title, live_listed, creator_id)
  VALUES ('live', t, true, me)
  RETURNING id INTO cid;

  INSERT INTO public.conversation_members (conversation_id, user_id) VALUES (cid, me);
  RETURN cid;
END;
$$;

REVOKE ALL ON FUNCTION public.create_live_room(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_live_room(TEXT) TO authenticated;

CREATE TABLE IF NOT EXISTS public.battle_gift_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  buyer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  creator_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  gift_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  gross_cents INTEGER NOT NULL CHECK (gross_cents > 0),
  creator_cents INTEGER NOT NULL CHECK (creator_cents >= 0),
  network_designer_cents INTEGER NOT NULL CHECK (network_designer_cents >= 0),
  platform_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (platform_fee_cents >= 0),
  provider TEXT,
  provider_payment_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'refunded', 'failed')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (creator_cents + network_designer_cents + platform_fee_cents = gross_cents)
);

CREATE INDEX IF NOT EXISTS battle_gift_purchases_conversation_created
  ON public.battle_gift_purchases(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS battle_gift_purchases_creator_created
  ON public.battle_gift_purchases(creator_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS battle_gift_purchases_provider_payment_id_unique
  ON public.battle_gift_purchases(provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.battle_gift_split(p_gross_cents INTEGER, p_platform_fee_cents INTEGER DEFAULT 0)
RETURNS TABLE (
  gross_cents INTEGER,
  creator_cents INTEGER,
  network_designer_cents INTEGER,
  platform_fee_cents INTEGER
)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  net_cents INTEGER;
  creator_share INTEGER;
BEGIN
  IF p_gross_cents <= 0 THEN
    RAISE EXCEPTION 'gross_cents must be positive';
  END IF;
  IF p_platform_fee_cents < 0 OR p_platform_fee_cents >= p_gross_cents THEN
    RAISE EXCEPTION 'platform_fee_cents must be between 0 and gross_cents';
  END IF;

  net_cents := p_gross_cents - p_platform_fee_cents;
  creator_share := floor(net_cents * 0.85)::INTEGER;

  RETURN QUERY SELECT
    p_gross_cents,
    creator_share,
    net_cents - creator_share,
    p_platform_fee_cents;
END;
$$;

REVOKE ALL ON FUNCTION public.battle_gift_split(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.battle_gift_split(INTEGER, INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_battle_gift_purchase(
  p_conversation_id UUID,
  p_buyer_id UUID,
  p_creator_id UUID,
  p_gift_id TEXT,
  p_quantity INTEGER,
  p_gross_cents INTEGER,
  p_currency TEXT DEFAULT 'usd',
  p_platform_fee_cents INTEGER DEFAULT 0,
  p_provider TEXT DEFAULT NULL,
  p_provider_payment_id TEXT DEFAULT NULL,
  p_status TEXT DEFAULT 'paid',
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  purchase_id UUID;
  room_creator UUID;
  split_row RECORD;
BEGIN
  IF p_quantity <= 0 THEN RAISE EXCEPTION 'quantity must be positive'; END IF;

  SELECT creator_id INTO room_creator
  FROM public.conversations
  WHERE id = p_conversation_id;

  IF room_creator IS NULL THEN
    RAISE EXCEPTION 'conversation has no creator_id';
  END IF;

  IF p_creator_id <> room_creator THEN
    RAISE EXCEPTION 'creator_id must match live room creator';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE conversation_id = p_conversation_id
      AND user_id = p_buyer_id
  ) THEN
    RAISE EXCEPTION 'buyer must be a room member';
  END IF;

  SELECT * INTO split_row
  FROM public.battle_gift_split(p_gross_cents, p_platform_fee_cents);

  INSERT INTO public.battle_gift_purchases (
    conversation_id,
    buyer_id,
    creator_id,
    gift_id,
    quantity,
    currency,
    gross_cents,
    creator_cents,
    network_designer_cents,
    platform_fee_cents,
    provider,
    provider_payment_id,
    status,
    metadata
  )
  VALUES (
    p_conversation_id,
    p_buyer_id,
    p_creator_id,
    p_gift_id,
    p_quantity,
    lower(p_currency),
    split_row.gross_cents,
    split_row.creator_cents,
    split_row.network_designer_cents,
    split_row.platform_fee_cents,
    p_provider,
    p_provider_payment_id,
    p_status,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO purchase_id;

  RETURN purchase_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_battle_gift_purchase(
  UUID, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.record_battle_gift_purchase(
      UUID, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB
    ) TO service_role;
  END IF;
END $$;

ALTER TABLE public.battle_gift_purchases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "battle_gift_purchases_read_self_or_creator" ON public.battle_gift_purchases;
CREATE POLICY "battle_gift_purchases_read_self_or_creator"
  ON public.battle_gift_purchases FOR SELECT TO authenticated
  USING (
    buyer_id = auth.uid()
    OR creator_id = auth.uid()
  );

COMMENT ON TABLE public.battle_gift_purchases IS
  'Trusted ledger for Battle Mode gift purchases. Real inserts should come from a payment webhook/server, not client-side UI.';

COMMENT ON COLUMN public.battle_gift_purchases.creator_cents IS '85% creator/user share after optional platform_fee_cents.';
COMMENT ON COLUMN public.battle_gift_purchases.network_designer_cents IS '15% network designer share after optional platform_fee_cents.';

CREATE TABLE IF NOT EXISTS public.battle_bounty_share_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  host_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  recipient_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  offered_cents INTEGER NOT NULL CHECK (offered_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'canceled')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS battle_bounty_share_offers_conversation_created
  ON public.battle_bounty_share_offers(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS battle_bounty_share_offers_recipient_created
  ON public.battle_bounty_share_offers(recipient_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.battle_bounty_available_cents(
  p_conversation_id UUID,
  p_host_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  earned_cents INTEGER;
  reserved_cents INTEGER;
BEGIN
  SELECT COALESCE(sum(creator_cents), 0)::INTEGER INTO earned_cents
  FROM public.battle_gift_purchases
  WHERE conversation_id = p_conversation_id
    AND creator_id = p_host_id
    AND status = 'paid';

  SELECT COALESCE(sum(offered_cents), 0)::INTEGER INTO reserved_cents
  FROM public.battle_bounty_share_offers
  WHERE conversation_id = p_conversation_id
    AND host_id = p_host_id
    AND status IN ('pending', 'accepted');

  RETURN greatest(0, earned_cents - reserved_cents);
END;
$$;

REVOKE ALL ON FUNCTION public.battle_bounty_available_cents(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.battle_bounty_available_cents(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.offer_battle_bounty_share(
  p_conversation_id UUID,
  p_recipient_id UUID,
  p_offered_cents INTEGER,
  p_currency TEXT DEFAULT 'usd',
  p_note TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  room_creator UUID;
  available_cents INTEGER;
  offer_id UUID;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_offered_cents <= 0 THEN RAISE EXCEPTION 'offered_cents must be positive'; END IF;

  SELECT creator_id INTO room_creator
  FROM public.conversations
  WHERE id = p_conversation_id;

  IF room_creator IS NULL THEN
    RAISE EXCEPTION 'conversation has no creator_id';
  END IF;

  IF room_creator <> me THEN
    RAISE EXCEPTION 'only the live room creator can offer bounty shares';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE conversation_id = p_conversation_id
      AND user_id = p_recipient_id
  ) THEN
    RAISE EXCEPTION 'recipient must be a room member';
  END IF;

  available_cents := public.battle_bounty_available_cents(p_conversation_id, me);
  IF p_offered_cents > available_cents THEN
    RAISE EXCEPTION 'not enough available bounty';
  END IF;

  INSERT INTO public.battle_bounty_share_offers (
    conversation_id,
    host_id,
    recipient_id,
    offered_cents,
    currency,
    note
  )
  VALUES (
    p_conversation_id,
    me,
    p_recipient_id,
    p_offered_cents,
    lower(p_currency),
    p_note
  )
  RETURNING id INTO offer_id;

  RETURN offer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.offer_battle_bounty_share(UUID, UUID, INTEGER, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.offer_battle_bounty_share(UUID, UUID, INTEGER, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.respond_battle_bounty_share(
  p_offer_id UUID,
  p_status TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  offer_row public.battle_bounty_share_offers%ROWTYPE;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_status NOT IN ('accepted', 'declined', 'canceled') THEN
    RAISE EXCEPTION 'invalid status';
  END IF;

  SELECT * INTO offer_row
  FROM public.battle_bounty_share_offers
  WHERE id = p_offer_id;

  IF offer_row.id IS NULL THEN RAISE EXCEPTION 'offer not found'; END IF;
  IF offer_row.status <> 'pending' THEN RAISE EXCEPTION 'offer is not pending'; END IF;

  IF p_status IN ('accepted', 'declined') AND offer_row.recipient_id <> me THEN
    RAISE EXCEPTION 'only the recipient can accept or decline';
  END IF;

  IF p_status = 'canceled' AND offer_row.host_id <> me THEN
    RAISE EXCEPTION 'only the host can cancel';
  END IF;

  UPDATE public.battle_bounty_share_offers
  SET status = p_status,
      responded_at = now()
  WHERE id = p_offer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.respond_battle_bounty_share(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_battle_bounty_share(UUID, TEXT) TO authenticated;

ALTER TABLE public.battle_bounty_share_offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "battle_bounty_share_offers_read_participants" ON public.battle_bounty_share_offers;
CREATE POLICY "battle_bounty_share_offers_read_participants"
  ON public.battle_bounty_share_offers FOR SELECT TO authenticated
  USING (
    host_id = auth.uid()
    OR recipient_id = auth.uid()
  );

COMMENT ON TABLE public.battle_bounty_share_offers IS
  'Offers from a live room creator to share part of their 85% battle bounty with a user. Accepted offers should be paid out by a trusted backend.';
