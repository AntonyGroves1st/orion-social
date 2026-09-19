import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Profile } from '../lib/supabase'
import { supabase } from '../lib/supabase'
import { getOrCreateSealIdentity, sealPublicJwkString } from '../crypto/sealWrap'
import NodeModePanel from '../components/NodeModePanel'
import FriendsLiveRail from '../components/FriendsLiveRail'

import { lazyWithRetry } from '../lib/lazyWithRetry'

const LiveMap3D = lazyWithRetry(() => import('../components/LiveMap3D'))

type LiveListing = {
  id: string
  title: string | null
  kind: string
  live_listed: boolean
  live_category: string | null
}

export default function Lobby({ profile }: { profile: Profile }) {
  const nav = useNavigate()
  const [peopleCount, setPeopleCount] = useState(1)
  const [liveRooms, setLiveRooms] = useState<LiveListing[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [newLiveTitle, setNewLiveTitle] = useState('')

  /** Upload sealing public key once per device — private half never touches Supabase. */
  useEffect(() => {
    void (async () => {
      if (!supabase) return
      const pair = await getOrCreateSealIdentity()
      const pub = await sealPublicJwkString(pair)
      if (profile.seal_pubkey_jwk === pub) return
      await supabase.from('profiles').update({ seal_pubkey_jwk: pub }).eq('id', profile.id)
    })()
  }, [profile.id, profile.seal_pubkey_jwk])

  useEffect(() => {
    if (!supabase) return
    const client = supabase

    const refreshLives = async () => {
      let lives: LiveListing[] | null = null
      const withCategory = await client
        .from('conversations')
        .select('id,title,kind,live_listed,live_category')
        .eq('kind', 'live')
        .eq('live_listed', true)
        .order('live_category', { ascending: true, nullsFirst: false })
        .order('title', { ascending: true })
        .limit(40)
      if (!withCategory.error) {
        lives = (withCategory.data ?? []) as LiveListing[]
      } else {
        const basic = await client
          .from('conversations')
          .select('id,title,kind,live_listed')
          .eq('kind', 'live')
          .eq('live_listed', true)
          .order('title', { ascending: true })
          .limit(40)
        lives = ((basic.data ?? []) as Omit<LiveListing, 'live_category'>[]).map((row) => ({
          ...row,
          live_category: null,
        }))
      }
      setLiveRooms(lives || [])
    }

    void (async () => {
      const [{ count }] = await Promise.all([
        client.from('profiles').select('id', { count: 'exact', head: true }),
        refreshLives(),
      ])
      setPeopleCount(count ?? 1)
    })()

    const chan = client
      .channel('lobby-live-rooms')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'conversations' },
        () => void refreshLives(),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'conversations' },
        () => void refreshLives(),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'conversation_members' },
        () => void refreshLives(),
      )

    void chan.subscribe()

    return () => {
      client.removeChannel(chan)
    }
  }, [])

  async function createLive() {
    if (!supabase) return
    setBusy('create-live')
    const { data, error } = await supabase.rpc('create_live_room', {
      display_title: newLiveTitle.trim() || 'Live',
    })
    setBusy(null)
    if (error || !data) return alert(error?.message ?? 'Could not create room')
    setNewLiveTitle('')
    nav(`/call/${data as string}`)
  }

  async function joinLive(cid: string) {
    if (!supabase) return
    setBusy(`join:${cid}`)
    const { leaveOtherLiveRooms } = await import('../lib/friendsLive')
    await leaveOtherLiveRooms(cid, profile.id)
    const { error } = await supabase.rpc('join_live_room', {
      p_conversation_id: cid,
    })
    setBusy(null)
    if (error) return alert(error.message)
    nav(`/call/${cid}`)
  }

  return (
    <div className="lobby-page studio-page">
      <header className="page-head">
        <div>
          <div className="section-kicker font-mono">LIVE NETWORK</div>
          <h2>Orion lobby</h2>
          <p className="page-intro">
            The lobby is now focused on the live map and host controls. Friends, people, and Reels are inside your profile dashboard.
          </p>
        </div>
        <button className="secondary" type="button" onClick={() => nav('/profile')}>
          Open profile
        </button>
      </header>

      <FriendsLiveRail profile={profile} variant="rail" />

      <React.Suspense
        fallback={
          <section className="live-map-shell" aria-label="Live network map loading">
            <div className="live-map-canvas-wrap live-map-loading font-mono">ORION MAP LOADING</div>
          </section>
        }
      >
        <LiveMap3D rooms={liveRooms} peopleCount={peopleCount} currentUserName={profile.display_name} onOpenRoom={joinLive} />
      </React.Suspense>

      {liveRooms.length > 0 && (
        <div className="live-category-strip font-mono" aria-label="Main live categories">
          {liveRooms.map((room) => (
            <button
              key={room.id}
              type="button"
              className="live-category-chip"
              disabled={busy === `join:${room.id}`}
              onClick={() => void joinLive(room.id)}
            >
              {room.title?.trim() || room.live_category || 'Live'}
            </button>
          ))}
        </div>
      )}

      <div className="live-launch-strip">
        <div>
          <div className="section-kicker font-mono">HOST CONTROL</div>
          <strong>Start a live room</strong>
        </div>
        <input type="text" placeholder="Room title..." value={newLiveTitle} onChange={(e) => setNewLiveTitle(e.target.value)} aria-label="Live room title" />
        <button className="primary" type="button" disabled={busy === 'create-live'} onClick={() => void createLive()}>
          {busy === 'create-live' ? '...' : 'Go live'}
        </button>
      </div>

      <NodeModePanel profile={profile} />
    </div>
  )
}
