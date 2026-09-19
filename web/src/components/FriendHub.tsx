import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { FriendConnection, Profile } from '../lib/supabase'
import { supabase } from '../lib/supabase'

type FriendState = 'none' | 'incoming' | 'outgoing' | 'friends'

function otherUserId(row: FriendConnection, myId: string) {
  return row.requester_id === myId ? row.addressee_id : row.requester_id
}

function friendshipState(row: FriendConnection | undefined, myId: string): FriendState {
  if (!row) return 'none'
  if (row.status === 'accepted') return 'friends'
  return row.addressee_id === myId ? 'incoming' : 'outgoing'
}

export default function FriendHub({ profile }: { profile: Profile }) {
  const nav = useNavigate()
  const [people, setPeople] = useState<Profile[]>([])
  const [friendships, setFriendships] = useState<FriendConnection[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [friendSearch, setFriendSearch] = useState('')
  const [friendsErr, setFriendsErr] = useState<string | null>(null)

  const loadFriends = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase
      .from('friend_connections')
      .select('*')
      .or(`requester_id.eq.${profile.id},addressee_id.eq.${profile.id}`)
      .order('created_at', { ascending: false })
    if (error) {
      setFriendsErr(error.message)
      setFriendships([])
      return
    }
    setFriendsErr(null)
    setFriendships(((data ?? []) as FriendConnection[]) || [])
  }, [profile.id])

  useEffect(() => {
    ;(async () => {
      if (!supabase) return
      const { data: roster } = await supabase.from('profiles').select('*').neq('id', profile.id).order('display_name')
      setPeople(((roster ?? []) as Profile[]) || [])
      await loadFriends()
    })()
  }, [loadFriends, profile.id])

  useEffect(() => {
    if (!supabase) return
    const client = supabase
    const requesterChannel = client
      .channel(`friends-requester:${profile.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'friend_connections', filter: `requester_id=eq.${profile.id}` },
        () => void loadFriends(),
      )
      .subscribe()
    const addresseeChannel = client
      .channel(`friends-addressee:${profile.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'friend_connections', filter: `addressee_id=eq.${profile.id}` },
        () => void loadFriends(),
      )
      .subscribe()

    return () => {
      client.removeChannel(requesterChannel)
      client.removeChannel(addresseeChannel)
    }
  }, [loadFriends, profile.id])

  const friendshipByPeer = useMemo(() => {
    const map = new Map<string, FriendConnection>()
    for (const row of friendships) map.set(otherUserId(row, profile.id), row)
    return map
  }, [friendships, profile.id])

  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people])
  const acceptedFriends = friendships.filter((f) => f.status === 'accepted')
  const incomingRequests = friendships.filter((f) => f.status === 'pending' && f.addressee_id === profile.id)
  const outgoingRequests = friendships.filter((f) => f.status === 'pending' && f.requester_id === profile.id)
  const filteredPeople = people.filter((p) => p.display_name.toLowerCase().includes(friendSearch.trim().toLowerCase()))

  async function openDm(peerId: string) {
    if (!supabase) return
    setBusy(peerId)
    const { data, error } = await supabase.rpc('ensure_dm', { peer_id: peerId })
    setBusy(null)
    if (error || !data) return alert(error?.message ?? 'Could not create DM')
    nav(`/chat/${data as string}?peer=${peerId}`)
  }

  function openVideo(peerId: string, conversationId: string) {
    nav(`/call/${conversationId}?peer=${peerId}`)
  }

  async function sendFriendRequest(peerId: string) {
    if (!supabase) return
    setBusy(`friend:${peerId}`)
    const { error } = await supabase.rpc('send_friend_request', { peer_id: peerId })
    setBusy(null)
    if (error) return alert(error.message)
    await loadFriends()
  }

  async function respondFriendRequest(requestId: string, accept: boolean) {
    if (!supabase) return
    setBusy(`respond:${requestId}`)
    const { error } = await supabase.rpc('respond_friend_request', { request_id: requestId, accept })
    setBusy(null)
    if (error) return alert(error.message)
    await loadFriends()
  }

  async function removeFriend(peerId: string) {
    if (!supabase) return
    const state = friendshipState(friendshipByPeer.get(peerId), profile.id)
    const ok =
      state === 'friends'
        ? window.confirm('Remove this friend?')
        : state === 'outgoing'
          ? window.confirm('Cancel this friend request?')
          : true
    if (!ok) return
    setBusy(`remove:${peerId}`)
    const { error } = await supabase.rpc('remove_friend', { peer_id: peerId })
    setBusy(null)
    if (error) return alert(error.message)
    await loadFriends()
  }

  function renderFriendActions(person: Profile) {
    const row = friendshipByPeer.get(person.id)
    const state = friendshipState(row, profile.id)
    if (state === 'incoming' && row) {
      return (
        <>
          <button className="primary" type="button" disabled={busy === `respond:${row.id}`} onClick={() => void respondFriendRequest(row.id, true)}>
            Accept
          </button>
          <button className="secondary" type="button" disabled={busy === `respond:${row.id}`} onClick={() => void respondFriendRequest(row.id, false)}>
            Decline
          </button>
        </>
      )
    }
    if (state === 'outgoing') {
      return (
        <button className="secondary friend-action--muted" type="button" disabled={busy === `remove:${person.id}`} onClick={() => void removeFriend(person.id)}>
          Requested
        </button>
      )
    }
    if (state === 'friends') {
      return (
        <>
          <span className="friend-status-pill friend-status-pill--friends font-mono">Friend</span>
          <button className="secondary" type="button" disabled={busy === `remove:${person.id}`} onClick={() => void removeFriend(person.id)}>
            Remove
          </button>
        </>
      )
    }
    return (
      <button className="primary" type="button" disabled={busy === `friend:${person.id}`} onClick={() => void sendFriendRequest(person.id)}>
        {busy === `friend:${person.id}` ? 'Sending' : 'Add friend'}
      </button>
    )
  }

  function renderCompactFriend(row: FriendConnection, action: 'incoming' | 'friend') {
    const peerId = otherUserId(row, profile.id)
    const person = peopleById.get(peerId)
    const label = person?.display_name ?? peerId.slice(0, 8)
    return (
      <div key={row.id} className="friend-mini-row">
        <div className="row" style={{ gap: 9 }}>
          <div className="member-avatar member-avatar--sm" aria-hidden />
          <div>
            <strong>{label}</strong>
            <div className="friend-subline font-mono">{action === 'incoming' ? 'Wants to connect' : 'Connected'}</div>
          </div>
        </div>
        <div className="row">
          {action === 'incoming' ? (
            <>
              <button className="primary" type="button" onClick={() => void respondFriendRequest(row.id, true)}>
                Accept
              </button>
              <button className="secondary" type="button" onClick={() => void respondFriendRequest(row.id, false)}>
                Decline
              </button>
            </>
          ) : (
            <>
              <button className="secondary" type="button" onClick={() => void openDm(peerId)}>
                Message
              </button>
              <button className="secondary" type="button" onClick={() => void removeFriend(peerId)}>
                Remove
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="friend-hub">
      <section id="friends" className="card elevate friends-console">
        <div className="friends-console-head">
          <div>
            <div className="section-kicker font-mono">SOCIAL GRAPH</div>
            <h3 className="section-title">Friends</h3>
            <p className="page-intro">Requests, DMs, video calls, and your trusted member list now live inside the profile dashboard.</p>
          </div>
          <div className="friend-stats font-mono">
            <span>{acceptedFriends.length} friends</span>
            <span>{incomingRequests.length} incoming</span>
            <span>{outgoingRequests.length} sent</span>
          </div>
        </div>

        {friendsErr && (
          <div className="matrix-alert matrix-alert--warn font-mono" role="alert">
            <span className="matrix-alert-tag matrix-alert-tag--warn">SQL</span>
            Friends need the new migration. Run <code>npm run db:friends</code> or paste{' '}
            <code>supabase/migrations/20260514001000_friend_system.sql</code> in Supabase SQL.
          </div>
        )}

        <div className="friend-grid">
          <div className="friend-panel">
            <div className="friend-panel-title font-mono">Incoming requests</div>
            {incomingRequests.length === 0 ? <div className="empty-hint">No pending requests.</div> : incomingRequests.map((row) => renderCompactFriend(row, 'incoming'))}
          </div>
          <div className="friend-panel">
            <div className="friend-panel-title font-mono">Your friends</div>
            {acceptedFriends.length === 0 ? <div className="empty-hint">No friends yet. Add members from the roster below.</div> : acceptedFriends.map((row) => renderCompactFriend(row, 'friend'))}
          </div>
        </div>
      </section>

      <div id="people" className="people-head">
        <div>
          <h3 className="section-title" style={{ marginTop: 8 }}>
            People
          </h3>
          <p className="page-intro">Search the member roster and build your friend network.</p>
        </div>
        <input className="people-search font-mono" type="search" value={friendSearch} onChange={(e) => setFriendSearch(e.target.value)} placeholder="Search members..." aria-label="Search members" />
      </div>
      <div className="cards">
        {people.length === 0 && <div className="empty-hint">You are solo for now. Invite others with your Supabase auth + invite flow.</div>}
        {filteredPeople.map((p) => (
          <div key={p.id} className="card card--member member-row">
            <div className="row member-identity">
              <div className="member-avatar" aria-hidden />
              <div>
                <div style={{ fontWeight: 700 }}>{p.display_name}</div>
                <div className="friend-subline font-mono">{p.id.slice(0, 8)} · member</div>
              </div>
            </div>
            <div className="row member-actions">
              {renderFriendActions(p)}
              <button className="secondary" type="button" disabled={busy === p.id} onClick={() => void openDm(p.id)}>
                {busy === p.id ? '...' : 'Message'}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={busy === `v-${p.id}`}
                onClick={async () => {
                  if (!supabase) return
                  setBusy(`v-${p.id}`)
                  const { data, error } = await supabase.rpc('ensure_dm', { peer_id: p.id })
                  setBusy(null)
                  if (error || !data) return alert(error?.message ?? 'DM required')
                  openVideo(p.id, data as string)
                }}
              >
                Video
              </button>
            </div>
          </div>
        ))}
        {people.length > 0 && filteredPeople.length === 0 && <div className="empty-hint">No members match that search.</div>}
      </div>
    </div>
  )
}
