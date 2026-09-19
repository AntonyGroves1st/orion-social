-- Chat emoji system: database emoji catalog + per-message reactions.

CREATE TABLE IF NOT EXISTS public.chat_emojis (
  key TEXT PRIMARY KEY,
  unicode TEXT NOT NULL,
  label TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(trim(key)) BETWEEN 2 AND 48),
  CHECK (length(trim(unicode)) BETWEEN 1 AND 16),
  CHECK (length(trim(label)) BETWEEN 1 AND 80)
);

INSERT INTO public.chat_emojis (key, unicode, label, category, sort_order)
VALUES
  ('fire', '🔥', 'Fire', 'hype', 10),
  ('heart', '❤️', 'Heart', 'love', 20),
  ('green-heart', '💚', 'Green Heart', 'love', 30),
  ('laugh', '😂', 'Laugh', 'reaction', 40),
  ('clap', '👏', 'Clap', 'hype', 50),
  ('rocket', '🚀', 'Rocket', 'hype', 60),
  ('eyes', '👀', 'Eyes', 'reaction', 70),
  ('crown', '👑', 'Crown', 'battle', 80),
  ('sparkles', '✨', 'Sparkles', 'hype', 90),
  ('hundred', '💯', 'Hundred', 'hype', 100),
  ('skull', '💀', 'Skull', 'reaction', 110),
  ('pray', '🙏', 'Pray', 'reaction', 120),
  ('star', '⭐', 'Star', 'hype', 130),
  ('trophy', '🏆', 'Trophy', 'battle', 140),
  ('zap', '⚡', 'Lightning', 'battle', 150),
  ('snow', '❄️', 'Snow', 'battle', 160),
  ('dragon', '🐉', 'Dragon', 'battle', 170),
  ('gem', '💎', 'Gem', 'gift', 180),
  ('money', '💸', 'Money', 'gift', 190),
  ('target', '🎯', 'Target', 'battle', 200),
  ('shield', '🛡️', 'Shield', 'battle', 210),
  ('siren', '🚨', 'Siren', 'hype', 220),
  ('mind', '🤯', 'Mind Blown', 'reaction', 230),
  ('ok', '👌', 'OK', 'reaction', 240),
  ('wave', '👋', 'Wave', 'social', 250),
  ('party', '🥳', 'Party', 'hype', 260),
  ('cry', '😭', 'Cry Laugh', 'reaction', 270),
  ('smile', '🙂', 'Smile', 'social', 280),
  ('cool', '😎', 'Cool', 'social', 290),
  ('thinking', '🤔', 'Thinking', 'reaction', 300),
  ('angry', '😤', 'Fired Up', 'reaction', 310),
  ('kiss', '😘', 'Kiss', 'love', 320),
  ('grin', '😀', 'Grin', 'faces', 330),
  ('big-grin', '😃', 'Big Grin', 'faces', 340),
  ('beam', '😁', 'Beaming', 'faces', 350),
  ('sweat-smile', '😅', 'Sweat Smile', 'faces', 360),
  ('rofl', '🤣', 'Rolling Laugh', 'faces', 370),
  ('wink', '😉', 'Wink', 'faces', 380),
  ('blush', '😊', 'Blush', 'faces', 390),
  ('halo', '😇', 'Halo', 'faces', 400),
  ('star-eyes', '🤩', 'Star Eyes', 'faces', 410),
  ('smirk', '😏', 'Smirk', 'faces', 420),
  ('relieved', '😌', 'Relieved', 'faces', 430),
  ('sleepy', '😴', 'Sleepy', 'faces', 440),
  ('zip', '🤐', 'Zip Mouth', 'faces', 450),
  ('nerd', '🤓', 'Nerd', 'faces', 460),
  ('salute', '🫡', 'Salute', 'faces', 470),
  ('melting', '🫠', 'Melting', 'faces', 480),
  ('pleading', '🥺', 'Pleading', 'faces', 490),
  ('exploding', '💥', 'Explosion', 'battle', 500),
  ('boom', '💣', 'Bomb', 'battle', 510),
  ('sword', '⚔️', 'Swords', 'battle', 520),
  ('axe', '🪓', 'Axe', 'battle', 530),
  ('hammer', '🔨', 'Hammer', 'battle', 540),
  ('magic-wand', '🪄', 'Magic Wand', 'battle', 550),
  ('crystal-ball', '🔮', 'Crystal Ball', 'battle', 560),
  ('comet', '☄️', 'Comet', 'battle', 570),
  ('cyclone', '🌀', 'Cyclone', 'battle', 580),
  ('tornado', '🌪️', 'Tornado', 'battle', 590),
  ('volcano', '🌋', 'Volcano', 'battle', 600),
  ('ice', '🧊', 'Ice', 'battle', 610),
  ('water-wave', '🌊', 'Wave Blast', 'battle', 620),
  ('sun', '☀️', 'Sun', 'battle', 630),
  ('moon', '🌙', 'Moon', 'battle', 640),
  ('alien', '👽', 'Alien', 'battle', 650),
  ('ghost', '👻', 'Ghost', 'battle', 660),
  ('robot', '🤖', 'Robot', 'battle', 670),
  ('ninja', '🥷', 'Ninja', 'battle', 680),
  ('medal', '🏅', 'Medal', 'league', 690),
  ('first-place', '🥇', 'First Place', 'league', 700),
  ('second-place', '🥈', 'Second Place', 'league', 710),
  ('third-place', '🥉', 'Third Place', 'league', 720),
  ('soccer', '⚽', 'Soccer', 'league', 730),
  ('basketball', '🏀', 'Basketball', 'league', 740),
  ('football', '🏈', 'Football', 'league', 750),
  ('baseball', '⚾', 'Baseball', 'league', 760),
  ('tennis', '🎾', 'Tennis', 'league', 770),
  ('dice', '🎲', 'Dice', 'fun', 780),
  ('gamepad', '🎮', 'Gamepad', 'fun', 790),
  ('joystick', '🕹️', 'Joystick', 'fun', 800),
  ('music', '🎵', 'Music', 'fun', 810),
  ('microphone', '🎤', 'Microphone', 'fun', 820),
  ('camera', '📸', 'Camera', 'fun', 830),
  ('movie', '🎬', 'Movie', 'fun', 840),
  ('paint', '🎨', 'Paint', 'fun', 850),
  ('pizza', '🍕', 'Pizza', 'fun', 860),
  ('burger', '🍔', 'Burger', 'fun', 870),
  ('cake', '🎂', 'Cake', 'fun', 880),
  ('coffee', '☕', 'Coffee', 'fun', 890),
  ('rose', '🌹', 'Rose', 'love', 900),
  ('pink-heart', '🩷', 'Pink Heart', 'love', 910),
  ('blue-heart', '💙', 'Blue Heart', 'love', 920),
  ('purple-heart', '💜', 'Purple Heart', 'love', 930),
  ('yellow-heart', '💛', 'Yellow Heart', 'love', 940),
  ('orange-heart', '🧡', 'Orange Heart', 'love', 950),
  ('black-heart', '🖤', 'Black Heart', 'love', 960),
  ('broken-heart', '💔', 'Broken Heart', 'love', 970),
  ('two-hearts', '💕', 'Two Hearts', 'love', 980),
  ('heart-fire', '❤️‍🔥', 'Heart Fire', 'love', 990),
  ('hug', '🤗', 'Hug', 'social', 1000),
  ('handshake', '🤝', 'Handshake', 'social', 1010),
  ('muscle', '💪', 'Strong', 'social', 1020),
  ('point-up', '☝️', 'Point Up', 'social', 1030),
  ('thumbs-up', '👍', 'Thumbs Up', 'social', 1040),
  ('thumbs-down', '👎', 'Thumbs Down', 'social', 1050),
  ('raised-hands', '🙌', 'Raised Hands', 'social', 1060),
  ('writing', '✍️', 'Writing', 'social', 1070),
  ('gift', '🎁', 'Gift', 'gift', 1080),
  ('ticket', '🎟️', 'Ticket', 'gift', 1090),
  ('coin', '🪙', 'Coin', 'gift', 1100),
  ('bank', '🏦', 'Bank', 'gift', 1110),
  ('diamond', '🔷', 'Diamond', 'gift', 1120),
  ('ring', '💍', 'Ring', 'gift', 1130),
  ('shopping-bags', '🛍️', 'Shopping Bags', 'gift', 1140),
  ('bell', '🔔', 'Bell', 'hype', 1150),
  ('loudspeaker', '📢', 'Loudspeaker', 'hype', 1160),
  ('megaphone', '📣', 'Megaphone', 'hype', 1170),
  ('pin', '📌', 'Pin', 'hype', 1180),
  ('check', '✅', 'Check', 'hype', 1190),
  ('xmark', '❌', 'X Mark', 'hype', 1200)
