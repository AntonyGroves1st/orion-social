import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { supabase } from './supabase'

export type RoomLayoutSync = {
  /** Sender user id — only host/mod layout events are applied. */
  from?: string
  royale?: boolean
  battleEnabled?: boolean
  /** Number of visible stage camera tiles (2–8). */
  camCount?: number
  /** Stage slots as user ids (null = empty). Host-controlled. */
  stageSlots?: (string | null)[]
  /** User ids the host has forced-muted (applies to everyone). */
  mutedUserIds?: string[]
}

export type StageRequestSync = {
  from: string
  action: 'request' | 'cancel'
}

export type RoomLikeSync = {
  from: string
  delta: number
}

export type HostMuteSync = {
  from: string
  targetUserId: string
  muted: boolean
  /** Full muted set from host — clients replace local set when present. */
  mutedUserIds?: string[]
}

type RoomLayoutSyncHandle = {
  broadcast: (payload: RoomLayoutSync) => void
  broadcastStageRequest: (payload: StageRequestSync) => void
  broadcastLike: (payload: RoomLikeSync) => void
  broadcastHostMute: (payload: HostMuteSync) => void
  detach: () => void
}

async function removeChannelByTopic(client: SupabaseClient, topic: string) {
  const full = topic.startsWith('realtime:') ? topic : `realtime:${topic}`
  const existing = client.getChannels().find((c) => c.topic === full)
  if (existing) await client.removeChannel(existing)
}

/** Realtime broadcast so all peers in a live room share layout + stage requests. */
export function attachRoomLayoutSync(
  conversationId: string,
  onSync: (payload: RoomLayoutSync) => void,
  onStageRequest?: (payload: StageRequestSync) => void,
  onLike?: (payload: RoomLikeSync) => void,
  onHostMute?: (payload: HostMuteSync) => void,
): RoomLayoutSyncHandle {
  if (!supabase) {
    return {
      broadcast: () => {},
      broadcastStageRequest: () => {},
      broadcastLike: () => {},
      broadcastHostMute: () => {},
      detach: () => {},
    }
  }

  const client = supabase
  const topic = `room-layout:${conversationId}`
  const pending: RoomLayoutSync[] = []
  let subscribed = false
  let detached = false
  let channel: RealtimeChannel | null = null

  const flushPending = () => {
    if (!subscribed || detached || !channel) return
    while (pending.length) {
      const payload = pending.shift()!
      void channel.send({ type: 'broadcast', event: 'layout', payload })
    }
  }

  void (async () => {
    await removeChannelByTopic(client, topic)
    if (detached) return

    channel = client.channel(topic).on('broadcast', { event: 'layout' }, ({ payload }) => {
      if (payload && typeof payload === 'object') onSync(payload as RoomLayoutSync)
    })

    if (onStageRequest) {
      channel.on('broadcast', { event: 'stage-request' }, ({ payload }) => {
        if (payload && typeof payload === 'object' && typeof (payload as StageRequestSync).from === 'string') {
          onStageRequest(payload as StageRequestSync)
        }
      })
    }

    if (onLike) {
      channel.on('broadcast', { event: 'room-like' }, ({ payload }) => {
        const p = payload as RoomLikeSync
        if (p && typeof p.from === 'string' && typeof p.delta === 'number' && p.delta > 0) {
          onLike(p)
        }
      })
    }

    if (onHostMute) {
      channel.on('broadcast', { event: 'host-mute' }, ({ payload }) => {
        const p = payload as HostMuteSync
        if (p && typeof p.from === 'string' && typeof p.targetUserId === 'string' && typeof p.muted === 'boolean') {
          onHostMute(p)
        }
      })
    }

    const state = channel.state
    if (state === 'joined') {
      subscribed = true
      flushPending()
      return
    }

    if (state === 'joining') return

    channel.subscribe((status) => {
      subscribed = status === 'SUBSCRIBED'
      if (subscribed) flushPending()
    })
  })()

  return {
    broadcast: (payload) => {
      if (detached) return
      if (subscribed && channel) {
        void channel.send({ type: 'broadcast', event: 'layout', payload })
      } else {
        pending.push(payload)
      }
    },
    broadcastStageRequest: (payload) => {
      if (detached || !channel) return
      void channel.send({ type: 'broadcast', event: 'stage-request', payload })
    },
    broadcastLike: (payload) => {
      if (detached || !channel) return
      void channel.send({ type: 'broadcast', event: 'room-like', payload })
    },
    broadcastHostMute: (payload) => {
      if (detached || !channel) return
      void channel.send({ type: 'broadcast', event: 'host-mute', payload })
    },
    detach: () => {
      detached = true
      pending.length = 0
      subscribed = false
      const ch = channel
      channel = null
      if (ch) void client.removeChannel(ch)
      void removeChannelByTopic(client, topic)
    },
  }
}
