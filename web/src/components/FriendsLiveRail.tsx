import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Profile } from '../lib/supabase'
import { supabase } from '../lib/supabase'
import { loadTopFriendsLive, leaveOtherLiveRooms, type FriendLiveItem } from '../lib/friendsLive'
import { useFriendPresenceHeartbeat } from '../lib/useFriendPresence'
import ProfileAvatar from './ProfileAvatar'

type Props = {
  profile: Profile
  /** Compact strip for lobby; full panel for profile tab */
  variant?: 'rail' | 'panel'
  className?: string
}

/**
 * Drag → horizontal scroll without setPointerCapture on chips.
 * Capture was stealing tap/click so LIVE join felt dead.
 */
function useDragSideScroll(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let dragging = false
    let startX = 0
    let startScroll = 0
    let moved = false
    let activePointer: number | null = null

    const markConsumed = () => {
      el.dataset.dragConsumed = '1'
      window.setTimeout(() => {
        delete el.dataset.dragConsumed
      }, 160)
    }

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const hit = e.target as HTMLElement | null
      if (hit?.closest('input, textarea, select')) return
      dragging = true
      moved = false
      activePointer = e.pointerId
      startX = e.clientX
      startScroll = el.scrollLeft
    }

    const onMove = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== activePointer) return
      const dx = e.clientX - startX
      if (Math.abs(dx) <= 10) return
      if (!moved) {
        moved = true
        el.classList.add('friends-live-scroll--dragging')
      }
      el.scrollLeft = startScroll - dx
      e.preventDefault()
    }

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== activePointer) return
      const wasMoved = moved
      dragging = false
      activePointer = null
      el.classList.remove('friends-live-scroll--dragging')
      if (wasMoved) markConsumed()
    }

    el.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [ref])
}

/**
 * Top 20 friends rail — live hosts first, online next, search, drag-scroll, tap to join.
 */