ON CONFLICT (key) DO UPDATE
SET unicode = EXCLUDED.unicode,
    label = EXCLUDED.label,
    category = EXCLUDED.category,
    sort_order = EXCLUDED.sort_order,
    active = true;

CREATE TABLE IF NOT EXISTS public.message_emoji_reactions (
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  emoji_key TEXT NOT NULL REFERENCES public.chat_emojis(key) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji_key)
);

CREATE INDEX IF NOT EXISTS message_emoji_reactions_message_idx
  ON public.message_emoji_reactions(message_id, created_at DESC);

CREATE INDEX IF NOT EXISTS message_emoji_reactions_user_idx
  ON public.message_emoji_reactions(user_id, created_at DESC);

ALTER TABLE public.chat_emojis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_emoji_reactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chat_emojis_select_active" ON public.chat_emojis;
CREATE POLICY "chat_emojis_select_active"
  ON public.chat_emojis FOR SELECT TO authenticated
  USING (active = true);

DROP POLICY IF EXISTS "message_reactions_select_members" ON public.message_emoji_reactions;
CREATE POLICY "message_reactions_select_members"
  ON public.message_emoji_reactions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.messages m
      WHERE m.id = message_id
        AND public.is_conv_member(m.conversation_id)
    )
  );

DROP POLICY IF EXISTS "message_reactions_insert_own_members" ON public.message_emoji_reactions;
CREATE POLICY "message_reactions_insert_own_members"
  ON public.message_emoji_reactions FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.messages m
      WHERE m.id = message_id
        AND public.is_conv_member(m.conversation_id)
    )
    AND EXISTS (
      SELECT 1
      FROM public.chat_emojis e
      WHERE e.key = emoji_key
        AND e.active = true
    )
  );

