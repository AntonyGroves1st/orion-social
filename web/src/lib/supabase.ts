import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/** Session + localStorage (dev); cleared via `clearDevSupabasePaste`. */
export const SUPABASE_DEV_SESSION_KEY = 'orion_social_supabase_dev'

/**
 * Supabase dashboard “API URL” often ends in `/rest/v1`. The JS client appends `rest/v1` again,
 * producing `.../rest/rest/v1` and errors like “Invalid path specified in request URL”.
 */
export function normalizeSupabaseProjectUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, '')
  u = u.replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '')
  return u
}

function readStoredDevJson(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return (
      sessionStorage.getItem(SUPABASE_DEV_SESSION_KEY) ?? localStorage.getItem(SUPABASE_DEV_SESSION_KEY) ?? null
    )
  } catch {
    return null
  }
}

function readDevPaste(): { url: string; anon: string } | null {
  if (typeof window === 'undefined') return null
  if (!import.meta.env.DEV) return null
  try {
    const raw = readStoredDevJson()
    if (!raw) return null
    const j = JSON.parse(raw) as { url?: string; anon?: string }
    const u = normalizeSupabaseProjectUrl(j.url ?? '')
    const a = (j.anon ?? '').trim().replace(/\s+/g, '')
    if (u && a) return { url: u, anon: a }
  } catch {
    /* ignore */
  }
  return null
}

export const viteSupabaseEnv = {
  urlRaw: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  anonRaw: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
}

const fromFileUrl = normalizeSupabaseProjectUrl(viteSupabaseEnv.urlRaw ?? '')
const fromFileAnon = viteSupabaseEnv.anonRaw?.trim().replace(/\s+/g, '') ?? ''
const pasted = readDevPaste()
const url = normalizeSupabaseProjectUrl(pasted?.url || fromFileUrl)
const anon = (pasted?.anon || fromFileAnon).trim().replace(/\s+/g, '')

/** Project URL this build’s client calls (merged: dev Misconfigured paste wins over `web/.env`). */
export const effectiveSupabaseUrl = url

/** During `npm run dev`, truthy when URL/anon came from Misconfigured browser storage, not `.env` alone. */
export const devSupabasePasteOverridesEnv =
  Boolean(import.meta.env.DEV && pasted?.url && pasted?.anon)

if (!url || !anon) {
  console.warn(
    '[Orion Social] Set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY in web/.env (restart Vite), or use the dev Misconfigured shortcut.',
  )
}

function init(): { client: SupabaseClient | null; initError: string | null } {
  if (!url || !anon) return { client: null, initError: null }
  try {
    return {
      client: createClient(url, anon, {
        auth: { persistSession: true, autoRefreshToken: true },
      }),
      initError: null,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[Orion Social] createClient:', e)
    return { client: null, initError: msg }
  }
}

const { client: builtClient, initError: builtInitError } = init()

/** Non-null means createClient threw (prevents silent white screen). */
export const supabaseInitError: string | null = builtInitError

export const supabase: SupabaseClient | null = builtInitError ? null : builtClient

export function persistDevSupabasePaste(durl: string, danon: string) {
  const payload = JSON.stringify({ url: normalizeSupabaseProjectUrl(durl), anon: danon })
  try {
    sessionStorage.setItem(SUPABASE_DEV_SESSION_KEY, payload)
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(SUPABASE_DEV_SESSION_KEY, payload)
  } catch {
    /* ignore */
  }
}

export function clearDevSupabasePaste() {
  if (typeof window !== 'undefined') {
    try {
      sessionStorage.removeItem(SUPABASE_DEV_SESSION_KEY)
    } catch {
      /* ignore */
    }
    try {
      localStorage.removeItem(SUPABASE_DEV_SESSION_KEY)
    } catch {
      /* ignore */
    }
  }
}

export type Profile = {
  id: string
  display_name: string
  created_at: string
  seal_pubkey_jwk?: string | null
  orion_login_pubkey_jwk?: string | null
  orion_key_required?: boolean | null
  orion_key_enrolled_at?: string | null
  avatar_url?: string | null
  bio?: string | null
  /** App / live heartbeat for friends ONLINE status */
  last_seen_at?: string | null
}
export type Msg = {
  id: string
  conversation_id: string
  sender_id: string
  body: string
  is_orion_sealed: boolean
  created_at: string
  edited_at?: string | null
}

export type FriendConnection = {
  id: string
  requester_id: string
  addressee_id: string
  user_low: string
  user_high: string
  status: 'pending' | 'accepted'
  created_at: string
  responded_at: string | null
}

export type OrionReel = {
  id: string
  creator_id: string
  video_url: string
  hls_url: string | null
  thumbnail_url: string | null
  caption: string
  visibility: 'public' | 'friends' | 'private'
  moderation_status: 'draft' | 'published' | 'held' | 'removed'
  duration_seconds: number | null
  created_at: string
  updated_at: string
}

export type OrionReelLike = {
  reel_id: string
  user_id: string
  created_at: string
}

export type OrionReelComment = {
  id: string
  reel_id: string
  user_id: string
  body: string
  created_at: string
}

export type BattleLeagueWin = {
  id: string
  user_id: string
  display_name_snapshot: string
  conversation_id: string | null
  winner_team: 'alpha' | 'omega'
  loser_team: 'alpha' | 'omega'
  break_score: number
  points: number
  created_at: string
}

export type LiveLikeEvent = {
  id: string
  conversation_id: string
  from_user_id: string
  to_user_id: string
  from_display_name: string
  to_display_name: string
  room_title_snapshot: string
  delta: number
  created_at: string
}

export type ChatEmoji = {
  key: string
  unicode: string
  label: string
  category: string
  sort_order: number
  active: boolean
  created_at?: string
}

export type MessageEmojiReaction = {
  message_id: string
  user_id: string
  emoji_key: string
  created_at: string
}

export type OrionRivalry = {
  id: string
  challenger_id: string
  opponent_id: string
  challenger_wins: number
  opponent_wins: number
  total_battles: number
  declared_at: string
  last_battle_at: string | null
}
