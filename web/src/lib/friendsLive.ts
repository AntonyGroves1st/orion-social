import type { FriendConnection, Profile } from './supabase'
import { supabase } from './supabase'

/** Friend must heartbeat / freshly join within this window to count as LIVE. */
export const FRIEND_PRESENCE_TTL_MS = 12 * 60_000

export type FriendPresence = 'live' | 'online' | 'offline'

export type FriendLiveItem = {
  userId: string
  displayName: string
  avatarUrl: string | null
  liveRoomId: string | null
  roomTitle: string | null
  liveRole: 'host' | 'member' | null
  presence: FriendPresence
  lastSeenAt: string | null
}

function otherUserId(row: FriendConnection, myId: string) {
  return row.requester_id === myId ? row.addressee_id : row.requester_id
}

type LiveRoomRow = {
  id: string
  title: string | null
  creator_id: string | null
  live_category?: string | null
}

type MemberRow = {
  user_id: string
  role: string | null
  conversation_id: string
  last_active_at?: string | null
  joined_at?: string | null
}

function isFresh(iso: string | null | undefined, now: number) {
  if (!iso) return false
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return false
  return now - t <= FRIEND_PRESENCE_TTL_MS
}

function activityMs(row: MemberRow) {
  return Math.max(Date.parse(row.last_active_at || '') || 0, Date.parse(row.joined_at || '') || 0)
}

function roomLabel(room: LiveRoomRow) {
  const title = room.title?.trim()
  if (title) return title
  const cat = room.live_category?.trim()
  if (cat) return cat.charAt(0).toUpperCase() + cat.slice(1)
  return 'Live'
}

/**
 * Remove the current user from a live room (RPC + delete fallback).
 * Returns true when membership row is gone or was already absent.
 */
export async function leaveLiveRoomMembership(conversationId: string, userId: string): Promise<boolean> {
  if (!supabase || !conversationId || !userId) return false
  const client = supabase

  const { error: leaveErr } = await client.rpc('leave_live_room', { p_conversation_id: conversationId })
  if (!leaveErr) return true

  const { error: delErr } = await client
    .from('conversation_members')
    .delete()
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
  if (delErr) {
    console.warn('[leaveLiveRoomMembership]', leaveErr.message, delErr.message)
    return false
  }

  const { count } = await client
    .from('conversation_members')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
  if (count === 0) {
    await client
      .from('conversations')
      .update({ creator_id: null, live_stage_slots: [] })
      .eq('id', conversationId)
      .eq('kind', 'live')
  }
  return true
}

/**
 * Drop every other live membership before joining (fixes Culture ghost while in Sports).
 * Best-effort — needs leave_live_room SQL; falls back to direct deletes.
 */
export async function leaveOtherLiveRooms(keepConversationId: string, userId: string) {
  if (!supabase || !keepConversationId || !userId) return
  const client = supabase
  const { data: lives } = await client
    .from('conversations')
    .select('id')
    .eq('kind', 'live')
    .eq('live_listed', true)
    .limit(80)
  const ids = ((lives ?? []) as { id: string }[]).map((r) => r.id).filter((id) => id !== keepConversationId)
  if (!ids.length) return

  const { data: rows } = await client
    .from('conversation_members')
    .select('conversation_id')
    .eq('user_id', userId)
    .in('conversation_id', ids)

  for (const row of (rows ?? []) as { conversation_id: string }[]) {
    await leaveLiveRoomMembership(row.conversation_id, userId)
  }
}

/**
 * Top friends rail — LIVE only in the room they are *freshly* active in.
 * Never trust stale stage slots alone (that caused "IN Culture" while in Sports).
 */
