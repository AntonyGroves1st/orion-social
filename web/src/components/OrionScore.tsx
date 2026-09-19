import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

type Props = { profileId: string }

type Tier = 'RECRUIT' | 'SATELLITE' | 'PIONEER' | 'ORBITAL' | 'MATRIX'

function getTier(score: number): Tier {
  if (score >= 1500) return 'MATRIX'
  if (score >= 700) return 'ORBITAL'
  if (score >= 300) return 'PIONEER'
  if (score >= 100) return 'SATELLITE'
  return 'RECRUIT'
}

const TIER_COLOUR: Record<Tier, string> = {
  RECRUIT: 'rgba(148,163,184,0.8)',
  SATELLITE: 'var(--matrix-mid)',
  PIONEER: 'var(--matrix-bright)',
  ORBITAL: '#22d3ee',
  MATRIX: '#fbbf24',
}

export default function OrionScore({ profileId }: Props) {
  const [wins, setWins] = useState(0)
  const [reels, setReels] = useState(0)
  const [friends, setFriends] = useState(0)
  const [likes, setLikes] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase) return
    setLoading(true)
    void (async () => {
      const [
        { count: winCount },
        { count: reelCount },
        { count: friendCount },
        likesRes,
      ] = await Promise.all([
        supabase
          .from('battle_league_wins')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', profileId),
        supabase
          .from('orion_reels')
          .select('id', { count: 'exact', head: true })
          .eq('creator_id', profileId),
        supabase
          .from('friend_connections')
          .select('id', { count: 'exact', head: true })
          .or(`requester_id.eq.${profileId},addressee_id.eq.${profileId}`)
          .eq('status', 'accepted'),
        supabase.from('live_like_events').select('delta').eq('to_user_id', profileId).limit(5000),
      ])
      const likeTotal = ((likesRes.data ?? []) as Array<{ delta: number }>).reduce(
        (sum, row) => sum + (row.delta || 0),
        0,
      )
      setWins(winCount ?? 0)
      setReels(reelCount ?? 0)
      setFriends(friendCount ?? 0)
      setLikes(likesRes.error ? 0 : likeTotal)
      setLoading(false)
    })()
  }, [profileId])

  const likePoints = Math.floor(likes / 1000)
  const score = wins * 100 + reels * 20 + friends * 10 + likePoints
  const tier = getTier(score)
  const colour = TIER_COLOUR[tier]

  return (
    <div className="profile-stat profile-stat--orion-score profile-stat--wide">
      <span className="font-mono">Orion Score</span>
      {loading ? (
        <strong>—</strong>
      ) : (
        <>
          <strong style={{ color: colour, textShadow: `0 0 12px ${colour}` }}>
            {score.toLocaleString()}
          </strong>
          <span
            className="orion-tier-badge font-mono"
            style={{ color: colour, borderColor: colour }}
          >
            {tier}
          </span>
          <p className="profile-score-breakdown font-mono">
            {wins} win{wins !== 1 ? 's' : ''} · {reels} reel{reels !== 1 ? 's' : ''} · {friends} friend
            {friends !== 1 ? 's' : ''} · {likes.toLocaleString()} like{likes !== 1 ? 's' : ''}
          </p>
        </>
      )}
    </div>
  )
}