DROP POLICY IF EXISTS "message_reactions_delete_own" ON public.message_emoji_reactions;
CREATE POLICY "message_reactions_delete_own"
  ON public.message_emoji_reactions FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.toggle_message_emoji_reaction(p_message_id UUID, p_emoji_key TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me UUID := auth.uid();
  msg_conv UUID;
  removed INTEGER;
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_message_id IS NULL OR COALESCE(trim(p_emoji_key), '') = '' THEN
    RAISE EXCEPTION 'Bad reaction';
  END IF;

  SELECT conversation_id INTO msg_conv
  FROM public.messages
  WHERE id = p_message_id;

  IF msg_conv IS NULL THEN RAISE EXCEPTION 'Message not found'; END IF;
  IF NOT public.is_conv_member(msg_conv) THEN RAISE EXCEPTION 'Not a conversation member'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_emojis WHERE key = p_emoji_key AND active = true) THEN
    RAISE EXCEPTION 'Emoji not active';
  END IF;

  DELETE FROM public.message_emoji_reactions
  WHERE message_id = p_message_id
    AND user_id = me
    AND emoji_key = p_emoji_key;
  GET DIAGNOSTICS removed = ROW_COUNT;

  IF removed > 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.message_emoji_reactions (message_id, user_id, emoji_key)
  VALUES (p_message_id, me, p_emoji_key);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.toggle_message_emoji_reaction(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.toggle_message_emoji_reaction(UUID, TEXT) TO authenticated;

DO $pub$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'message_emoji_reactions'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.message_emoji_reactions';
    END IF;
  END IF;
END
$pub$;

NOTIFY pgrst, 'reload schema';
