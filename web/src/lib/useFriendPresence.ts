import { useEffect } from 'react'
import { supabase } from './supabase'

/** Lobby / profile heartbeat so friends see you as ONLINE when not in a live. */
export function useFriendPresenceHeartbeat(enabled: boolean) {
  useEffect(() => {
    if (!enabled || !supabase) return
    const client = supabase
    const beat = () => {
      void client.rpc('touch_friend_presence').then(
        () => undefined,
        () => undefined,
      )
    }
    beat()
    const id = window.setInterval(beat, 45_000)
    const onVis = () => {
      if (document.visibilityState === 'visible') beat()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [enabled])
}
