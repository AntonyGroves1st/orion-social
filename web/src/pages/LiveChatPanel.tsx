import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ChatEmoji, Msg, Profile } from '../lib/supabase'
import { supabase } from '../lib/supabase'
import { DEFAULT_CHAT_EMOJIS, sortedEmojiCatalog } from '../lib/chatEmojis'
import { applyReplyToBody, clearReplyFromBody, type ChatReplyTarget } from '../lib/chatReply'
import ProfileAvatar from '../components/ProfileAvatar'

type Props = {
  conversationId: string
  me: Profile
  roomTitle: string
  extraMessages?: LiveChatExtraMessage[]
  onUserSent?: (body: string) => void
  /** When set, Lobby exits through live leave (DB membership drop) instead of a raw route change. */
  onLeaveToLobby?: () => void
  mode?: 'panel' | 'floating' | 'compact'
  showRailHeader?: boolean
}

export type LiveChatExtraMessage = {
  id: string
  senderName: string
  body: string
  createdAt: string
}

/**
 * TikTok-live-style sidebar: realtime stream + composer (same `messages` table as DM chat).
 */
export default function LiveChatPanel({
  conversationId,
  me,
  roomTitle,
  extraMessages = [],
  onUserSent,
  onLeaveToLobby,
  mode = 'panel',
  showRailHeader = false,
}: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [body, setBody] = useState('')
  const [names, setNames] = useState<Record<string, string>>({})
  const [avatars, setAvatars] = useState<Record<string, string>>(() =>
    me.avatar_url?.trim() ? { [me.id]: me.avatar_url.trim() } : {},
  )
  const [emojiCatalog, setEmojiCatalog] = useState<ChatEmoji[]>(DEFAULT_CHAT_EMOJIS)
  const [sending, setSending] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<ChatReplyTarget | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBody, setEditBody] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const isCompact = mode === 'compact'
  const isFloating = mode === 'floating' || isCompact

  const scrollBottom = useCallback(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    scrollBottom()
  }, [extraMessages, msgs, scrollBottom])

  useEffect(() => {
    if (!supabase) return
    ;(async () => {
      const { data } = await supabase
        .from('chat_emojis')
        .select('*')
        .eq('active', true)
        .order('sort_order')
      if (data?.length) setEmojiCatalog(sortedEmojiCatalog(data as ChatEmoji[]))
    })()
  }, [])

  useEffect(() => {
    if (!supabase || !conversationId) {
      setMsgs([])
      return
    }
    const client = supabase
    const cid = conversationId
    void (async () => {
      const { data } = await client.from('messages').select('*').eq('conversation_id', cid).order('created_at')
      setMsgs([...(new Map(((data ?? []) as Msg[]).map((msg) => [msg.id, msg])).values())])
      const ids = [...new Set((data ?? []).map((m) => (m as Msg).sender_id))]
      ids.push(me.id)
      if (!ids.length) return
      const { data: profs } = await client.from('profiles').select('id,display_name,avatar_url').in('id', ids as string[])
      const map: Record<string, string> = {}
      const av: Record<string, string> = { [me.id]: me.avatar_url?.trim() || '' }
      for (const row of profs ?? []) {
        const p = row as Profile
        map[p.id] = p.display_name
        av[p.id] = p.avatar_url?.trim() || ''
      }
      setNames(map)
      setAvatars((prev) => ({ ...prev, ...av }))
    })()

    const ch = client
      .channel(`live-chat:${cid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${cid}` },
        async (ev) => {
          const msg = ev.new as Msg
          setMsgs((prev) => (prev.some((current) => current.id === msg.id) ? prev : [...prev, msg]))
          if (!names[msg.sender_id] || avatars[msg.sender_id] === undefined) {
            const { data: p } = await client
              .from('profiles')
              .select('display_name,avatar_url')
              .eq('id', msg.sender_id)
              .maybeSingle()
            if (p) {
              const row = p as { display_name: string; avatar_url?: string | null }
              setNames((n) => ({ ...n, [msg.sender_id]: row.display_name }))
              setAvatars((a) => ({ ...a, [msg.sender_id]: row.avatar_url?.trim() || '' }))
            }
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${cid}` },
        (ev) => {
          const msg = ev.new as Msg
          setMsgs((prev) => prev.map((current) => (current.id === msg.id ? { ...current, ...msg } : current)))
        },
      )
      .subscribe()

    return () => {
      client.removeChannel(ch)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- names hydrated incrementally
  }, [conversationId, me.id])

  const subtitle = useMemo(() => roomTitle?.trim() || conversationId.slice(0, 8), [conversationId, roomTitle])
  const streamMessages = useMemo(
    () =>
      [
        ...extraMessages.map((m) => ({ kind: 'system' as const, id: m.id, senderName: m.senderName, body: m.body, createdAt: m.createdAt, editedAt: null as string | null })),
        ...msgs.map((m) => ({
          kind: 'member' as const,
          id: m.id,
          senderId: m.sender_id,
          body: m.body,
          sealed: m.is_orion_sealed,
          createdAt: m.created_at,
          editedAt: m.edited_at ?? null,
        })),
      ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [extraMessages, msgs],
  )
  const visibleMessages = useMemo(
    () => (mode === 'floating' ? streamMessages.slice(-6) : streamMessages),
    [mode, streamMessages],
  )

  async function send() {
    if (!supabase || !conversationId || sending) return
    const t = body.trim()
    if (!t) return
    setSending(true)
    setChatError(null)
    try {
      const { data, error } = await supabase
        .from('messages')
        .insert({
          conversation_id: conversationId,
          sender_id: me.id,
          body: t,
          is_orion_sealed: false,
        })
        .select('*')
        .single()

      if (error) {
        setChatError(error.message)
        return
      }
      if (data) {
        const inserted = data as Msg
        setMsgs((prev) => (prev.some((current) => current.id === inserted.id) ? prev : [...prev, inserted]))
      }
      onUserSent?.(t)
      setBody('')
      setReplyTo(null)
    } catch (error) {
      setChatError(error instanceof Error ? error.message : 'Message could not be sent.')
    } finally {
      setSending(false)
    }
  }

  function labelFor(senderId: string) {
    if (senderId === me.id) return 'You'
    return names[senderId] ?? senderId.slice(0, 6)
  }

  function startReply(target: ChatReplyTarget) {
    if (target.id === me.id) return
    setEditingId(null)
    setReplyTo(target)
    setBody((prev) => applyReplyToBody(target.name, prev))
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  function cancelReply() {
    setReplyTo(null)
    setBody((prev) => clearReplyFromBody(prev))
  }

  function startEdit(msg: Msg) {
    if (msg.sender_id !== me.id || msg.is_orion_sealed) return
    setReplyTo(null)
    setEditingId(msg.id)
    setEditBody(msg.body)
    window.setTimeout(() => editInputRef.current?.focus(), 0)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditBody('')
  }

  async function saveEdit() {
    if (!supabase || !editingId || savingEdit) return
    const next = editBody.trim()
    if (!next) {
      setChatError('Message cannot be empty.')
      return
    }
    const id = editingId
    const prev = msgs.find((m) => m.id === id)
    const stamp = new Date().toISOString()
    setSavingEdit(true)
    setChatError(null)
    /* Show new text immediately; revert if DB rejects (RLS often returns 0 rows, no error). */
    setMsgs((cur) => cur.map((m) => (m.id === id ? { ...m, body: next, edited_at: stamp } : m)))
    cancelEdit()
    try {
      const client = supabase
      let saved: Msg | null = null
      let { data, error } = await client
        .from('messages')
        .update({ body: next, edited_at: stamp })
        .eq('id', id)
        .eq('sender_id', me.id)
        .select('id, body, edited_at, sender_id, conversation_id, created_at, is_orion_sealed')
        .maybeSingle()
      if (error) {
        const fallback = await client
          .from('messages')
          .update({ body: next })
          .eq('id', id)
          .eq('sender_id', me.id)
          .select('id, body, edited_at, sender_id, conversation_id, created_at, is_orion_sealed')
          .maybeSingle()
        error = fallback.error
        data = fallback.data
      }
      if (!error && data) saved = data as Msg
      if (error || !saved) {
        if (prev) {
          setMsgs((cur) => cur.map((m) => (m.id === id ? prev : m)))
        }
        setChatError(
          error?.message?.includes('policy') || error?.code === '42501' || !saved
            ? 'Edit blocked by database — run supabase/FIX_MESSAGE_EDIT.sql in Supabase SQL Editor.'
            : error?.message || 'Edit did not save.',
        )
        return
      }
      setMsgs((cur) =>
        cur.map((m) =>
          m.id === saved!.id
            ? { ...m, ...saved!, body: saved!.body ?? next, edited_at: saved!.edited_at ?? stamp }
            : m,
        ),
      )
    } catch (error) {
      if (prev) setMsgs((cur) => cur.map((m) => (m.id === id ? prev : m)))
      setChatError(error instanceof Error ? error.message : 'Could not edit message.')
    } finally {
      setSavingEdit(false)
    }
  }

  function renderSenderLabel(m: (typeof visibleMessages)[number]) {
    if (m.kind === 'system') {
      return (
        <button
          type="button"
          className="tiktok-live-msg-who tiktok-live-msg-who--link"
          onClick={() => startReply({ id: `system:${m.id}`, name: m.senderName })}
          title={`Reply to ${m.senderName}`}
        >
          <ProfileAvatar name={m.senderName} size="xs" />
          <span className="tiktok-live-msg-who-text">{m.senderName}</span>
        </button>
      )
    }
    const name = labelFor(m.senderId)
    const avatar = m.senderId === me.id ? me.avatar_url : avatars[m.senderId]
    if (m.senderId === me.id) {
      return (
        <span className="tiktok-live-msg-who">
          <ProfileAvatar src={avatar} name={name} size="xs" />
          <span className="tiktok-live-msg-who-text">{name}</span>
        </span>
      )
    }
    return (
      <button
        type="button"
        className="tiktok-live-msg-who tiktok-live-msg-who--link"
        onClick={() => startReply({ id: m.senderId, name: names[m.senderId] ?? name })}
        title={`Reply to ${name}`}
      >
        <ProfileAvatar src={avatar} name={name} size="xs" />
        <span className="tiktok-live-msg-who-text">{name}</span>
      </button>
    )
  }

  function appendEmoji(unicode: string) {
    if (editingId) {
      setEditBody((value) => `${value}${value && !value.endsWith(' ') ? ' ' : ''}${unicode} `)
      return
    }
    setBody((value) => `${value}${value && !value.endsWith(' ') ? ' ' : ''}${unicode} `)
  }

  return (
    <aside
      className={`tiktok-live-chat${isFloating ? ' tiktok-live-chat--floating' : ''}${isCompact ? ' tiktok-live-chat--compact' : ''}`}
      aria-label="Live chat"
    >
      {(!isFloating || showRailHeader) && !isCompact && (
        <div className="tiktok-live-chat-head">
          <div>
            <div className="tiktok-live-chat-title">{showRailHeader ? roomTitle || 'Live chat' : 'Live chat'}</div>
            <div className="tiktok-live-chat-meta font-mono">{showRailHeader ? 'Room chat · realtime' : subtitle}</div>
          </div>
          {!showRailHeader && (
            onLeaveToLobby ? (
              <button type="button" className="secondary tiktok-live-lobby-link" onClick={onLeaveToLobby}>
                Lobby
              </button>
            ) : (
              <Link to="/home" replace className="secondary tiktok-live-lobby-link">
                Lobby
              </Link>
            )
          )}
        </div>
      )}
      {isCompact && (
        <div className="tiktok-live-chat-head tiktok-live-chat-head--compact">
          <div className="tiktok-live-chat-title">{roomTitle?.trim() || 'Chat'}</div>
        </div>
      )}
      <div
        ref={listRef}
        className={`tiktok-live-chat-stream font-mono${isFloating ? ' tiktok-live-chat-stream--floating' : ''}${isCompact ? ' tiktok-live-chat-stream--compact' : ''}`}
      >
        {msgs.length === 0 && extraMessages.length === 0 && (
          <div className="tiktok-live-chat-empty">No messages yet · say hello</div>
        )}
        {visibleMessages.map((m) => (
          <div
            key={m.id}
            className={`tiktok-live-msg${isFloating ? ' tiktok-live-msg--float' : ''}${isCompact ? ' tiktok-live-msg--compact' : ''} ${
              m.kind === 'system' ? 'tiktok-live-msg--agent' : m.senderId === me.id ? 'tiktok-live-msg--me' : ''
            }`}
          >
            <span className="tiktok-live-msg-who-wrap">{renderSenderLabel(m)}</span>
            {m.kind === 'member' && editingId === m.id ? (
              <span className="tiktok-live-msg-edit">
                <input
                  ref={editInputRef}
                  type="text"
                  className="tiktok-live-chat-input tiktok-live-msg-edit-input font-mono"
                  value={editBody}
                  maxLength={2000}
                  onChange={(e) => setEditBody(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      cancelEdit()
                    }
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void saveEdit()
                    }
                  }}
                />
                <button type="button" className="primary tiktok-live-msg-edit-save" disabled={savingEdit || !editBody.trim()} onClick={() => void saveEdit()}>
                  {savingEdit ? '…' : 'Save'}
                </button>
                <button type="button" className="secondary" onClick={cancelEdit}>
                  Cancel
                </button>
              </span>
            ) : (
              <span
                className="tiktok-live-msg-body"
                onDoubleClick={() => {
                  if (m.kind !== 'member' || m.senderId !== me.id || m.sealed) return
                  const row = msgs.find((row) => row.id === m.id)
                  if (row) startEdit(row)
                }}
                title={m.kind === 'member' && m.senderId === me.id && !m.sealed ? 'Double-click to edit' : undefined}
              >
                {m.kind === 'member' && m.sealed ? '🔒 sealed (open in DM)' : m.body}
                {m.kind === 'member' && m.editedAt ? <em className="tiktok-live-msg-edited"> · edited</em> : null}
              </span>
            )}
            {m.kind === 'member' && m.senderId === me.id && !m.sealed && editingId !== m.id && (
              <button
                type="button"
                className="tiktok-live-msg-edit-btn secondary"
                aria-label="Edit your message"
                title="Edit message"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const row = msgs.find((row) => row.id === m.id)
                  if (row) startEdit(row)
                }}
              >
                EDIT
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="tiktok-live-chat-compose">
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
        <div className="tiktok-live-chat-compose-row">
        <details className="live-emoji-menu">
          <summary className="secondary" aria-label="Emoji picker">
            🙂
          </summary>
          <div className="emoji-grid">
            {emojiCatalog.slice(0, isCompact ? 8 : isFloating ? 12 : 24).map((emoji) => (
              <button key={emoji.key} type="button" title={emoji.label} onClick={() => appendEmoji(emoji.unicode)}>
                {emoji.unicode}
              </button>
            ))}
          </div>
        </details>
        <input
          ref={inputRef}
          type="text"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={replyTo ? `Reply to ${replyTo.name}…` : 'Say something...'}
          maxLength={2000}
          disabled={Boolean(editingId)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && replyTo) {
              e.preventDefault()
              cancelReply()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          className="tiktok-live-chat-input font-mono"
        />
        <button className="primary tiktok-live-chat-send" type="button" onClick={() => void send()} disabled={sending || !body.trim() || Boolean(editingId)}>
          {sending ? '...' : 'Send'}
        </button>
        </div>
      </div>
      {chatError && (
        <div className="tiktok-live-chat-error font-mono" role="alert">
          Chat: {chatError}
        </div>
      )}
    </aside>
  )
}