export default function FriendsLiveRail({ profile, variant = 'rail', className = '' }: Props) {
  const nav = useNavigate()
  const scrollRef = useRef<HTMLDivElement>(null)
  const joiningRef = useRef(false)
  const [items, setItems] = useState<FriendLiveItem[]>([])
  const [search, setSearch] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useDragSideScroll(scrollRef)
  useFriendPresenceHeartbeat(true)

  const refresh = useCallback(async () => {
    if (!supabase) {
      setItems([])
      setLoading(false)
      return
    }
    try {
      const next = await loadTopFriendsLive(profile.id, 80)
      setItems(next)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load friends')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [profile.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!supabase) return
    const client = supabase
    const chan = client
      .channel(`friends-live-rail:${profile.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members' }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friend_connections' }, () => void refresh())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, () => void refresh())
      .subscribe()
    const tick = window.setInterval(() => void refresh(), 20_000)
    return () => {
      client.removeChannel(chan)
      window.clearInterval(tick)
    }
  }, [profile.id, refresh])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const pool = q
      ? items.filter(
          (item) =>
            item.displayName.toLowerCase().includes(q) ||
            (item.roomTitle?.toLowerCase().includes(q) ?? false),
        )
      : items
    return pool.slice(0, q ? 40 : 20)
  }, [items, search])

  const liveCount = filtered.filter((i) => i.presence === 'live').length
  const onlineCount = filtered.filter((i) => i.presence === 'online').length

  async function joinFriendLive(item: FriendLiveItem) {
    if (!item.liveRoomId || !supabase || joiningRef.current) return
    if (scrollRef.current?.dataset.dragConsumed === '1') return
    const roomId = item.liveRoomId
    joiningRef.current = true
    setBusyId(item.userId)
    setErr(null)
    try {
      await leaveOtherLiveRooms(roomId, profile.id)
      const { error } = await supabase.rpc('join_live_room', {
        p_conversation_id: roomId,
      })
      if (error && !/already|member|duplicate/i.test(error.message)) {
        setErr(error.message)
        alert(error.message)
        return
      }
      nav(`/call/${roomId}`)
    } catch (joinErr) {
      const msg = joinErr instanceof Error ? joinErr.message : 'Could not join live'
      setErr(msg)
      alert(msg)
    } finally {
      joiningRef.current = false
      setBusyId(null)
    }
  }

  return (
    <section
      className={`friends-live-rail friends-live-rail--${variant}${className ? ` ${className}` : ''}`}
      aria-label="Friends live"
      id={variant === 'panel' ? 'friends-live' : undefined}
    >
      <div className="friends-live-rail-head">
        <div>
          <div className="section-kicker font-mono">FRIENDS LIVE</div>
          {variant === 'panel' && <h3 className="section-title">Friends · live & online</h3>}
          <p className="friends-live-rail-sub font-mono">
            {loading
              ? 'Loading…'
              : liveCount > 0 || onlineCount > 0
                ? `${liveCount} live · ${onlineCount} online · tap LIVE to join`
                : filtered.length > 0
                  ? 'No friends live or online right now'
                  : search.trim()
                    ? 'No friends match that search'
                    : 'Add friends to see them here when they go live'}
          </p>
        </div>
        {err && <span className="friends-live-rail-err font-mono">{err}</span>}
      </div>

      <label className="friends-live-search-wrap">
        <input
          className="friends-live-search font-mono"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search friends…"
          aria-label="Search friends"
          autoComplete="off"
          enterKeyHint="search"
        />
      </label>

      <div ref={scrollRef} className="friends-live-scroll" role="list" aria-label="Top 20 friends">
        {filtered.length === 0 && !loading && (
          <div className="friends-live-empty font-mono" role="listitem">
            {search.trim()
              ? 'No match — try another name'
              : 'No friends yet — open Friends to add people'}
          </div>
        )}
        {filtered.map((item) => {
          const isLive = item.presence === 'live' && Boolean(item.liveRoomId)
          const isOnline = item.presence === 'online'
          const isHost = item.liveRole === 'host'
          const busy = busyId === item.userId
          const roomLabel = item.roomTitle?.trim() || 'Live'
          return (
            <button
              key={item.userId}
              type="button"
              role="listitem"
              className={`friends-live-chip${isLive ? ' friends-live-chip--live' : isOnline ? ' friends-live-chip--online' : ' friends-live-chip--idle'}${isHost ? ' friends-live-chip--host' : ''}${busy ? ' friends-live-chip--busy' : ''}`}
              disabled={busy || !isLive}
              title={
                isLive
                  ? `${isHost ? 'Hosting' : 'In'} ${roomLabel} — tap to join`
                  : isOnline
                    ? `${item.displayName} · online (not in a live)`
                    : `${item.displayName} · offline`
              }
              onClick={(ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                if (!isLive || busy) return
                void joinFriendLive(item)
              }}
            >
              <span className="friends-live-avatar-wrap">
                <ProfileAvatar src={item.avatarUrl} name={item.displayName} size="md" />
                {isLive && <span className="friends-live-dot" aria-hidden />}
                {isOnline && !isLive && <span className="friends-live-dot friends-live-dot--online" aria-hidden />}
              </span>
              <span className="friends-live-name">{item.displayName}</span>
              {isLive ? (
                <span className="friends-live-tag font-mono">{isHost ? 'LIVE' : 'IN'}</span>
              ) : isOnline ? (
                <span className="friends-live-tag friends-live-tag--online font-mono">ON</span>
              ) : (
                <span className="friends-live-tag friends-live-tag--off font-mono">OFF</span>
              )}
              {isLive && (
                <span className="friends-live-room font-mono" title={roomLabel}>
                  {roomLabel}
                </span>
              )}
              {isOnline && !isLive && (
                <span className="friends-live-room friends-live-room--online font-mono">In app</span>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}
