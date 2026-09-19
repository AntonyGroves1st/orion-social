import React, { useEffect, useState } from 'react'
import type { OrionRivalry } from '../lib/supabase'
import { supabase } from '../lib/supabase'

type Props = {
  profileId: string
  displayName: string
}

type RivalryWithName = OrionRivalry & { opponentName: string }

type SearchResult = { id: string; display_name: string }

export default function RivalryPanel({ profileId, displayName }: Props) {
  const [rivalries, setRivalries] = useState<RivalryWithName[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [declaring, setDeclaring] = useState(false)
  const [declareError, setDeclareError] = useState<string | null>(null)

  async function loadRivalries() {
    if (!supabase) return
    setLoading(true)
    setError(null)

    const { data: rows, error: fetchErr } = await supabase
      .from('orion_rivalries')
      .select('*')
      .or(`challenger_id.eq.${profileId},opponent_id.eq.${profileId}`)
      .order('declared_at', { ascending: false })

    if (fetchErr) {
      setError(fetchErr.message)
      setLoading(false)
      return
    }

    const typedRows = (rows ?? []) as OrionRivalry[]

    if (typedRows.length === 0) {
      setRivalries([])
      setLoading(false)
      return
    }

    const opponentIds = typedRows.map((r) =>
      r.challenger_id === profileId ? r.opponent_id : r.challenger_id
    )
    const uniqueIds = [...new Set(opponentIds)]

    const { data: profileRows } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', uniqueIds)

    const nameMap = new Map<string, string>(
      (profileRows ?? []).map((p: SearchResult) => [p.id, p.display_name])
    )

    const merged: RivalryWithName[] = typedRows.map((r) => {
      const opponentId = r.challenger_id === profileId ? r.opponent_id : r.challenger_id
      return { ...r, opponentName: nameMap.get(opponentId) ?? 'Unknown' }
    })

    setRivalries(merged)
    setLoading(false)
  }

  useEffect(() => {
    void loadRivalries()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId])

  async function handleSearch(query: string) {
    setSearchQuery(query)
    setDeclareError(null)
    if (!supabase || query.trim().length < 2) {
      setSearchResults([])
      return
    }
    setSearching(true)
    const { data } = await supabase
      .from('profiles')
      .select('id, display_name')
      .ilike('display_name', `%${query.trim()}%`)
      .neq('id', profileId)
      .limit(8)
    setSearchResults((data ?? []) as SearchResult[])
    setSearching(false)
  }

  async function declareRivalry(opponent: SearchResult) {
    if (!supabase) return
    setDeclaring(true)
    setDeclareError(null)
    const { error: insertErr } = await supabase.from('orion_rivalries').insert({
      challenger_id: profileId,
      opponent_id: opponent.id,
    })
    setDeclaring(false)
    if (insertErr) {
      setDeclareError(
        insertErr.message.includes('rivalry_pair_unique')
          ? 'Rivalry with this member already exists.'
          : insertErr.message
      )
      return
    }
    setSearchQuery('')
    setSearchResults([])
    await loadRivalries()
  }

  async function recordOutcome(rivalry: RivalryWithName, iWon: boolean) {
    if (!supabase) return
    const amChallenger = rivalry.challenger_id === profileId
    const patch = {
      total_battles: rivalry.total_battles + 1,
      last_battle_at: new Date().toISOString(),
      challenger_wins: amChallenger
        ? rivalry.challenger_wins + (iWon ? 1 : 0)
        : rivalry.challenger_wins + (iWon ? 0 : 1),
      opponent_wins: amChallenger
        ? rivalry.opponent_wins + (iWon ? 0 : 1)
        : rivalry.opponent_wins + (iWon ? 1 : 0),
    }
    await supabase.from('orion_rivalries').update(patch).eq('id', rivalry.id)
    await loadRivalries()
  }

  function myWins(r: OrionRivalry): number {
    return r.challenger_id === profileId ? r.challenger_wins : r.opponent_wins
  }

  function theirWins(r: OrionRivalry): number {
    return r.challenger_id === profileId ? r.opponent_wins : r.challenger_wins
  }

  function leaderStatus(r: OrionRivalry): 'YOU LEAD' | 'THEY LEAD' | 'TIED' {
    const mine = myWins(r)
    const theirs = theirWins(r)
    if (mine > theirs) return 'YOU LEAD'
    if (theirs > mine) return 'THEY LEAD'
    return 'TIED'
  }

  function leaderColor(r: OrionRivalry): 'green' | 'red' | 'grey' {
    const status = leaderStatus(r)
    if (status === 'YOU LEAD') return 'green'
    if (status === 'THEY LEAD') return 'red'
    return 'grey'
  }

  return (
    <section id="rivalries" className="profile-section card elevate rivalry-panel">
      <div>
        <div className="section-kicker font-mono">RIVALRY ARCS</div>
        <h3 className="section-title">Head-to-head records</h3>
        <p className="page-intro">
          Track your ongoing rivalries — declare challengers, log battle outcomes, and see who leads.
        </p>
      </div>

      {/* Declare new rivalry */}
      <div className="rivalry-declare">
        <span className="reels-label font-mono">Challenge a member</span>
        <div className="rivalry-search-row">
          <input
            type="text"
            placeholder="Search by display name..."
            value={searchQuery}
            maxLength={120}
            onChange={(e) => void handleSearch(e.target.value)}
          />
          {searching && <span className="font-mono rivalry-searching">searching...</span>}
        </div>
        {searchResults.length > 0 && (
          <ul className="rivalry-search-results">
            {searchResults.map((r) => (
              <li key={r.id}>
                <span>{r.display_name}</span>
                <button
                  className="primary"
                  disabled={declaring}
                  onClick={() => void declareRivalry(r)}
                >
                  {declaring ? '...' : 'Challenge'}
                </button>
              </li>
            ))}
          </ul>
        )}
        {declareError && (
          <div className="matrix-alert matrix-alert--warn font-mono" role="alert">
            <span className="matrix-alert-tag matrix-alert-tag--warn">ERR</span>
            {declareError}
          </div>
        )}
      </div>

      {/* Rivalries list */}
      {loading ? (
        <p className="empty-hint font-mono">Loading rivalries...</p>
      ) : error ? (
        <div className="matrix-alert matrix-alert--warn font-mono" role="alert">
          <span className="matrix-alert-tag matrix-alert-tag--warn">SQL</span>
          {error.includes('orion_rivalries') || error.includes('relation')
            ? <>Run <code>npm run db:rivalry</code> to apply the migration.</>
            : error}
        </div>
      ) : rivalries.length === 0 ? (
        <p className="empty-hint font-mono">No rivalries declared yet. Challenge someone above.</p>
      ) : (
        <div className="rivalry-list">
          {rivalries.map((r) => {
            const mine = myWins(r)
            const theirs = theirWins(r)
            const color = leaderColor(r)
            const status = leaderStatus(r)
            return (
              <div key={r.id} className={`rivalry-card rivalry-card--${color}`}>
                <div className="rivalry-card-header">
                  <strong className="font-mono">{displayName}</strong>
                  <span className="font-mono rivalry-vs">VS</span>
                  <strong className="font-mono">{r.opponentName}</strong>
                  <span className={`rivalry-leader rivalry-leader--${color} font-mono`}>
                    {status}
                  </span>
                </div>
                <div className="rivalry-record font-mono">
                  {mine}W &middot; {theirs}L &middot; {r.total_battles} battles
                </div>
                <div className="rivalry-actions">
                  <button
                    className="primary"
                    title="Record a win for me"
                    onClick={() => void recordOutcome(r, true)}
                  >
                    +W (I won)
                  </button>
                  <button
                    className="secondary"
                    title="Record a loss for me"
                    onClick={() => void recordOutcome(r, false)}
                  >
                    +L (I lost)
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
