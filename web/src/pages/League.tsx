import React, { useEffect, useMemo, useState } from 'react'
import type { BattleLeagueWin, LiveLikeEvent } from '../lib/supabase'
import { supabase } from '../lib/supabase'

/* ── types ──────────────────────────────────────────────────────────────── */
type LeaderRow = {
  userId: string
  displayName: string
  wins: number
  losses: number
  points: number
  streak: number
  bestStreak: number
  lastWinAt: string
}

type RivalryKey = string  /* "userA:userB" sorted alphabetically */
type RivalryRow = {
  playerA: string
  playerB: string
  winsA: number
  winsB: number
  totalBattles: number
  lastFought: string
}

type LikeLeaderRow = {
  userId: string
  displayName: string
  likes: number
  sessions: number
  lp: number
  lastLikeAt: string
}

type SessionLikeRow = {
  conversationId: string
  roomTitle: string
  likes: number
  hostName: string
  lastLikeAt: string
}

type TabId = 'leaderboard' | 'likes' | 'rivals' | 'recent'

function fmtDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/* ── component ───────────────────────────────────────────────────────────── */
export default function League() {
  const [wins, setWins] = useState<BattleLeagueWin[]>([])
  const [likeEvents, setLikeEvents] = useState<LiveLikeEvent[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabId>('leaderboard')
  const [search, setSearch] = useState('')

  async function load() {
    if (!supabase) {
      setError('Supabase not configured')
      setBusy(false)
      return
    }
    setBusy(true)
    setError(null)
    const [winsRes, likesRes] = await Promise.all([
      supabase
        .from('battle_league_wins')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(2000),
      supabase
        .from('live_like_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5000),
    ])

    if (winsRes.error && !String(winsRes.error.message).includes('live_like')) {
      setError(winsRes.error.message)
    }
    if (likesRes.error) {
      const msg = likesRes.error.message
      if (msg.includes('does not exist') || msg.includes('relation') || likesRes.error.code === '42P01') {
        setError((prev) => prev ?? 'Like league missing — run supabase/FIX_LIVE_LIKES.sql (or npm run db:live-likes).')
      } else if (!winsRes.error) {
        setError(msg)
      }
      setLikeEvents([])
    } else {
      setLikeEvents((likesRes.data ?? []) as LiveLikeEvent[])
    }

    if (!winsRes.error) {
      setWins((winsRes.data ?? []) as BattleLeagueWin[])
    } else if (!likesRes.error) {
      setWins([])
    }
    setBusy(false)
  }

  useEffect(() => { void load() }, [])

  /* ── derived leaderboard ─────────────────────────────────────────────── */
  const leaderboard = useMemo<LeaderRow[]>(() => {
    const map = new Map<string, LeaderRow>()
    // process oldest → newest for streak tracking
    const sorted = [...wins].sort((a, b) => a.created_at.localeCompare(b.created_at))
    for (const win of sorted) {
      const existing = map.get(win.user_id)
      if (!existing) {
        map.set(win.user_id, {
          userId: win.user_id,
          displayName: win.display_name_snapshot,
          wins: 1,
          losses: 0,
          points: win.points,
          streak: 1,
          bestStreak: 1,
          lastWinAt: win.created_at,
        })
      } else {
        existing.wins += 1
        existing.points += win.points
        existing.streak += 1
        if (existing.streak > existing.bestStreak) existing.bestStreak = existing.streak
        existing.lastWinAt = win.created_at
        existing.displayName = win.display_name_snapshot
      }
    }
    return Array.from(map.values()).sort((a, b) => b.wins - a.wins || b.points - a.points)
  }, [wins])

  /* ── likes ranking (per user across sessions) ────────────────────────── */
  const likeLeaders = useMemo<LikeLeaderRow[]>(() => {
    const map = new Map<string, LikeLeaderRow & { sessionSet: Set<string> }>()
    for (const ev of likeEvents) {
      const existing = map.get(ev.to_user_id)
      if (!existing) {
        map.set(ev.to_user_id, {
          userId: ev.to_user_id,
          displayName: ev.to_display_name || ev.to_user_id.slice(0, 8),
          likes: ev.delta,
          sessions: 1,
          lp: 0,
          lastLikeAt: ev.created_at,
          sessionSet: new Set([ev.conversation_id]),
        })
        continue
      }
      existing.likes += ev.delta
      existing.sessionSet.add(ev.conversation_id)
      existing.sessions = existing.sessionSet.size
      if (ev.created_at > existing.lastLikeAt) {
        existing.lastLikeAt = ev.created_at
        existing.displayName = ev.to_display_name || existing.displayName
      }
    }
    return Array.from(map.values())
      .map(({ sessionSet: _s, ...row }) => ({
        ...row,
        lp: Math.floor(row.likes / 100_000),
      }))
      .sort((a, b) => b.likes - a.likes || b.sessions - a.sessions)
  }, [likeEvents])

  /* ── per live session totals ─────────────────────────────────────────── */
  const sessionLeaders = useMemo<SessionLikeRow[]>(() => {
    const map = new Map<string, SessionLikeRow>()
    for (const ev of likeEvents) {
      const existing = map.get(ev.conversation_id)
      if (!existing) {
        map.set(ev.conversation_id, {
          conversationId: ev.conversation_id,
          roomTitle: ev.room_title_snapshot || 'Live',
          likes: ev.delta,
          hostName: ev.to_display_name || 'Host',
          lastLikeAt: ev.created_at,
        })
        continue
      }
      existing.likes += ev.delta
      if (ev.created_at > existing.lastLikeAt) {
        existing.lastLikeAt = ev.created_at
        existing.roomTitle = ev.room_title_snapshot || existing.roomTitle
        existing.hostName = ev.to_display_name || existing.hostName
      }
    }
    return Array.from(map.values()).sort((a, b) => b.likes - a.likes)
  }, [likeEvents])

  /* ── derived rivalries ───────────────────────────────────────────────── */
  const rivalries = useMemo<RivalryRow[]>(() => {
    const map = new Map<RivalryKey, RivalryRow>()
    // pair winner vs loser per battle — we approximate from consecutive wins in same conversation
    const byConv = new Map<string, BattleLeagueWin[]>()
    for (const w of wins) {
      const cid = w.conversation_id ?? 'local'
      const list = byConv.get(cid) ?? []
      list.push(w)
      byConv.set(cid, list)
    }
    for (const battles of byConv.values()) {
      for (let i = 0; i < battles.length - 1; i++) {
        const a = battles[i]
        const b = battles[i + 1]
        if (a.user_id === b.user_id) continue
        const key = [a.user_id, b.user_id].sort().join(':')
        const nameA = a.user_id < b.user_id ? a.display_name_snapshot : b.display_name_snapshot
        const nameB = a.user_id < b.user_id ? b.display_name_snapshot : a.display_name_snapshot
        const existing = map.get(key)
        if (!existing) {
          map.set(key, {
            playerA: nameA,
            playerB: nameB,
            winsA: 1,
            winsB: 0,
            totalBattles: 1,
            lastFought: a.created_at,
          })
        } else {
          existing.totalBattles += 1
          if (a.user_id < b.user_id) existing.winsA += 1
          else existing.winsB += 1
          if (a.created_at > existing.lastFought) existing.lastFought = a.created_at
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => b.totalBattles - a.totalBattles)
  }, [wins])

  /* ── filtered leaderboard ────────────────────────────────────────────── */
  const filteredLeader = useMemo(
    () =>
      search.trim()
        ? leaderboard.filter((r) => r.displayName.toLowerCase().includes(search.toLowerCase()))
        : leaderboard,
    [leaderboard, search]
  )

  const filteredLikeLeaders = useMemo(
    () =>
      search.trim()
        ? likeLeaders.filter((r) => r.displayName.toLowerCase().includes(search.toLowerCase()))
        : likeLeaders,
    [likeLeaders, search],
  )

  const recentWins = wins.slice(0, 50)
  const recentLikes = likeEvents.slice(0, 100)
  const totalLoggedLikes = likeEvents.reduce((sum, e) => sum + e.delta, 0)

  return (
    <div className="league-page studio-page">
      <header className="league-header">
        <div className="league-header-inner">
          <div>
            <div className="league-eyebrow font-mono">ORION BATTLE</div>
            <h1 className="league-title">League &amp; Rivals</h1>
          </div>
          <button className="secondary league-refresh" type="button" onClick={() => void load()} disabled={busy}>
            {busy ? '…' : 'Refresh'}
          </button>
        </div>

        {/* season summary strip */}
        <div className="league-stats font-mono">
          <div className="league-stat">
            <span className="league-stat-val">{wins.length}</span>
            <span className="league-stat-label">Total Battles</span>
          </div>
          <div className="league-stat">
            <span className="league-stat-val">{leaderboard.length}</span>
            <span className="league-stat-label">Fighters</span>
          </div>
          <div className="league-stat">
            <span className="league-stat-val">{totalLoggedLikes.toLocaleString()}</span>
            <span className="league-stat-label">Likes Logged</span>
          </div>
          <div className="league-stat">
            <span className="league-stat-val">{likeLeaders[0]?.likes.toLocaleString() ?? 0}</span>
            <span className="league-stat-label">Top Likes</span>
          </div>
        </div>

        {/* tabs */}
        <div className="league-tabs" role="tablist">
          {(['leaderboard', 'likes', 'rivals', 'recent'] as TabId[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`league-tab font-mono ${tab === t ? 'league-tab--active' : ''}`}
              type="button"
              onClick={() => setTab(t)}
            >
              {t === 'leaderboard' && '🏆 Leaderboard'}
              {t === 'likes' && '♥ Likes Top 100'}
              {t === 'rivals' && '⚔ Rivalry Arcs'}
              {t === 'recent' && '🕑 Recent'}
            </button>
          ))}
        </div>
      </header>

      <div className="league-body">
        {error && (
          <div className="league-error font-mono">
            {error.includes('does not exist') || error.includes('relation') || error.includes('Like league')
              ? error.includes('Like')
                ? error
                : 'League table not set up yet. Run: npm run db:battle-league'
              : error}
          </div>
        )}

        {busy && !error && (
          <div className="league-loading font-mono">Loading…</div>
        )}

        {/* ── LEADERBOARD ────────────────────────────────────────────── */}
        {!busy && tab === 'leaderboard' && (
          <>
            <div className="league-search-wrap">
              <input
                className="league-search font-mono"
                type="search"
                placeholder="Search fighter…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {filteredLeader.length === 0 && (
              <div className="league-empty font-mono">
                {search ? 'No match found.' : 'No battles recorded yet. Fire some gifts!'}
              </div>
            )}

            <div className="league-table" role="table" aria-label="Leaderboard">
              <div className="league-thead font-mono" role="row">
                <span>#</span>
                <span>Fighter</span>
                <span>W</span>
                <span>Pts</span>
                <span>Streak</span>
                <span>Last Win</span>
              </div>
              {filteredLeader.slice(0, 100).map((row, i) => (
                <div
                  key={row.userId}
                  className={`league-row font-mono ${i === 0 ? 'league-row--gold' : i === 1 ? 'league-row--silver' : i === 2 ? 'league-row--bronze' : ''}`}
                  role="row"
                >
                  <span className="league-rank">
                    {i === 0 ? '👑' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}
                  </span>
                  <span className="league-name">{row.displayName}</span>
                  <span className="league-wins">{row.wins}</span>
                  <span className="league-pts">{row.points.toFixed(0)}</span>
                  <span className="league-streak">
                    {row.bestStreak > 2 ? `🔥${row.bestStreak}` : row.bestStreak}
                  </span>
                  <span className="league-date">{fmtDate(row.lastWinAt)}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── LIKES TOP 100 ──────────────────────────────────────────── */}
        {!busy && tab === 'likes' && (
          <>
            <div className="league-search-wrap">
              <input
                className="league-search font-mono"
                type="search"
                placeholder="Search host…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {filteredLikeLeaders.length === 0 && (
              <div className="league-empty font-mono">
                {search ? 'No match found.' : 'No likes logged yet. Tap the live stage to send likes.'}
              </div>
            )}

            <div className="league-table league-table--likes" role="table" aria-label="Likes Top 100">
              <div className="league-thead font-mono" role="row">
                <span>#</span>
                <span>Host</span>
                <span>Likes</span>
                <span>LP</span>
                <span>Sessions</span>
                <span>Last</span>
              </div>
              {filteredLikeLeaders.slice(0, 100).map((row, i) => (
                <div
                  key={row.userId}
                  className={`league-row font-mono ${i === 0 ? 'league-row--gold' : i === 1 ? 'league-row--silver' : i === 2 ? 'league-row--bronze' : ''}`}
                  role="row"
                >
                  <span className="league-rank">
                    {i === 0 ? '👑' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}
                  </span>
                  <span className="league-name">{row.displayName}</span>
                  <span className="league-wins">{row.likes.toLocaleString()}</span>
                  <span className="league-pts">{row.lp}</span>
                  <span className="league-streak">{row.sessions}</span>
                  <span className="league-date">{fmtDate(row.lastLikeAt)}</span>
                </div>
              ))}
            </div>

            <h2 className="league-subhead font-mono">Top sessions</h2>
            {sessionLeaders.length === 0 ? (
              <div className="league-empty font-mono">No session likes yet.</div>
            ) : (
              <div className="league-table league-table--sessions" role="table" aria-label="Top liked sessions">
                <div className="league-thead font-mono" role="row">
                  <span>#</span>
                  <span>Room</span>
                  <span>Host</span>
                  <span>Likes</span>
                  <span>Last</span>
                </div>
                {sessionLeaders.slice(0, 100).map((row, i) => (
                  <div key={row.conversationId} className="league-row font-mono" role="row">
                    <span className="league-rank">#{i + 1}</span>
                    <span className="league-name">{row.roomTitle}</span>
                    <span className="league-wins">{row.hostName}</span>
                    <span className="league-pts">{row.likes.toLocaleString()}</span>
                    <span className="league-date">{fmtDate(row.lastLikeAt)}</span>
                  </div>
                ))}
              </div>
            )}

            <h2 className="league-subhead font-mono">Like log</h2>
            <div className="league-recent" aria-label="All recent like batches">
              {recentLikes.length === 0 && (
                <div className="league-empty font-mono">Log is empty.</div>
              )}
              {recentLikes.map((ev) => (
                <div key={ev.id} className="league-recent-row font-mono">
                  <span className="league-recent-badge">♥ +{ev.delta}</span>
                  <span className="league-recent-name">
                    {ev.from_display_name} → {ev.to_display_name || 'host'}
                  </span>
                  <span className="league-recent-pts">{ev.room_title_snapshot || 'Live'}</span>
                  <span className="league-recent-date">
                    {fmtDate(ev.created_at)} {fmtTime(ev.created_at)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── RIVALRY ARCS ───────────────────────────────────────────── */}
        {!busy && tab === 'rivals' && (
          <>
            {rivalries.length === 0 && (
              <div className="league-empty font-mono">
                No rivalry data yet — battles between different fighters unlock this.
              </div>
            )}
            <div className="rivalry-grid">
              {rivalries.slice(0, 50).map((r, i) => {
                const ahead = r.winsA > r.winsB ? r.playerA : r.winsB > r.winsA ? r.playerB : null
                const pctA = r.totalBattles > 0 ? (r.winsA / r.totalBattles) * 100 : 50
                return (
                  <div key={i} className="rivalry-card">
                    <div className="rivalry-matchup font-mono">
                      <span className={r.winsA >= r.winsB ? 'rivalry-winner' : ''}>{r.playerA}</span>
                      <span className="rivalry-vs">VS</span>
                      <span className={r.winsB > r.winsA ? 'rivalry-winner' : ''}>{r.playerB}</span>
                    </div>
                    <div className="rivalry-bar">
                      <div className="rivalry-bar-a" style={{ width: `${pctA}%` }} />
                    </div>
                    <div className="rivalry-scores font-mono">
                      <span>{r.winsA}W</span>
                      <span className="rivalry-total">{r.totalBattles} battles</span>
                      <span>{r.winsB}W</span>
                    </div>
                    {ahead && (
                      <div className="rivalry-lead font-mono">
                        {ahead} leads · Last fought {fmtDate(r.lastFought)}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* ── RECENT ─────────────────────────────────────────────────── */}
        {!busy && tab === 'recent' && (
          <>
            {recentWins.length === 0 && (
              <div className="league-empty font-mono">No recent battles.</div>
            )}
            <div className="league-recent">
              {recentWins.map((w) => (
                <div key={w.id} className="league-recent-row font-mono">
                  <span className="league-recent-badge">
                    {w.winner_team === 'alpha' ? '⚔ α' : '⚔ Ω'}
                  </span>
                  <span className="league-recent-name">{w.display_name_snapshot}</span>
                  <span className="league-recent-pts">+{w.points.toFixed(0)} pts</span>
                  <span className="league-recent-score">{w.break_score} break</span>
                  <span className="league-recent-date">{fmtDate(w.created_at)} {fmtTime(w.created_at)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
