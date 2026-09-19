import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ORION_E2_PREFIX,
  getOrCreateSealIdentity,
  isBrowserOrionToken,
  openOrionInBrowser,
  sealOrionInBrowser,
  unwrapOrionSecret,
  wrapOrionSecretForPeer,
  type OrionE2Body,
} from '../crypto/sealWrap'
import type { ChatEmoji, MessageEmojiReaction, Msg, Profile } from '../lib/supabase'
import { supabase } from '../lib/supabase'
import { DEFAULT_CHAT_EMOJIS, reactionSummary, sortedEmojiCatalog } from '../lib/chatEmojis'
import { applyReplyToBody, clearReplyFromBody, type ChatReplyTarget } from '../lib/chatReply'
import ProfileAvatar from '../components/ProfileAvatar'

type ObserverSettings = {
  lat: number
  lon: number
  elevation_m: number
}

const OBSERVER_STORAGE_KEY = 'orion_observer_v1'
const DEFAULT_OBSERVER: ObserverSettings = {
  lat: 51.4769,
  lon: -0.0005,
  elevation_m: 10,
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function readObserverSettings(): ObserverSettings {
  if (typeof window === 'undefined') return DEFAULT_OBSERVER
  try {
    const raw = localStorage.getItem(OBSERVER_STORAGE_KEY)
    if (!raw) return DEFAULT_OBSERVER
    const j = JSON.parse(raw) as Partial<ObserverSettings>
    return {
      lat: clampNumber(j.lat, DEFAULT_OBSERVER.lat, -90, 90),
      lon: clampNumber(j.lon, DEFAULT_OBSERVER.lon, -180, 180),
      elevation_m: clampNumber(j.elevation_m, DEFAULT_OBSERVER.elevation_m, -500, 9000),
    }
  } catch {
    return DEFAULT_OBSERVER
  }
}

export default function Chat({ me }: { me: Profile }) {
  const nav = useNavigate()
  const { conversationId: routeConv } = useParams()
  const [qs] = useSearchParams()
  const peerId = qs.get('peer')
  const [conversationId, setConversationId] = useState('')
  const [body, setBody] = useState('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [sealBusy, setSealBusy] = useState(false)
  const [peerPub, setPeerPub] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  /** Other participant (from ?peer= or inferred from membership). */
  const [peerRow, setPeerRow] = useState<{ id: string; display_name: string; avatar_url?: string | null } | null>(null)
  const [senderAvatars, setSenderAvatars] = useState<Record<string, string>>(() =>
    me.avatar_url?.trim() ? { [me.id]: me.avatar_url.trim() } : {},
  )
  const [msgsLoadErr, setMsgsLoadErr] = useState<string | null>(null)
  const [observer, setObserver] = useState<ObserverSettings>(() => readObserverSettings())
  const [emojiCatalog, setEmojiCatalog] = useState<ChatEmoji[]>(DEFAULT_CHAT_EMOJIS)
  const [emojiReactions, setEmojiReactions] = useState<MessageEmojiReaction[]>([])
  const [emojiDbErr, setEmojiDbErr] = useState<string | null>(null)
  const [senderNames, setSenderNames] = useState<Record<string, string>>({})
  const [replyTo, setReplyTo] = useState<ChatReplyTarget | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBody, setEditBody] = useState('')
  const [editErr, setEditErr] = useState<string | null>(null)
  const composeRef = useRef<HTMLTextAreaElement>(null)
  const messageIds = useMemo(() => msgs.map((msg) => msg.id), [msgs])

  useEffect(() => {
    try {
      localStorage.setItem(OBSERVER_STORAGE_KEY, JSON.stringify(observer))
    } catch {
      /* ignore */
    }
  }, [observer])

  useEffect(() => {
    if (!supabase) return
    ;(async () => {
      const { data, error } = await supabase
        .from('chat_emojis')
        .select('*')
        .eq('active', true)
        .order('sort_order')
      if (error) {
        setEmojiDbErr(error.message)
        setEmojiCatalog(DEFAULT_CHAT_EMOJIS)
        return
      }
      setEmojiDbErr(null)
      setEmojiCatalog(sortedEmojiCatalog(((data ?? []) as ChatEmoji[]) || DEFAULT_CHAT_EMOJIS))
    })()
  }, [])

  const loadEmojiReactions = useCallback(async () => {
    if (!supabase || messageIds.length === 0) {
      setEmojiReactions([])
      return
    }
    const { data, error } = await supabase
      .from('message_emoji_reactions')
      .select('*')
      .in('message_id', messageIds)
    if (error) {
      setEmojiDbErr(error.message)
      setEmojiReactions([])
      return
    }
    setEmojiDbErr(null)
    setEmojiReactions(((data ?? []) as MessageEmojiReaction[]) || [])
  }, [messageIds])

  useEffect(() => {
    void loadEmojiReactions()
  }, [loadEmojiReactions])

  useEffect(() => {
    if (!supabase || !conversationId) return
    const client = supabase
    const ch = client
      .channel(`emoji-reactions:${conversationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_emoji_reactions' }, () => {
        void loadEmojiReactions()
      })
      .subscribe()

    return () => {
      client.removeChannel(ch)
    }
  }, [conversationId, loadEmojiReactions])

  useEffect(() => {
    if (!supabase) return
    ;(async () => {
      let cid = routeConv ?? ''
      if (!cid && peerId) {
        const { data: d, error } = await supabase.rpc('ensure_dm', { peer_id: peerId })
        if (!error && d) cid = d as string
      }
      setConversationId(cid)
    })()
  }, [routeConv, peerId])

  useEffect(() => {
    if (!supabase) return
    if (peerId) {
      ;(async () => {
        const { data, error } = await supabase.from('profiles').select('display_name,avatar_url').eq('id', peerId).maybeSingle()
        if (error || !data) {
          setPeerRow({ id: peerId, display_name: peerId.slice(0, 8) })
          return
        }
        const row = data as { display_name?: string; avatar_url?: string | null }
        const dn = typeof row.display_name === 'string' ? row.display_name : ''
        setPeerRow({
          id: peerId,
          display_name: dn.trim() || peerId.slice(0, 8),
          avatar_url: row.avatar_url ?? null,
        })
        if (row.avatar_url?.trim()) {
          setSenderAvatars((a) => ({ ...a, [peerId]: row.avatar_url!.trim() }))
        }
      })()
      return
    }

    if (!conversationId) {
      setPeerRow(null)
      return
    }

    ;(async () => {
      const { data: memb, error } = await supabase
        .from('conversation_members')
        .select('user_id')
        .eq('conversation_id', conversationId)
      if (error) {
        console.warn('[chat]', error)
        setPeerRow(null)
        return
      }
      const other = (memb ?? []).find((r) => r.user_id !== me.id)
      if (!other) {
        setPeerRow(null)
        return
      }
      const { data: prof } = await supabase
        .from('profiles')
        .select('display_name,avatar_url')
        .eq('id', other.user_id)
        .maybeSingle()
      const row = prof as { display_name?: string; avatar_url?: string | null } | null
      const dn = typeof row?.display_name === 'string' ? (row.display_name || '').trim() : ''
      setPeerRow({
        id: other.user_id,
        display_name: dn || other.user_id.slice(0, 8),
        avatar_url: row?.avatar_url ?? null,
      })
      if (row?.avatar_url?.trim()) {
        setSenderAvatars((a) => ({ ...a, [other.user_id]: row.avatar_url!.trim() }))
      }
    })()
  }, [conversationId, peerId, me.id])

  const sealTargetId = peerId ?? peerRow?.id ?? null

  useEffect(() => {
    if (!supabase || !sealTargetId) {
      setPeerPub(null)
      return
    }
    ;(async () => {
      const { data } = await supabase.from('profiles').select('seal_pubkey_jwk').eq('id', sealTargetId).maybeSingle()
      setPeerPub((data as { seal_pubkey_jwk?: string | null } | null)?.seal_pubkey_jwk ?? null)
    })()
  }, [sealTargetId])

  useEffect(() => {
    if (!supabase || !conversationId) {
      setMsgs([])
      return
    }
    const client = supabase
    const cid = conversationId
    ;(async () => {
      setMsgsLoadErr(null)
      const { data, error } = await client.from('messages').select('*').eq('conversation_id', cid).order('created_at')
      if (error) {
        setMsgsLoadErr(error.message)
        setMsgs([])
        return
      }
      setMsgs((data ?? []) as Msg[])
      const ids = [...new Set(((data ?? []) as Msg[]).map((m) => m.sender_id))]
      if (ids.length) {
        const { data: profs } = await client.from('profiles').select('id,display_name,avatar_url').in('id', ids)
        const map: Record<string, string> = {}
        const av: Record<string, string> = { [me.id]: me.avatar_url?.trim() || '' }
        for (const row of profs ?? []) {
          const p = row as Profile
          map[p.id] = p.display_name
          av[p.id] = p.avatar_url?.trim() || ''
        }
        setSenderNames(map)
        setSenderAvatars((prev) => ({ ...prev, ...av }))
      }
    })()

    const ch = client
      .channel(`msgs:${cid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${cid}` },
        (p) => setMsgs((m) => [...m, p.new as Msg]),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${cid}` },
        (p) => {
          const updated = p.new as Msg
          setMsgs((m) => m.map((row) => (row.id === updated.id ? { ...row, ...updated } : row)))
        },
      )
      .subscribe()

    return () => {
      client.removeChannel(ch)
    }
  }, [conversationId])

  async function send(plainBody: string) {
    if (!supabase || !conversationId.trim()) return
    const payload = plainBody.trim()
    if (!payload) return

    await supabase.from('messages').insert({
      conversation_id: conversationId,
      sender_id: me.id,
      body: payload,
      is_orion_sealed: false,
    })

    setBody('')
    setReplyTo(null)
  }

  async function saveDmEdit() {
    if (!supabase || !editingId) return
    const next = editBody.trim()
    if (!next) {
      setEditErr('Message cannot be empty.')
      return
    }
    setEditErr(null)
    const stamp = new Date().toISOString()
    const { data, error } = await supabase
      .from('messages')
      .update({ body: next, edited_at: stamp })
      .eq('id', editingId)
      .eq('sender_id', me.id)
      .select('*')
      .maybeSingle()
    if (error) {
      const fallback = await supabase
        .from('messages')
        .update({ body: next })
        .eq('id', editingId)
        .eq('sender_id', me.id)
        .select('*')
        .maybeSingle()
      if (fallback.error) {
        setEditErr(
          fallback.error.message.includes('policy') || fallback.error.code === '42501'
            ? 'Edit blocked — run supabase/FIX_MESSAGE_EDIT.sql'
            : fallback.error.message,
        )
        return
      }
      if (fallback.data) setMsgs((m) => m.map((row) => (row.id === editingId ? { ...(fallback.data as Msg), edited_at: stamp } : row)))
      else setMsgs((m) => m.map((row) => (row.id === editingId ? { ...row, body: next, edited_at: stamp } : row)))
    } else if (data) {
      setMsgs((m) => m.map((row) => (row.id === editingId ? (data as Msg) : row)))
    } else {
      setMsgs((m) => m.map((row) => (row.id === editingId ? { ...row, body: next, edited_at: stamp } : row)))
    }
    setEditingId(null)
    setEditBody('')
  }

  function senderName(senderId: string) {
    if (senderId === me.id) return 'You'
    if (peerRow?.id === senderId) return peerRow.display_name
    return senderNames[senderId]?.trim() || senderId.slice(0, 8)
  }

  function startReply(target: ChatReplyTarget) {
    if (target.id === me.id) return
    setReplyTo(target)
    setBody((prev) => applyReplyToBody(target.name, prev))
    window.setTimeout(() => composeRef.current?.focus(), 0)
  }

  function cancelReply() {
    setReplyTo(null)
    setBody((prev) => clearReplyFromBody(prev))
  }

  function appendEmoji(unicode: string) {
    setBody((value) => `${value}${value && !value.endsWith(' ') ? ' ' : ''}${unicode} `)
  }

  async function toggleEmojiReaction(messageId: string, emojiKey: string) {
    if (!supabase) return
    const { error } = await supabase.rpc('toggle_message_emoji_reaction', {
      p_message_id: messageId,
      p_emoji_key: emojiKey,
    })
    if (error) {
      setEmojiDbErr(error.message)
      return
    }
    setEmojiDbErr(null)
    await loadEmojiReactions()
  }

  async function sealWithOrionKey() {
    if (!conversationId.trim() || !body.trim()) return
    if (!sealTargetId) {
      alert('Ephemeral Orion seals with hidden keys work in **direct chats** where a peer pubkey is known. Open chat from Lobby on a member row.')
      return
    }
    if (!peerPub) {
      alert('Your peer has not published a sealing key yet — ask them to open the Lobby once (keys are generated offline-first in the browser).')
      return
    }

    setSealBusy(true)
    try {
      const ts = new Date().toISOString()
      const sealed = await sealOrionInBrowser({
        plaintext: body,
        timestampUtcIso: ts,
        lat: observer.lat,
        lon: observer.lon,
        elevationM: observer.elevation_m,
      })
      const wrap = await wrapOrionSecretForPeer(peerPub, sealed.secret)
      if (!supabase) return

      const env: OrionE2Body = { token: sealed.token, wrap }
      const stored = `${ORION_E2_PREFIX}${JSON.stringify(env)}`

      await supabase.from('messages').insert({
        conversation_id: conversationId,
        sender_id: me.id,
        body: stored,
        is_orion_sealed: true,
      })
      setBody('')
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setSealBusy(false)
    }
  }

  async function openSealed(body: string, msgId: string) {
    if (!body.startsWith(ORION_E2_PREFIX)) {
      alert('Legacy [ORION] tokens need the old manual secret flow.')
      return
    }
    try {
      const json = JSON.parse(body.slice(ORION_E2_PREFIX.length)) as OrionE2Body
      if (!json.wrap) throw new Error('Missing wrap envelope.')
      const id = await getOrCreateSealIdentity()
      const secret = await unwrapOrionSecret(id.privateKey, json.wrap)
      if (isBrowserOrionToken(json.token)) {
        const plaintext = await openOrionInBrowser(json.token, secret)
        setRevealed((v) => ({ ...v, [msgId]: plaintext }))
        return
      }
      const r = await fetch('/orion/v1/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: json.token, secret }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(typeof d.detail === 'string' ? d.detail : JSON.stringify(d))
      setRevealed((v) => ({ ...v, [msgId]: d.plaintext as string }))
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="chat-page studio-page">
      <header className="studio-page-head">
        <div>
          <button className="studio-back-link" type="button" onClick={() => nav('/home')}>
            ← Lobby
          </button>
          <div className="section-kicker font-mono">MESSAGES</div>
          <h2>{peerRow?.display_name ?? 'Direct message'}</h2>
          <p className="page-intro">
            Conversation {conversationId ? conversationId.slice(0, 8) : '…'}
            {peerRow ? ` · ${peerRow.display_name}` : conversationId ? ' · resolving participant…' : ''}
          </p>
        </div>
        <div className="studio-page-actions">
          <Link className="secondary" to="/home">
            Lobby
          </Link>
          {conversationId && (
            <Link className="primary" to={`/call/${conversationId}${peerId ? `?peer=${peerId}` : ''}`}>
              Video call
            </Link>
          )}
        </div>
      </header>
      {msgsLoadErr && (
        <p style={{ fontSize: 13, color: '#fb7185' }} role="alert">
          Messages could not load (RLS or network): {msgsLoadErr} — apply{' '}
          <code style={{ fontSize: 11 }}>supabase/DELTA_RUN_IN_SQL_EDITOR.sql</code> then refresh.
        </p>
      )}
      {emojiDbErr && (
        <p style={{ fontSize: 13, color: '#fbbf24' }} role="status">
          Emoji database not active yet — run <code style={{ fontSize: 11 }}>npm run db:chat-emojis</code>. Local emoji
          insertion still works.
        </p>
      )}
      {!conversationId && <p>Open from Lobby (Message).</p>}
      {sealTargetId && !peerPub && (
        <p style={{ fontSize: 12, color: '#fbbf24' }}>
          Peer sealing key not visible yet — they should open the app once so their public key syncs.
        </p>
      )}
      <div className="chat-body">
        {msgs.map((m) => (
          <div key={m.id} className="msg">
            <div className="meta">
              {m.sender_id === me.id ? (
                <span className="chat-msg-sender">
                  <ProfileAvatar src={me.avatar_url} name={me.display_name || 'You'} size="xs" />
                  <span>You</span>
                </span>
              ) : (
                <button
                  type="button"
                  className="chat-msg-sender chat-msg-sender--link"
                  onClick={() => startReply({ id: m.sender_id, name: senderName(m.sender_id) })}
                  title={`Reply to ${senderName(m.sender_id)}`}
                >
                  <ProfileAvatar
                    src={senderAvatars[m.sender_id] || (peerRow?.id === m.sender_id ? peerRow.avatar_url : '')}
                    name={senderName(m.sender_id)}
                    size="xs"
                  />
                  <span>{senderName(m.sender_id)}</span>
                </button>
              )}
              {' · '}
              {new Date(m.created_at).toLocaleString()}
              {m.is_orion_sealed ? ' · sealed' : ''}
            </div>
            {revealed[m.id] ? (
              <div style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap', color: 'var(--accent)' }}>{revealed[m.id]}</div>
            ) : editingId === m.id ? (
              <div className="tiktok-live-msg-edit" style={{ marginTop: 6 }}>
                <input
                  className="tiktok-live-chat-input tiktok-live-msg-edit-input font-mono"
                  value={editBody}
                  maxLength={2000}
                  onChange={(e) => setEditBody(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setEditingId(null)
                      setEditBody('')
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void saveDmEdit()
                    }
                  }}
                />
                <button type="button" className="primary tiktok-live-msg-edit-save" onClick={() => void saveDmEdit()}>
                  Save
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setEditingId(null)
                    setEditBody('')
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <>
                {!m.body.startsWith(ORION_E2_PREFIX) ? (
                  <div style={{ wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
                    {m.body}
                    {m.edited_at ? <em className="tiktok-live-msg-edited"> · edited</em> : null}
                  </div>
                ) : (
                  <div style={{ wordBreak: 'break-word', fontSize: 13, color: 'var(--muted)' }}>
                    🔒 Orion-sealed ciphertext (plaintext never touches Supabase).
                    {m.body.startsWith(ORION_E2_PREFIX) && (
                      <button type="button" className="secondary" style={{ marginLeft: 8 }} onClick={() => void openSealed(m.body, m.id)}>
                        Unlock
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
            {m.sender_id === me.id && !m.is_orion_sealed && !m.body.startsWith(ORION_E2_PREFIX) && editingId !== m.id && (
              <button
                type="button"
                className="secondary tiktok-live-msg-edit-btn"
                style={{ marginTop: 4 }}
                onClick={() => {
                  setEditingId(m.id)
                  setEditBody(m.body)
                  setEditErr(null)
                }}
              >
                Edit
              </button>
            )}
            {editErr && editingId === m.id && (
              <div className="tiktok-live-chat-error font-mono" style={{ marginTop: 4 }}>
                {editErr}
              </div>
            )}
            <div className="message-emoji-actions">
              <div className="message-reaction-summary">
                {reactionSummary(m.id, emojiReactions, emojiCatalog, me.id).map((item) => (
                  <button
                    key={item.emoji.key}
                    type="button"
                    className={item.mine ? 'emoji-reaction emoji-reaction--mine' : 'emoji-reaction'}
                    title={item.emoji.label}
                    onClick={() => void toggleEmojiReaction(m.id, item.emoji.key)}
                  >
                    <span>{item.emoji.unicode}</span>
                    <strong>{item.count}</strong>
                  </button>
                ))}
              </div>
              <details className="emoji-react-menu">
                <summary className="secondary">React</summary>
                <div className="emoji-grid">
                  {emojiCatalog.slice(0, 24).map((emoji) => (
                    <button
                      key={emoji.key}
                      type="button"
                      title={emoji.label}
                      onClick={() => void toggleEmojiReaction(m.id, emoji.key)}
                    >
                      {emoji.unicode}
                    </button>
                  ))}
                </div>
              </details>
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
        {replyTo && (
          <div className="chat-reply-banner font-mono">
            <span>
              Replying to <strong>{replyTo.name}</strong>
            </span>
            <button type="button" className="chat-reply-cancel secondary" onClick={cancelReply} aria-label="Cancel reply">
              ✕
            </button>
          </div>
        )}
        <textarea
          ref={composeRef}
          rows={3}
          placeholder={replyTo ? `Reply to ${replyTo.name}…` : 'Plain message, or Orion-seal (random secret encrypted to peer — admins never receive it).'}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && replyTo) {
              e.preventDefault()
              cancelReply()
            }
          }}
          maxLength={4000}
          style={{
            width: '100%',
            borderRadius: 10,
            padding: 10,
            border: '1px solid var(--line)',
            background: '#020617',
            color: 'inherit',
          }}
        />
        <div className="chat-emoji-palette" aria-label="Emoji picker">
          {emojiCatalog.slice(0, 18).map((emoji) => (
            <button key={emoji.key} type="button" title={emoji.label} onClick={() => appendEmoji(emoji.unicode)}>
              {emoji.unicode}
            </button>
          ))}
        </div>
        <div className="row">
          <label className="observer-field font-mono">
            <span>Lat</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.0001"
              min="-90"
              max="90"
              value={observer.lat}
              onChange={(e) =>
                setObserver((o) => ({ ...o, lat: clampNumber(e.target.value, DEFAULT_OBSERVER.lat, -90, 90) }))
              }
            />
          </label>
          <label className="observer-field font-mono">
            <span>Lon</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.0001"
              min="-180"
              max="180"
              value={observer.lon}
              onChange={(e) =>
                setObserver((o) => ({ ...o, lon: clampNumber(e.target.value, DEFAULT_OBSERVER.lon, -180, 180) }))
              }
            />
          </label>
          <label className="observer-field font-mono">
            <span>Elev</span>
            <input
              type="number"
              inputMode="decimal"
              step="1"
              min="-500"
              max="9000"
              value={observer.elevation_m}
              onChange={(e) =>
                setObserver((o) => ({
                  ...o,
                  elevation_m: clampNumber(e.target.value, DEFAULT_OBSERVER.elevation_m, -500, 9000),
                }))
              }
            />
          </label>
        </div>
        <div className="row">
          <button className="primary" type="button" onClick={() => send(body)} disabled={!conversationId}>
            Send plain
          </button>
          <button
            className="secondary"
            type="button"
            disabled={!conversationId || sealBusy || !sealTargetId || !peerPub}
            onClick={() => void sealWithOrionKey()}
            title={!peerPub ? 'Peer needs to sync sealing pubkey' : 'Browser-only Orion seal: ciphertext + wrapped secret only'}
          >
            {sealBusy ? 'Sealing…' : 'Seal with Orion Key'}
          </button>
          <Link
            className="secondary"
            to={`/call/${conversationId}?peer=${peerId ?? peerRow?.id ?? ''}`}
            style={{ textDecoration: 'none', alignSelf: 'center' }}
          >
            Open live grid →
          </Link>
        </div>
      </div>
    </div>
  )
}
