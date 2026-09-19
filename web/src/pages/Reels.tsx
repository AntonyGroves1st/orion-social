import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ProfileAvatar from '../components/ProfileAvatar'
import { isNativeShell } from '../lib/nativeShell'
import type { OrionReel, OrionReelComment, OrionReelLike, Profile } from '../lib/supabase'
import { supabase } from '../lib/supabase'

type ReelForm = {
  videoUrl: string
  thumbnailUrl: string
  caption: string
  topic: string
  visibility: OrionReel['visibility']
}

const emptyForm: ReelForm = {
  videoUrl: '',
  thumbnailUrl: '',
  caption: '',
  topic: 'battle',
  visibility: 'public',
}

type ReelTopic = {
  id: string
  label: string
  prompt: string
  match: RegExp
}

type ReelFeedMode = 'live' | 'new' | 'latest' | 'viral' | 'battles' | 'following'

const REEL_TOPICS: ReelTopic[] = [
  { id: 'all', label: 'For You', prompt: 'Everything live now', match: /[\s\S]/ },
  { id: 'battle', label: 'Battles', prompt: 'Host hits, wins, and gift chaos', match: /#?battle|host|gift|godmode|snowball|vortex|dragon/i },
  { id: 'live', label: 'Live Rooms', prompt: 'Room clips and creator moments', match: /#?live|room|stream|camera|mesh|webrtc/i },
  { id: 'music', label: 'Music', prompt: 'Sounds, dance, edits', match: /#?music|song|sound|beat|dance|dj/i },
  { id: 'gaming', label: 'Gaming', prompt: 'Plays, raids, and clips', match: /#?gaming|game|play|raid|rank|boss/i },
  { id: 'funny', label: 'Funny', prompt: 'Fast laughs and reactions', match: /#?funny|lol|meme|comedy|reaction/i },
  { id: 'love', label: 'Love Room', prompt: 'Matches, shoutouts, soft launches', match: /#?love|date|crush|match|heart/i },
  { id: 'tech', label: 'Tech', prompt: 'Node mode, builds, AI, tools', match: /#?tech|node|ai|agent|build|tool|code/i },
]

const REEL_FEED_MODES: Array<{ id: ReelFeedMode; label: string; hint: string }> = [
  { id: 'live', label: 'Live', hint: 'Room and stream clips' },
  { id: 'new', label: 'New', hint: 'Posted in the last day' },
  { id: 'latest', label: 'Latest', hint: 'Fresh network drops' },
  { id: 'viral', label: 'Viral', hint: 'Most likes and comments' },
  { id: 'battles', label: 'Battles', hint: 'Host battle clips' },
  { id: 'following', label: 'Following', hint: 'Your own creator lane for now' },
]

type ReelsProps = {
  me: Profile
  variant?: 'discover' | 'profile'
}

function isProbablyVideoUrl(value: string) {
  const url = value.trim()
  if (!/^https?:\/\//i.test(url)) return false
  return isDirectVideoUrl(url) || isTikTokUrl(url)
}

function isDirectVideoUrl(value: string) {
  return /\.(mp4|mov|m4v|webm|m3u8)(\?|#|$)/i.test(value.trim())
}

function isTikTokUrl(value: string) {
  try {
    const url = new URL(value.trim())
    return /(^|\.)tiktok\.com$/i.test(url.hostname) || /(^|\.)tiktokcdn\.com$/i.test(url.hostname)
  } catch {
    return false
  }
}

function tiktokEmbedUrl(value: string) {
  try {
    const url = new URL(value.trim())
    const match = url.pathname.match(/\/video\/(\d+)/i)
    if (!match?.[1]) return null
    return `https://www.tiktok.com/embed/v2/${match[1]}`
  } catch {
    return null
  }
}

/** TikTok iframes block taps (Delete/Like) and show cookie walls on APK — use card + link instead. */
function preferTikTokLinkCard() {
  if (typeof window === 'undefined') return true
  if (isNativeShell()) return true
  return window.matchMedia('(max-width: 899px)').matches
}

function creatorName(profiles: Map<string, Profile>, id: string) {
  return profiles.get(id)?.display_name?.trim() || id.slice(0, 8)
}

function reelSearchText(reel: OrionReel, profiles: Map<string, Profile>) {
  return `${reel.caption ?? ''} ${reel.video_url ?? ''} ${creatorName(profiles, reel.creator_id)}`.toLowerCase()
}

function topicForReel(reel: OrionReel) {
  const text = `${reel.caption ?? ''} ${reel.video_url ?? ''}`
  return REEL_TOPICS.find((topic) => topic.id !== 'all' && topic.match.test(text)) ?? REEL_TOPICS[1]
}

function topicTag(topicId: string) {
  const topic = REEL_TOPICS.find((item) => item.id === topicId)
  return topic && topic.id !== 'all' ? `#${topic.label.replace(/\s+/g, '')}` : ''
}

export default function Reels({ me, variant = 'discover' }: ReelsProps) {
  const [reels, setReels] = useState<OrionReel[]>([])
  const [likes, setLikes] = useState<OrionReelLike[]>([])
  const [comments, setComments] = useState<OrionReelComment[]>([])
  const [profiles, setProfiles] = useState<Map<string, Profile>>(() => new Map())
  const [form, setForm] = useState<ReelForm>(emptyForm)
  const [selectedTopic, setSelectedTopic] = useState('all')
  const [feedMode, setFeedMode] = useState<ReelFeedMode>('latest')
  const [query, setQuery] = useState('')
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [uploadMode, setUploadMode] = useState<'url' | 'file'>('url')
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)
  const [uploadDone, setUploadDone] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isProfileMode = variant === 'profile'

  const reelIds = useMemo(() => reels.map((reel) => reel.id), [reels])
  const likesByReel = useMemo(() => {
    const map = new Map<string, OrionReelLike[]>()
    for (const like of likes) map.set(like.reel_id, [...(map.get(like.reel_id) ?? []), like])
    return map
  }, [likes])
  const commentsByReel = useMemo(() => {
    const map = new Map<string, OrionReelComment[]>()
    for (const comment of comments) map.set(comment.reel_id, [...(map.get(comment.reel_id) ?? []), comment])
    return map
  }, [comments])
  const visibleReels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const next = reels.filter((reel) => {
      if (isProfileMode && reel.creator_id !== me.id) return false
      if (selectedTopic !== 'all') {
        const topic = REEL_TOPICS.find((item) => item.id === selectedTopic)
        if (topic && !topic.match.test(`${reel.caption ?? ''} ${reel.video_url ?? ''}`)) return false
      }
      if (!isProfileMode && feedMode === 'live' && !REEL_TOPICS.find((topic) => topic.id === 'live')?.match.test(`${reel.caption ?? ''} ${reel.video_url ?? ''}`)) return false
      if (!isProfileMode && feedMode === 'battles' && !REEL_TOPICS.find((topic) => topic.id === 'battle')?.match.test(`${reel.caption ?? ''} ${reel.video_url ?? ''}`)) return false
      if (!isProfileMode && feedMode === 'new' && now - new Date(reel.created_at).getTime() > dayMs) return false
      if (!isProfileMode && feedMode === 'following' && reel.creator_id !== me.id) return false
      if (normalizedQuery && !reelSearchText(reel, profiles).includes(normalizedQuery)) return false
      return true
    })
    if (!isProfileMode && feedMode === 'viral') {
      return next.sort(
        (a, b) =>
          (likesByReel.get(b.id)?.length ?? 0) +
          (commentsByReel.get(b.id)?.length ?? 0) -
          ((likesByReel.get(a.id)?.length ?? 0) + (commentsByReel.get(a.id)?.length ?? 0)),
      )
    }
    return next.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }, [commentsByReel, feedMode, isProfileMode, likesByReel, me.id, profiles, query, reels, selectedTopic])
  const heroReel = visibleReels[0] ?? reels[0] ?? null
  const topicCounts = useMemo(
    () =>
      new Map(
        REEL_TOPICS.map((topic) => [
          topic.id,
          topic.id === 'all'
            ? reels.length
            : reels.filter((reel) => topic.match.test(`${reel.caption ?? ''} ${reel.video_url ?? ''}`)).length,
        ]),
      ),
    [reels],
  )

  const loadReels = useCallback(async () => {
    if (!supabase) return
    setErr(null)
    const { data, error } = await supabase
      .from('orion_reels')
      .select('*')
      .eq('moderation_status', 'published')
      .order('created_at', { ascending: false })
      .limit(40)

    if (error) {
      setErr(error.message)
      setReels([])
      return
    }

    const nextReels = ((data ?? []) as OrionReel[]) || []
    setReels(nextReels)

    const creatorIds = [...new Set(nextReels.map((reel) => reel.creator_id))]
    if (creatorIds.length) {
      const { data: profs } = await supabase.from('profiles').select('*').in('id', creatorIds)
      setProfiles(new Map(((profs ?? []) as Profile[]).map((profile) => [profile.id, profile])))
    } else {
      setProfiles(new Map())
    }
  }, [])

  const loadEngagement = useCallback(async () => {
    if (!supabase || reelIds.length === 0) {
      setLikes([])
      setComments([])
      return
    }
    const [{ data: likeRows }, { data: commentRows }] = await Promise.all([
      supabase.from('orion_reel_likes').select('*').in('reel_id', reelIds),
      supabase
        .from('orion_reel_comments')
        .select('*')
        .in('reel_id', reelIds)
        .order('created_at', { ascending: true })
        .limit(160),
    ])
    const nextLikes = ((likeRows ?? []) as OrionReelLike[]) || []
    const nextComments = ((commentRows ?? []) as OrionReelComment[]) || []
    setLikes(nextLikes)
    setComments(nextComments)

    const userIds = [...new Set([...nextLikes.map((like) => like.user_id), ...nextComments.map((comment) => comment.user_id)])]
    if (userIds.length) {
      const { data: profs } = await supabase.from('profiles').select('*').in('id', userIds)
      setProfiles((prev) => {
        const next = new Map(prev)
        for (const profile of ((profs ?? []) as Profile[]) || []) next.set(profile.id, profile)
        return next
      })
    }
  }, [reelIds])

  useEffect(() => {
    void loadReels()
  }, [loadReels])

  useEffect(() => {
    void loadEngagement()
  }, [loadEngagement])

  useEffect(() => {
    if (!supabase) return
    const client = supabase
    const channel = client
      .channel('orion-reels-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orion_reels' }, () => void loadReels())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orion_reel_likes' }, () => void loadEngagement())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orion_reel_comments' }, () => void loadEngagement())
      .subscribe()

    return () => {
      client.removeChannel(channel)
    }
  }, [loadEngagement, loadReels])

  async function handleFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file || !supabase) return
    const maxBytes = 500 * 1024 * 1024
    if (file.size > maxBytes) {
      alert('File is too large. Max 500 MB.')
      return
    }
    setUploading(true)
    setUploadPct(0)
    setUploadDone(false)
    setForm((next) => ({ ...next, videoUrl: '' }))
    const ext = file.name.includes('.') ? file.name.split('.').pop() : 'mp4'
    const path = `${me.id}/${Date.now()}.${ext}`
    const { data, error } = await supabase.storage.from('orion-reels').upload(path, file, {
      upsert: false,
      contentType: file.type,
    })
    setUploading(false)
    if (error) {
      alert(`Upload failed: ${error.message}\n\nRun npm run db:storage to create the bucket first.`)
      return
    }
    const { data: { publicUrl } } = supabase.storage.from('orion-reels').getPublicUrl(data.path)
    setForm((next) => ({ ...next, videoUrl: publicUrl }))
    setUploadDone(true)
  }

  async function submitReel(e: React.FormEvent) {
    e.preventDefault()
    if (!supabase) return
    const videoUrl = form.videoUrl.trim()
    if (uploadMode === 'file') {
      if (!uploadDone || !videoUrl) {
        alert('Upload a video file first — wait for the progress bar to finish.')
        return
      }
    } else if (!isProbablyVideoUrl(videoUrl)) {
      alert('Use a TikTok video page link or a direct hosted video URL ending in mp4, webm, mov, m4v, or m3u8.')
      return
    }
    setBusy('create-reel')
    const tag = topicTag(form.topic)
    const caption = form.caption.trim()
    const taggedCaption = tag && !caption.toLowerCase().includes(tag.toLowerCase()) ? `${caption} ${tag}`.trim() : caption
    const { error } = await supabase.from('orion_reels').insert({
      creator_id: me.id,
      video_url: videoUrl,
      hls_url: /\.m3u8(\?|#|$)/i.test(videoUrl) ? videoUrl : null,
      thumbnail_url: form.thumbnailUrl.trim() || null,
      caption: taggedCaption,
      visibility: form.visibility,
      moderation_status: 'published',
    })
    setBusy(null)
    if (error) return alert(error.message)
    setForm(emptyForm)
    setUploadDone(false)
    setUploadPct(0)
    if (fileInputRef.current) fileInputRef.current.value = ''
    await loadReels()
  }

  async function toggleLike(reelId: string) {
    if (!supabase) return
    const liked = likes.some((like) => like.reel_id === reelId && like.user_id === me.id)
    setBusy(`like:${reelId}`)
    const { error } = liked
      ? await supabase.from('orion_reel_likes').delete().eq('reel_id', reelId).eq('user_id', me.id)
      : await supabase.from('orion_reel_likes').insert({ reel_id: reelId, user_id: me.id })
    setBusy(null)
    if (error) return alert(error.message)
    await loadEngagement()
  }

  async function addComment(reelId: string) {
    if (!supabase) return
    const body = (commentDrafts[reelId] ?? '').trim()
    if (!body) return
    setBusy(`comment:${reelId}`)
    const { error } = await supabase.from('orion_reel_comments').insert({
      reel_id: reelId,
      user_id: me.id,
      body,
    })
    setBusy(null)
    if (error) return alert(error.message)
    setCommentDrafts((drafts) => ({ ...drafts, [reelId]: '' }))
    await loadEngagement()
  }

  async function deleteReel(reelId: string) {
    if (!supabase) return
    if (!window.confirm('Delete this reel?')) return
    setBusy(`delete:${reelId}`)
    const { error } = await supabase.from('orion_reels').delete().eq('id', reelId).eq('creator_id', me.id)
    setBusy(null)
    if (error) return alert(error.message)
    await loadReels()
  }

  async function openReelFullscreen(event: React.MouseEvent<HTMLButtonElement>) {
    const shell = event.currentTarget.closest('.reel-video-shell')
    if (shell instanceof HTMLElement && shell.requestFullscreen) {
      await shell.requestFullscreen().catch(() => {})
    }
  }

  return (
    <div className={`reels-page studio-page ${isProfileMode ? 'reels-page--profile' : 'reels-page--discover'}`}>
      <header className="page-head reels-head">
        <div>
          <div className="section-kicker font-mono">{isProfileMode ? 'MY ORION REELS' : 'ORION REELS DISCOVERY'}</div>
          <h2>{isProfileMode ? 'My Reels' : 'Reels'}</h2>
          <p className="page-intro">
            {isProfileMode
              ? 'Manage your posted clips while the main Reels page stays open for discovery.'
              : 'Browse the network by topic: battles, live rooms, music, gaming, comedy, love, and tech drops.'}
          </p>
        </div>
        <div className="reels-ready-card font-mono">
          <span>VIDEO UPLOAD LIVE</span>
          <strong>TikTok · mp4 · webm · mov · direct file</strong>
        </div>
      </header>

      {!isProfileMode && (
        <section className="reels-discovery-shell" aria-label="Reels discovery">
          <div className="reels-hero-card">
            <div>
              <div className="section-kicker font-mono">ORION VIDEO NETWORK</div>
              <h3>{REEL_FEED_MODES.find((mode) => mode.id === feedMode)?.label ?? 'Latest'}</h3>
              <p>
                {heroReel
                  ? heroReel.caption || `Fresh clip from @${creatorName(profiles, heroReel.creator_id)}`
                  : 'Post the first public clip and it will appear in category discovery.'}
              </p>
            </div>
            <div className="reels-hero-metrics font-mono">
              <span>{reels.length} public</span>
              <span>{likes.length} likes</span>
              <span>{comments.length} comments</span>
            </div>
          </div>

          <div className="reels-mode-strip" role="tablist" aria-label="Reels feed modes">
            {REEL_FEED_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                role="tab"
                aria-selected={feedMode === mode.id}
                className={feedMode === mode.id ? 'reels-mode-chip reels-mode-chip--active' : 'reels-mode-chip'}
                onClick={() => setFeedMode(mode.id)}
              >
                <span>{mode.label}</span>
                <small>{mode.hint}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="reels-topic-panel reels-topic-panel--dock" aria-label="Reel categories">
        <div className="reels-topic-head">
          <div>
            <div className="section-kicker font-mono">CATEGORIES</div>
            <strong>{isProfileMode ? 'Filter my reels' : 'Choose a lane'}</strong>
          </div>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search creators, captions, links..."
            aria-label="Search reels"
          />
        </div>
        <div className="reels-topic-strip" role="tablist" aria-label="Reel topics">
          {REEL_TOPICS.map((topic) => (
            <button
              key={topic.id}
              type="button"
              role="tab"
              aria-selected={selectedTopic === topic.id}
              className={selectedTopic === topic.id ? 'reels-topic-chip reels-topic-chip--active' : 'reels-topic-chip'}
              onClick={() => setSelectedTopic(topic.id)}
            >
              <span>{topic.label}</span>
              <small>{topicCounts.get(topic.id) ?? 0}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="card elevate reels-compose" aria-label="Create Orion Reel">
        <form onSubmit={submitReel}>
          <div>
            <div className="section-kicker font-mono">CREATE</div>
            <h3 className="section-title">Post a reel</h3>
          </div>
          <div className="reels-upload-toggle font-mono" role="group" aria-label="Video source mode">
            <button
              type="button"
              className={uploadMode === 'url' ? 'primary' : 'secondary'}
              onClick={() => { setUploadMode('url'); setUploadDone(false) }}
            >
              LINK
            </button>
            <button
              type="button"
              className={uploadMode === 'file' ? 'primary' : 'secondary'}
              onClick={() => { setUploadMode('file'); setForm((n) => ({ ...n, videoUrl: '' })); setUploadDone(false) }}
            >
              UPLOAD FILE
            </button>
          </div>

          {uploadMode === 'url' ? (
            <label>
              <span className="reels-label font-mono">Video URL</span>
              <input
                type="url"
                placeholder="TikTok link or https://.../clip.mp4"
                value={form.videoUrl}
                onChange={(event) => setForm((next) => ({ ...next, videoUrl: event.target.value }))}
                required
              />
            </label>
          ) : (
            <div className="reels-file-upload-area">
              <span className="reels-label font-mono">Upload video (mp4 · webm · mov · max 500 MB)</span>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/mp4,video/webm,video/quicktime,video/x-m4v,.mp4,.webm,.mov,.m4v"
                className="reels-file-input"
                onChange={(e) => void handleFileUpload(e)}
                disabled={uploading}
              />
              {uploading && (
                <div className="reels-upload-progress-wrap">
                  <div className="reels-upload-progress-bar reels-upload-progress-bar--pulse" />
                  <span className="font-mono">Uploading...</span>
                </div>
              )}
              {uploadDone && !uploading && (
                <div className="reels-upload-done font-mono">Uploaded — ready to post</div>
              )}
              {/* Hidden required input satisfied by videoUrl when file uploaded */}
              <input type="url" value={form.videoUrl} required onChange={() => {}} style={{ display: 'none' }} />
            </div>
          )}
          <label>
            <span className="reels-label font-mono">Thumbnail URL</span>
            <input
              type="url"
              placeholder="Optional poster image"
              value={form.thumbnailUrl}
              onChange={(event) => setForm((next) => ({ ...next, thumbnailUrl: event.target.value }))}
            />
          </label>
          <label>
            <span className="reels-label font-mono">Caption</span>
            <textarea
              rows={3}
              placeholder="Drop the moment..."
              value={form.caption}
              maxLength={600}
              onChange={(event) => setForm((next) => ({ ...next, caption: event.target.value }))}
            />
          </label>
          <div className="reels-compose-actions">
            <label>
              <span className="reels-label font-mono">Topic</span>
              <select
                value={form.topic}
                onChange={(event) => setForm((next) => ({ ...next, topic: event.target.value }))}
              >
                {REEL_TOPICS.filter((topic) => topic.id !== 'all').map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="reels-label font-mono">Visibility</span>
              <select
                value={form.visibility}
                onChange={(event) => setForm((next) => ({ ...next, visibility: event.target.value as OrionReel['visibility'] }))}
              >
                <option value="public">Public</option>
                <option value="friends">Friends</option>
                <option value="private">Private</option>
              </select>
            </label>
            <button className="primary" type="submit" disabled={busy === 'create-reel'}>
              {busy === 'create-reel' ? 'Posting...' : 'Post reel'}
            </button>
          </div>
        </form>
      </section>

      {err && (
        <div className="matrix-alert matrix-alert--warn font-mono" role="alert">
          <span className="matrix-alert-tag matrix-alert-tag--warn">SQL</span>
          Reels need the new migration. Run <code>npm run db:reels</code> or paste{' '}
          <code>supabase/migrations/20260514003000_orion_reels.sql</code> in Supabase SQL.
        </div>
      )}

      <section className="reels-feed" aria-label="Orion Reels feed">
        {visibleReels.length === 0 && !err && (
          <div className="card elevate reels-empty">
            <div className="section-kicker font-mono">{reels.length ? 'NO MATCHES' : 'NO REELS YET'}</div>
            <h3>{reels.length ? 'Try another topic' : 'First drop is open'}</h3>
            <p>{reels.length ? 'Switch categories or clear search to widen discovery.' : 'Paste a hosted video URL above and Orion Reels will start building the feed.'}</p>
          </div>
        )}

        {visibleReels.map((reel) => {
          const reelLikes = likesByReel.get(reel.id) ?? []
          const reelComments = commentsByReel.get(reel.id) ?? []
          const liked = reelLikes.some((like) => like.user_id === me.id)
          const playbackUrl = reel.hls_url || reel.video_url
          const isTikTok = isTikTokUrl(reel.video_url)
          const embedUrl = isTikTok && !preferTikTokLinkCard() ? tiktokEmbedUrl(reel.video_url) : null
          const canPlayNative = isDirectVideoUrl(playbackUrl)
          const reelTopic = topicForReel(reel)
          const creator = profiles.get(reel.creator_id)
          const creatorLabel = creatorName(profiles, reel.creator_id)
          const isOwner = reel.creator_id === me.id
          return (
            <article key={reel.id} className="reel-card reel-card--stacked">
              <div className="reel-video-shell">
                {embedUrl ? (
                  <iframe
                    className="reel-video reel-embed"
                    src={embedUrl}
                    title={reel.caption || 'TikTok reel'}
                    allow="encrypted-media; fullscreen; picture-in-picture"
                    scrolling="no"
                    allowFullScreen
                  />
                ) : isTikTok ? (
                  <div className="reel-video reel-tiktok-card">
                    {reel.thumbnail_url ? (
                      <img className="reel-tiktok-poster" src={reel.thumbnail_url} alt="" loading="lazy" />
                    ) : (
                      <div className="reel-tiktok-poster reel-tiktok-poster--empty" aria-hidden />
                    )}
                    <div className="reel-tiktok-card-body">
                      <span className="reel-tiktok-badge font-mono">TikTok clip</span>
                      <strong>Open in TikTok</strong>
                      <p>Embedded players block controls on mobile. Tap below to watch, or delete from the bar under the video.</p>
                      <a className="primary" href={reel.video_url} target="_blank" rel="noreferrer">
                        Watch on TikTok
                      </a>
                    </div>
                  </div>
                ) : canPlayNative ? (
                  <video
                    className="reel-video"
                    src={playbackUrl}
                    poster={reel.thumbnail_url ?? undefined}
                    controls
                    playsInline
                    preload="metadata"
                  />
                ) : (
                  <div className="reel-video reel-link-fallback">
                    <div className="section-kicker font-mono">EXTERNAL REEL</div>
                    <strong>Open source video</strong>
                    <p>This host does not expose a direct playable file. Open it in a new tab.</p>
                    <a className="primary" href={reel.video_url} target="_blank" rel="noreferrer">
                      Open link
                    </a>
                  </div>
                )}
                {!isTikTok && (
                  <button
                    className="reel-fullscreen-btn"
                    type="button"
                    onClick={(event) => void openReelFullscreen(event)}
                    aria-label="Open reel fullscreen"
                    title="Fullscreen"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden>
                      <path d="M8 4H4v4M4 4l6 6M16 4h4v4M20 4l-6 6M8 20H4v-4M4 20l6-6M16 20h4v-4M20 20l-6-6" />
                    </svg>
                  </button>
                )}
              </div>

              <div className="reel-card-bar">
                <div className="reel-card-head">
                  <ProfileAvatar src={creator?.avatar_url} name={creatorLabel} size="sm" className="reel-creator-avatar" />
                  <div className="reel-card-copy">
                    <div className="reel-topic-pill font-mono">{reelTopic.label}</div>
                    <div className="reel-creator">@{creatorLabel}</div>
                    <p className="reel-caption">{reel.caption || 'Orion Reel'}</p>
                  </div>
                </div>
                <div className="reel-actions reel-actions--bar">
                  <button
                    className={liked ? 'primary' : 'secondary'}
                    type="button"
                    disabled={busy === `like:${reel.id}`}
                    onClick={() => void toggleLike(reel.id)}
                  >
                    {liked ? 'Liked' : 'Like'} · {reelLikes.length}
                  </button>
                  {isTikTok && (
                    <a className="secondary reel-open-link" href={reel.video_url} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  )}
                  {isOwner && (
                    <button
                      className="secondary reel-delete-btn"
                      type="button"
                      disabled={busy === `delete:${reel.id}`}
                      onClick={() => void deleteReel(reel.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              <details className="reel-comment-panel">
                <summary className="reel-comment-head font-mono">{reelComments.length} comments</summary>
                <div className="reel-comments">
                  {reelComments.slice(-3).map((comment) => (
                    <div key={comment.id} className="reel-comment">
                      <strong>{creatorName(profiles, comment.user_id)}</strong>
                      <span>{comment.body}</span>
                    </div>
                  ))}
                  {reelComments.length === 0 && <div className="empty-hint">No comments yet.</div>}
                </div>
                <div className="reel-comment-compose">
                  <input
                    type="text"
                    value={commentDrafts[reel.id] ?? ''}
                    onChange={(event) => setCommentDrafts((drafts) => ({ ...drafts, [reel.id]: event.target.value }))}
                    placeholder="Add comment..."
                    maxLength={500}
                  />
                  <button
                    className="secondary"
                    type="button"
                    disabled={busy === `comment:${reel.id}` || !(commentDrafts[reel.id] ?? '').trim()}
                    onClick={() => void addComment(reel.id)}
                  >
                    Send
                  </button>
                </div>
              </details>
            </article>
          )
        })}
      </section>
    </div>
  )
}