export async function loadTopFriendsLive(myId: string, limit = 20): Promise<FriendLiveItem[]> {
  if (!supabase) return []

  void supabase.rpc('cleanup_stale_live_memberships').then(
    () => undefined,
    () => undefined,
  )

  const { data: friendshipRows, error: friendErr } = await supabase
    .from('friend_connections')
    .select('*')
    .or(`requester_id.eq.${myId},addressee_id.eq.${myId}`)
    .eq('status', 'accepted')
    .order('created_at', { ascending: false })
    .limit(80)

  if (friendErr || !friendshipRows?.length) return []

  const peerIds = [...new Set((friendshipRows as FriendConnection[]).map((row) => otherUserId(row, myId)))]
  if (!peerIds.length) return []

  const [{ data: profiles }, { data: lives }] = await Promise.all([
    (async () => {
      const withSeen = await supabase
        .from('profiles')
        .select('id,display_name,avatar_url,last_seen_at')
        .in('id', peerIds)
      if (!withSeen.error) return withSeen
      return supabase.from('profiles').select('id,display_name,avatar_url').in('id', peerIds)
    })(),
    supabase
      .from('conversations')
      .select('id,title,creator_id,live_category')
      .eq('kind', 'live')
      .eq('live_listed', true)
      .limit(60),
  ])

  const liveRooms = ((lives ?? []) as LiveRoomRow[]) || []
  const liveById = new Map(liveRooms.map((r) => [r.id, r]))
  const liveIds = liveRooms.map((r) => r.id)
  const now = Date.now()

  let memberships: MemberRow[] = []
  if (liveIds.length) {
    const withActive = await supabase
      .from('conversation_members')
      .select('user_id, role, conversation_id, last_active_at, joined_at')
      .in('user_id', peerIds)
      .in('conversation_id', liveIds)
    if (!withActive.error) {
      memberships = ((withActive.data ?? []) as MemberRow[]) || []
    } else {
      const basic = await supabase
        .from('conversation_members')
        .select('user_id, role, conversation_id, joined_at')
        .in('user_id', peerIds)
        .in('conversation_id', liveIds)
      memberships = ((basic.data ?? []) as MemberRow[]) || []
    }
  }

  type LivePick = {
    id: string
    title: string | null
    liveRole: 'host' | 'member'
    activityMs: number
    hasHeartbeat: boolean
  }
  const liveByFriend = new Map<string, LivePick>()

  for (const row of memberships) {
    const room = liveById.get(row.conversation_id)
    if (!room) continue

    const activeFresh = isFresh(row.last_active_at, now)
    const joinedFresh = isFresh(row.joined_at, now)
    /*
     * LIVE only with a fresh heartbeat or fresh join.
     * Do NOT use stale live_stage_slots — ghosts stay "on stage" in Culture forever.
     */
    if (!activeFresh && !joinedFresh) continue

    const roleRaw = (row.role ?? '').toLowerCase()
    const isHost = roleRaw === 'host' || room.creator_id === row.user_id
    const next: LivePick = {
      id: room.id,
      title: roomLabel(room),
      liveRole: isHost ? 'host' : 'member',
      activityMs: activityMs(row),
      hasHeartbeat: Boolean(row.last_active_at),
    }
    const prev = liveByFriend.get(row.user_id)
    if (!prev) {
      liveByFriend.set(row.user_id, next)
      continue
    }
    /* Prefer heartbeat room over join-only ghost; then most recent activity. */
    if (next.hasHeartbeat && !prev.hasHeartbeat && activeFresh) {
      liveByFriend.set(row.user_id, next)
    } else if (next.hasHeartbeat === prev.hasHeartbeat && next.activityMs > prev.activityMs) {
      liveByFriend.set(row.user_id, next)
    } else if (next.activityMs === prev.activityMs && next.liveRole === 'host' && prev.liveRole !== 'host') {
      liveByFriend.set(row.user_id, next)
    }
  }

  type ProfileRow = Pick<Profile, 'id' | 'display_name' | 'avatar_url'> & { last_seen_at?: string | null }
  const profileById = new Map((((profiles ?? []) as ProfileRow[]) || []).map((p) => [p.id, p]))

  const items: FriendLiveItem[] = peerIds.map((userId) => {
    const profile = profileById.get(userId)
    const live = liveByFriend.get(userId)
    const lastSeenAt = profile?.last_seen_at ?? null
    let presence: FriendPresence = 'offline'
    if (live) presence = 'live'
    else if (isFresh(lastSeenAt, now)) presence = 'online'

    return {
      userId,
      displayName: profile?.display_name?.trim() || `Friend ${userId.slice(-4)}`,
      avatarUrl: profile?.avatar_url ?? null,
      liveRoomId: live?.id ?? null,
      roomTitle: live?.title ?? null,
      liveRole: live?.liveRole ?? null,
      presence,
      lastSeenAt,
    }
  })

  items.sort((a, b) => {
    const rank = (x: FriendLiveItem) => (x.presence === 'live' ? 2 : x.presence === 'online' ? 1 : 0)
    const d = rank(b) - rank(a)
    if (d !== 0) return d
    if (a.presence === 'live' && b.presence === 'live') {
      const hostDelta = (b.liveRole === 'host' ? 1 : 0) - (a.liveRole === 'host' ? 1 : 0)
      if (hostDelta !== 0) return hostDelta
    }
    return a.displayName.localeCompare(b.displayName)
  })

  return items.slice(0, limit)
}
