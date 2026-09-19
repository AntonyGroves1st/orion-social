import React, { type FormEvent, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import FriendHub from '../components/FriendHub'
import FriendsLiveRail from '../components/FriendsLiveRail'
import OrionScore from '../components/OrionScore'
import RivalryPanel from '../components/RivalryPanel'
import type { Profile as MemberProfile } from '../lib/supabase'
import { supabase } from '../lib/supabase'
import ProfileAvatar from '../components/ProfileAvatar'
import { avatarImageSrc, cropAvatarFileToSquare } from '../lib/profileAvatar'
import Reels from './Reels'

type ProfileStats = {
  friends: number
  reels: number
  liveRooms: number
  likesReceived: number
}

type ProfileForm = {
  displayName: string
  avatarUrl: string
  bio: string
}

export default function Profile({ me, onProfileUpdated }: { me: MemberProfile; onProfileUpdated?: (profile: MemberProfile) => void }) {
  const location = useLocation()
  const [current, setCurrent] = useState(me)
  const [stats, setStats] = useState<ProfileStats>({ friends: 0, reels: 0, liveRooms: 0, likesReceived: 0 })
  const [form, setForm] = useState<ProfileForm>({
    displayName: me.display_name,
    avatarUrl: me.avatar_url ?? '',
    bio: me.bio ?? '',
  })
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [profileErr, setProfileErr] = useState<string | null>(null)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const avatarFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setCurrent(me)
    setForm({
      displayName: me.display_name,
      avatarUrl: me.avatar_url ?? '',
      bio: me.bio ?? '',
    })
  }, [me])

  useEffect(() => {
    if (!location.hash) return
    const target = document.querySelector(location.hash)
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [location.hash])

  useEffect(() => {
    ;(async () => {
      if (!supabase) return
      const [{ count: friendCount }, { count: reelCount }, { count: liveCount }, likesRes] = await Promise.all([
        supabase
          .from('friend_connections')
          .select('id', { count: 'exact', head: true })
          .or(`requester_id.eq.${current.id},addressee_id.eq.${current.id}`)
          .eq('status', 'accepted'),
        supabase.from('orion_reels').select('id', { count: 'exact', head: true }).eq('creator_id', current.id),
        supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('kind', 'live').eq('live_listed', true),
        supabase.from('live_like_events').select('delta').eq('to_user_id', current.id).limit(5000),
      ])
      const likesReceived = ((likesRes.data ?? []) as Array<{ delta: number }>).reduce(
        (sum, row) => sum + (row.delta || 0),
        0,
      )
      setStats({
        friends: friendCount ?? 0,
        reels: reelCount ?? 0,
        liveRooms: liveCount ?? 0,
        likesReceived: likesRes.error ? 0 : likesReceived,
      })
    })()
  }, [current.id])

  async function handleAvatarUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file || !supabase) return
    if (file.size > 10 * 1024 * 1024) { alert('Max avatar size is 10 MB.'); return }
    setUploadingAvatar(true)
    let uploadBody: Blob = file
    let contentType = file.type || 'image/jpeg'
    try {
      uploadBody = await cropAvatarFileToSquare(file)
      contentType = 'image/jpeg'
    } catch {
      uploadBody = file
    }
    const path = `${current.id}/${Date.now()}.jpg`
    const { data, error } = await supabase.storage.from('orion-avatars').upload(path, uploadBody, {
      upsert: true,
      contentType,
    })
    setUploadingAvatar(false)
    if (error) {
      setProfileErr(`Avatar upload failed: ${error.message}`)
      return
    }
    const { data: { publicUrl } } = supabase.storage.from('orion-avatars').getPublicUrl(data.path)
    setSaveState('idle')
    setForm((next) => ({ ...next, avatarUrl: publicUrl }))
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    const displayName = form.displayName.trim()
    const avatarUrl = avatarImageSrc(form.avatarUrl)
    const bio = form.bio.trim()
    if (displayName.length < 2) {
      setProfileErr('Username needs at least 2 characters.')
      return
    }
    setSaveState('saving')
    setProfileErr(null)
    const { data, error } = await supabase
      .from('profiles')
      .update({
        display_name: displayName.slice(0, 120),
        avatar_url: avatarUrl || null,
        bio: bio || null,
      })
      .eq('id', current.id)
      .select('*')
      .single()
    setSaveState('idle')
    if (error) {
      setProfileErr(error.message)
      return
    }
    const updated = data as MemberProfile
    setCurrent(updated)
    onProfileUpdated?.(updated)
    setSaveState('saved')
    window.setTimeout(() => setSaveState('idle'), 1400)
  }

  return (
    <div className="profile-page studio-page">
      <header className="profile-hero">
        <ProfileAvatar
          src={current.avatar_url}
          name={current.display_name}
          size="md"
          className="profile-orb profile-orb--hero"
          title={current.display_name}
        />
        <div className="profile-hero-copy">
          <div className="section-kicker font-mono">MEMBER PROFILE</div>
          <h2>{current.display_name}</h2>
          <p className="page-intro">
            {current.bio?.trim() || 'Your Orion dashboard: identity, friends, member roster, Reels, and quick paths back into the live network.'}
          </p>
        </div>
        <div className="profile-actions">
          <Link className="secondary" to="/home">
            Live map
          </Link>
          <a className="primary" href="#reels">
            Orion Reels
          </a>
          <Link className="secondary" to="/support">
            Help
          </Link>
        </div>
      </header>

      <section className="profile-dashboard" aria-label="Profile dashboard">
        <div className="profile-stat">
          <span className="font-mono">Friends</span>
          <strong>{stats.friends}</strong>
        </div>
        <div className="profile-stat">
          <span className="font-mono">My reels</span>
          <strong>{stats.reels}</strong>
        </div>
        <div className="profile-stat">
          <span className="font-mono">Live rooms</span>
          <strong>{stats.liveRooms}</strong>
        </div>
        <div className="profile-stat">
          <span className="font-mono">Likes</span>
          <strong>{stats.likesReceived.toLocaleString()}</strong>
        </div>
        <div className="profile-stat profile-stat--wide">
          <span className="font-mono">Seal key</span>
          <strong>{current.seal_pubkey_jwk ? 'Ready' : 'Syncing'}</strong>
        </div>
        <OrionScore profileId={current.id} />
        <div className="profile-stat profile-stat--wide">
          <span className="font-mono">Like ranking</span>
          <strong>
            <Link to="/league" className="matrix-link-back" style={{ padding: 0 }}>
              Open Top 100 →
            </Link>
          </strong>
        </div>
      </section>

      <nav className="profile-tabs" aria-label="Profile sections">
        <a href="#edit-profile">Edit Profile</a>
        <a href="#friends-live">Live friends</a>
        <a href="#friends">Friends</a>
        <a href="#people">People</a>
        <a href="#reels">Reels</a>
        <Link to="/support">Help</Link>
      </nav>

      <FriendsLiveRail profile={current} variant="panel" />

      <section id="edit-profile" className="profile-section card elevate edit-profile-panel">
        <div>
          <div className="section-kicker font-mono">PROFILE SETTINGS</div>
          <h3 className="section-title">Edit profile</h3>
          <p className="page-intro">Change your public avatar image, username, and short bio for rooms, friends, and Reels.</p>
        </div>
        <form className="edit-profile-form" onSubmit={saveProfile}>
          <div className="edit-profile-preview">
            <ProfileAvatar
              src={form.avatarUrl || current.avatar_url}
              name={form.displayName || current.display_name}
              size="md"
              className="profile-orb profile-orb--preview"
              title="Avatar preview"
            />
            <div>
              <strong>{form.displayName.trim() || current.display_name}</strong>
              <span className="font-mono">{form.bio.trim() || 'No bio yet'}</span>
            </div>
          </div>
          <label>
            <span className="reels-label font-mono">Username</span>
            <input
              type="text"
              value={form.displayName}
              maxLength={120}
              onChange={(event) => {
                setSaveState('idle')
                setForm((next) => ({ ...next, displayName: event.target.value }))
              }}
              required
            />
          </label>
          <div>
            <span className="reels-label font-mono">Avatar image</span>
            <div className="profile-avatar-upload-row">
              <input
                type="url"
                value={form.avatarUrl}
                placeholder="https://.../avatar.png"
                maxLength={1000}
                onChange={(event) => {
                  setSaveState('idle')
                  setForm((next) => ({ ...next, avatarUrl: event.target.value }))
                }}
              />
              <button
                type="button"
                className="secondary"
                disabled={uploadingAvatar}
                onClick={() => avatarFileRef.current?.click()}
              >
                {uploadingAvatar ? 'Uploading...' : 'Upload photo'}
              </button>
            </div>
            <input
              ref={avatarFileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={(e) => void handleAvatarUpload(e)}
            />
          </div>
          <label>
            <span className="reels-label font-mono">Bio</span>
            <textarea
              rows={3}
              value={form.bio}
              maxLength={280}
              placeholder="Say what you host, create, or battle for..."
              onChange={(event) => {
                setSaveState('idle')
                setForm((next) => ({ ...next, bio: event.target.value }))
              }}
            />
          </label>
          {profileErr && (
            <div className="matrix-alert matrix-alert--warn font-mono" role="alert">
              <span className="matrix-alert-tag matrix-alert-tag--warn">SQL</span>
              {profileErr.includes('avatar_url') || profileErr.includes('bio') ? (
                <>
                  Run <code>npm run db:profile-fields</code> or paste <code>supabase/migrations/20260514013000_profile_fields.sql</code>.
                </>
              ) : (
                profileErr
              )}
            </div>
          )}
          <button className="primary" type="submit" disabled={saveState === 'saving'}>
            {saveState === 'saving' ? 'Saving...' : saveState === 'saved' ? 'Saved' : 'Save profile'}
          </button>
        </form>
      </section>

      <FriendHub profile={current} />

      <RivalryPanel profileId={current.id} displayName={current.display_name} />

      <section id="reels" className="profile-section">
        <Reels me={current} variant="profile" />
      </section>
    </div>
  )
}
