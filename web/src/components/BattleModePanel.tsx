import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  ANIMATED_BATTLE_GIFT_COUNT,
  BATTLE_BREAKPOINT,
  BATTLE_DISCOUNT,
  BATTLE_GIFTS,
  CREATOR_REVENUE_RATE,
  discountedCost,
  GODMODE_TARGET,
  NETWORK_DESIGNER_REVENUE_RATE,
  splitBattleRevenue,
  type BattleGift,
  type BattleTeam,
} from '../lib/battleMode'
import { StripeCheckoutModal } from './StripeCheckoutModal'
import { sfxBreak, sfxCoinDrop, sfxEliminate, sfxForGift, sfxGodmode, sfxSurge, sfxWinner } from '../lib/battleSfx'
import type { BattleLeagueWin } from '../lib/supabase'
import { supabase } from '../lib/supabase'

type BattleScores = Record<BattleTeam, number>
type Inventory = Record<string, number>
type Godmode = Record<BattleTeam, number>
type RevenueTotals = {
  gross: number
  creator: number
  networkDesigners: number
}

type BattleEvent = {
  id: string
  team: BattleTeam
  target: BattleTeam
  gift: BattleGift
  text: string
}

type BountyOffer = {
  id: string
  recipient: string
  amount: number
  status: 'offered' | 'accepted'
}

export type BattleLeagueRow = {
  userId: string
  displayName: string
  wins: number
  points: number
  latestWinAt: string
}

type LiveState = {
  scores: Record<string, number>
  royaleScores: Record<string, number>
  enabled: boolean
  royaleMode: boolean
  wallet: number
  target: string
  royaleTarget: string
  selectedGiftId: string
}
type Props = {
  conversationId?: string
  onBattleEvent?: (message: string) => void
  onBattleHit?: (hit: BattleCameraHit) => void
  onRoyaleModeChange?: (active: boolean) => void
  onRoyaleElimination?: (team: RoyaleTeam) => void
  onRoyaleWinner?: (team: RoyaleTeam) => void
  /** Clear cam ELIMINATED / WINNER overlays immediately (RESET / STOP). */
  onRoyaleReset?: () => void
  /** Register full stop+reset so the stage UI can call it without waiting on timers. */
  onRegisterStopReset?: (fn: (() => void) | null) => void
  onLiveState?: (state: LiveState) => void
  /** Top league rows for the stage winners rail. */
  onLeagueUpdate?: (rows: BattleLeagueRow[]) => void
  /** Host/mod only — auto + manual league win recording. */
  canRecordLeague?: boolean
  /** Room host only — start/stop/reset controls. Non-hosts can still fire/spectate. */
  canControl?: boolean
  variant?: 'default' | 'studio'
}

const TEAM_LABEL: Record<BattleTeam, string> = {
  alpha: 'Host Alpha',
  omega: 'Host Omega',
}

const STARTING_WALLET = 200

export type RoyaleTeam = 'alpha' | 'omega' | 'sigma' | 'zeta' | 'kappa' | 'delta' | 'gamma'

export const ROYALE_TEAMS: readonly RoyaleTeam[] = [
  'alpha',
  'omega',
  'sigma',
  'zeta',
  'kappa',
  'delta',
  'gamma',
] as const

export const ROYALE_TEAM_LABEL: Record<RoyaleTeam, string> = {
  alpha: 'Cam 1',
  omega: 'Cam 2',
  sigma: 'Cam 3',
  zeta: 'Cam 4',
  kappa: 'Cam 5',
  delta: 'Cam 6',
  gamma: 'Cam 7',
}

export const ROYALE_COLORS: Record<RoyaleTeam, string> = {
  alpha: '#00f0ff',
  omega: '#a78bfa',
  sigma: '#fb923c',
  zeta: '#4ade80',
  kappa: '#f472b6',
  delta: '#facc15',
  gamma: '#38bdf8',
}

const EMPTY_ROYALE_SCORES: Record<RoyaleTeam, number> = {
  alpha: 0,
  omega: 0,
  sigma: 0,
  zeta: 0,
  kappa: 0,
  delta: 0,
  gamma: 0,
}

export type BattleCameraHit = {
  id: string
  target: RoyaleTeam
  attacker: RoyaleTeam
  giftId: string
  weapon: string
  giftName: string
  effectClass: string
  videoSrc?: string
}

/** Broadcast over Supabase Realtime so every client in the room sees the
 *  same fires/scores/resets — the local score state alone never left
 *  the device that fired, which is why hits weren't showing up elsewhere. */
type BattleSyncPayload =
  | { kind: 'royale_hit'; target: RoyaleTeam; power: number; hitId: string; giftId: string; weapon: string; giftName: string; effectClass: string; videoSrc?: string }
  | { kind: 'team_hit'; team: BattleTeam; target: BattleTeam; power: number; hitId: string; giftId: string; weapon: string; giftName: string; effectClass: string; videoSrc?: string; text: string }
  | { kind: 'royale_mode'; active: boolean }
  | { kind: 'battle_enabled'; active: boolean }
  | { kind: 'royale_reset' }
  | { kind: 'battle_reset' }
  | { kind: 'stop_all' }
  | { kind: 'royale_eliminate'; team: RoyaleTeam }
  | { kind: 'royale_winner'; team: RoyaleTeam }
type BattleSyncMsg = BattleSyncPayload & { senderId: string }

export default function BattleModePanel({
  conversationId,
  onBattleEvent,
  onBattleHit,
  onRoyaleModeChange,
  onRoyaleElimination,
  onRoyaleWinner,
  onRoyaleReset,
  onRegisterStopReset,
  onLiveState,
  onLeagueUpdate,
  canRecordLeague = true,
  canControl = true,
  variant = 'default',
}: Props) {
  const [enabled, setEnabled] = useState(false)
  const [wallet, setWallet] = useState(STARTING_WALLET)
  const [selectedTeam, setSelectedTeam] = useState<BattleTeam>('alpha')
  const [targetTeam, setTargetTeam] = useState<BattleTeam>('omega')
  const [scores, setScores] = useState<BattleScores>({ alpha: 0, omega: 0 })
  const [inventory, setInventory] = useState<Inventory>({})
  const [godmode, setGodmode] = useState<Godmode>({ alpha: 0, omega: 0 })
  const [revenue, setRevenue] = useState<RevenueTotals>({ gross: 0, creator: 0, networkDesigners: 0 })
  const [bountyOffers, setBountyOffers] = useState<BountyOffer[]>([])
  const [bountyRecipient, setBountyRecipient] = useState('')
  const [bountyAmount, setBountyAmount] = useState(0)
  const [events, setEvents] = useState<BattleEvent[]>([])
  const [checkoutBusy, setCheckoutBusy] = useState<string | null>(null)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [stripeModalInput, setStripeModalInput] = useState<{
    conversationId: string; giftId: string; team: string; targetTeam: string; quantity: number
  } | null>(null)
  const [selectedGiftId, setSelectedGiftId] = useState(BATTLE_GIFTS[0]?.id ?? '')
  const [leagueRows, setLeagueRows] = useState<BattleLeagueRow[]>([])
  const [leagueError, setLeagueError] = useState<string | null>(null)
  const [leagueBusy, setLeagueBusy] = useState(false)
  const [recordedWinnerKey, setRecordedWinnerKey] = useState<string | null>(null)
  const [sessionWins, setSessionWins] = useState(0)
  const [sessionRounds, setSessionRounds] = useState(0)
  const [myUserId, setMyUserId] = useState<string | null>(null)
  const eventSeqRef = useRef(0)
  const leagueRecordAttemptRef = useRef<string | null>(null)
  const onLeagueUpdateRef = useRef(onLeagueUpdate)
  onLeagueUpdateRef.current = onLeagueUpdate
  const onRoyaleModeChangeRef = useRef(onRoyaleModeChange)
  onRoyaleModeChangeRef.current = onRoyaleModeChange
  const onLiveStateRef = useRef(onLiveState)
  onLiveStateRef.current = onLiveState
  const onBattleHitRef = useRef(onBattleHit)
  onBattleHitRef.current = onBattleHit
  const liveStateKeyRef = useRef('')
  const myUserIdRef = useRef<string | null>(null)
  myUserIdRef.current = myUserId
  const syncChannelRef = useRef<ReturnType<NonNullable<typeof supabase>['channel']> | null>(null)

  /** Send a battle action to every other client in the room. Applied locally
   *  already (optimistic) — this just fans it out so scores/fires/resets
   *  actually show up on other people's screens instead of staying local. */
  const broadcastSync = (msg: BattleSyncPayload) => {
    if (!syncChannelRef.current) return
    void syncChannelRef.current.send({
      type: 'broadcast',
      event: 'battle_sync',
      payload: { ...msg, senderId: myUserIdRef.current ?? '' } as BattleSyncMsg,
    })
  }

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getUser().then(({ data }) => {
      setMyUserId(data.user?.id ?? null)
    })
  }, [])

  useEffect(() => {
    if (!supabase) return
    const client = supabase
    const ch = client
      .channel(`battle-sync:${conversationId ?? 'global'}`)
      .on('broadcast', { event: 'battle_sync' }, ({ payload }) => {
        const msg = payload as BattleSyncMsg
        if (!msg || msg.senderId === myUserIdRef.current) return
        switch (msg.kind) {
          case 'royale_hit':
            setRoyaleScores((current) => ({
              ...current,
              [msg.target]: Math.min(BATTLE_BREAKPOINT, (current[msg.target] ?? 0) + msg.power),
            }))
            onBattleHitRef.current?.({
              id: msg.hitId,
              target: msg.target,
              attacker: 'alpha',
              giftId: msg.giftId,
              weapon: msg.weapon,
              giftName: msg.giftName,
              effectClass: msg.effectClass,
              videoSrc: msg.videoSrc,
            })
            onBattleEvent?.(`Royale: ${ROYALE_TEAM_LABEL[msg.target]} took +${msg.power} from ${msg.giftName}.`)
            break
          case 'team_hit':
            setScores((current) => ({
              ...current,
              [msg.target]: Math.min(BATTLE_BREAKPOINT, current[msg.target] + msg.power),
            }))
            onBattleHitRef.current?.({
              id: msg.hitId,
              target: msg.target as unknown as RoyaleTeam,
              attacker: msg.team as unknown as RoyaleTeam,
              giftId: msg.giftId,
              weapon: msg.weapon,
              giftName: msg.giftName,
              effectClass: msg.effectClass,
              videoSrc: msg.videoSrc,
            })
            onBattleEvent?.(msg.text)
            break
          case 'royale_mode':
            setRoyaleMode(msg.active)
            break
          case 'battle_enabled':
            setEnabled(msg.active)
            break
          case 'royale_reset':
            setRoyaleScores({ ...EMPTY_ROYALE_SCORES })
            setEliminatedTeams([])
            setRoyaleWinner(null)
            setElimCountdown(60)
            onRoyaleReset?.()
            break
          case 'battle_reset':
            setScores({ alpha: 0, omega: 0 })
            setGodmode({ alpha: 0, omega: 0 })
            setEvents([])
            break
          case 'stop_all':
            setEnabled(false)
            setRoyaleMode(false)
            setSurgeActive(false)
            setSurgeTeam(null)
            setRoyaleScores({ ...EMPTY_ROYALE_SCORES })
            setEliminatedTeams([])
            setRoyaleWinner(null)
            setScores({ alpha: 0, omega: 0 })
            setGodmode({ alpha: 0, omega: 0 })
            setEvents([])
            onRoyaleReset?.()
            onBattleEvent?.('⏹ Battle stopped and reset — cams cleared.')
            break
          case 'royale_eliminate':
            setEliminatedTeams((prev) => (prev.includes(msg.team) ? prev : [...prev, msg.team]))
            sfxEliminate()
            onBattleEvent?.(`💀 ${ROYALE_TEAM_LABEL[msg.team]} eliminated from Battle Royale!`)
            onRoyaleElimination?.(msg.team)
            break
          case 'royale_winner':
            setRoyaleWinner(msg.team)
            sfxWinner()
            onRoyaleWinner?.(msg.team)
            break
        }
      })
      .subscribe()
    syncChannelRef.current = ch
    return () => {
      syncChannelRef.current = null
      void client.removeChannel(ch)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  // ── Crowd Surge ──────────────────────────────────────────────────────────
  const giftTimestampsRef = useRef<number[]>([])
  const surgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [surgeActive, setSurgeActive] = useState(false)
  const [surgeTeam, setSurgeTeam] = useState<BattleTeam | null>(null)

  // ── Battle Royale ─────────────────────────────────────────────────────────
  const [royaleMode, setRoyaleMode] = useState(false)
  const [royaleScores, setRoyaleScores] = useState<Record<RoyaleTeam, number>>(() => ({ ...EMPTY_ROYALE_SCORES }))
  const [royaleTarget, setRoyaleTarget] = useState<RoyaleTeam>('omega')
  const [eliminatedTeams, setEliminatedTeams] = useState<RoyaleTeam[]>([])
  const [royaleWinner, setRoyaleWinner] = useState<RoyaleTeam | null>(null)
  const [elimCountdown, setElimCountdown] = useState(60)
  const royaleScoresRef = useRef(royaleScores)
  const eliminatedTeamsRef = useRef(eliminatedTeams)
  royaleScoresRef.current = royaleScores
  eliminatedTeamsRef.current = eliminatedTeams

  const brokenHost = scores.alpha >= BATTLE_BREAKPOINT ? 'alpha' : scores.omega >= BATTLE_BREAKPOINT ? 'omega' : null
  const roundWinner = brokenHost ? (brokenHost === 'alpha' ? 'omega' : 'alpha') : null
  const selectedGift = useMemo(
    () => BATTLE_GIFTS.find((gift) => gift.id === selectedGiftId) ?? BATTLE_GIFTS[0],
    [selectedGiftId],
  )
  const reservedBounty = bountyOffers.reduce((sum, offer) => sum + offer.amount, 0)
  const bountyAvailable = Math.max(0, revenue.creator - reservedBounty)
  const bonusTeam = useMemo(
    () =>
      (Object.keys(scores) as BattleTeam[]).find(
        (team) => scores[team] >= BATTLE_BREAKPOINT && scores[team] - scores[team === 'alpha' ? 'omega' : 'alpha'] >= 5,
      ) ?? null,
    [scores],
  )
  const winnerKey = roundWinner ? `${conversationId ?? 'local'}:${roundWinner}:${scores.alpha}:${scores.omega}` : null

  async function loadBattleLeague() {
    if (!supabase) return
    const { data, error } = await supabase
      .from('battle_league_wins')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1000)

    if (error) {
      setLeagueError(
        error.message.includes('relation') || error.code === '42P01'
          ? 'Battle League DB missing — run supabase/FIX_BATTLE_LEAGUE.sql in Supabase SQL Editor.'
          : error.message,
      )
      setLeagueRows([])
      onLeagueUpdateRef.current?.([])
      return
    }

    const wins = ((data ?? []) as BattleLeagueWin[]) || []
    const grouped = new Map<string, BattleLeagueRow>()
    for (const win of wins) {
      const current = grouped.get(win.user_id)
      if (!current) {
        grouped.set(win.user_id, {
          userId: win.user_id,
          displayName: win.display_name_snapshot || win.user_id.slice(0, 8),
          wins: 1,
          points: win.points,
          latestWinAt: win.created_at,
        })
        continue
      }
      current.wins += 1
      current.points += win.points
      if (new Date(win.created_at).getTime() > new Date(current.latestWinAt).getTime()) {
        current.latestWinAt = win.created_at
        current.displayName = win.display_name_snapshot || current.displayName
      }
    }

    const rows = [...grouped.values()]
      .sort((a, b) => b.points - a.points || b.wins - a.wins || new Date(b.latestWinAt).getTime() - new Date(a.latestWinAt).getTime())
      .slice(0, 100)
    setLeagueError(null)
    setLeagueRows(rows)
    onLeagueUpdateRef.current?.(rows)
  }

  useEffect(() => {
    void loadBattleLeague()
    if (!supabase) return
    const client = supabase
    const ch = client
      .channel(`battle-league:${conversationId ?? 'global'}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'battle_league_wins' },
        () => {
          void loadBattleLeague()
        },
      )
      .subscribe()
    return () => {
      void client.removeChannel(ch)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  useEffect(() => {
    if (roundWinner) {
      sfxBreak(); setTimeout(sfxWinner, 400)
      setSessionRounds((n) => n + 1)
      if (roundWinner === 'alpha') setSessionWins((n) => n + 1)
    } else {
      setRecordedWinnerKey(null)
      leagueRecordAttemptRef.current = null
    }
  }, [roundWinner])

  // ── Battle Royale elimination timer ──────────────────────────────────────
  useEffect(() => {
    if (!royaleMode || royaleWinner) return
    const activeTeams = ROYALE_TEAMS.filter((t) => !eliminatedTeamsRef.current.includes(t))
    if (activeTeams.length <= 1) {
      if (canControl && activeTeams[0]) {
        setRoyaleWinner(activeTeams[0])
        broadcastSync({ kind: 'royale_winner', team: activeTeams[0] })
      }
      return
    }
    setElimCountdown(60)
    const interval = setInterval(() => {
      setElimCountdown((prev) => {
        if (prev > 1) return prev - 1
        /* Only the host actually decides eliminations and broadcasts them —
         * everyone's countdown was ticking independently, so without this every
         * client could pick a different "loser" at a slightly different moment. */
        if (!canControl) return 60
        const alive = ROYALE_TEAMS.filter((t) => !eliminatedTeamsRef.current.includes(t))
        if (alive.length <= 1) {
          if (alive[0]) {
            setRoyaleWinner(alive[0])
            broadcastSync({ kind: 'royale_winner', team: alive[0] })
          }
          return 60
        }
        const loser = alive.reduce((worst, team) =>
          royaleScoresRef.current[team] > royaleScoresRef.current[worst] ? team : worst,
          alive[0]!,
        )
        // Nobody's actually landed a hit yet — don't eliminate on a technicality.
        if (royaleScoresRef.current[loser] <= 0) return 60
        setEliminatedTeams((prev) => [...prev, loser])
        sfxEliminate()
        onBattleEvent?.(`💀 ${ROYALE_TEAM_LABEL[loser]} eliminated from Battle Royale!`)
        onRoyaleElimination?.(loser)
        broadcastSync({ kind: 'royale_eliminate', team: loser })
        const remaining = alive.filter((t) => t !== loser)
        if (remaining.length === 1) {
          setRoyaleWinner(remaining[0]!)
          sfxWinner()
          onRoyaleWinner?.(remaining[0]!)
          broadcastSync({ kind: 'royale_winner', team: remaining[0]! })
        }
        return 60
      })
    }, 1000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [royaleMode, royaleWinner, eliminatedTeams.length, canControl])

  // Notify parent when royale mode toggles (stable ref — avoids render loops).
  useEffect(() => {
    onRoyaleModeChangeRef.current?.(royaleMode)
  }, [royaleMode])

  // Broadcast live state for cam overlays — skip if unchanged.
  useEffect(() => {
    const royaleKey = ROYALE_TEAMS.map((t) => royaleScores[t] ?? 0).join(',')
    const key = [
      scores.alpha,
      scores.omega,
      royaleKey,
      enabled,
      royaleMode,
      wallet,
      targetTeam,
      royaleTarget,
      selectedGiftId,
    ].join('|')
    if (key === liveStateKeyRef.current) return
    liveStateKeyRef.current = key
    onLiveStateRef.current?.({
      scores: scores as Record<string, number>,
      royaleScores: royaleScores as Record<string, number>,
      enabled,
      royaleMode,
      wallet,
      target: targetTeam,
      royaleTarget,
      selectedGiftId,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scores.alpha, scores.omega, royaleScores, enabled, royaleMode, wallet, targetTeam, royaleTarget, selectedGiftId])

  // ── Crowd Surge detector ─────────────────────────────────────────────────
  function detectSurge(team: BattleTeam) {
    const now = Date.now()
    giftTimestampsRef.current = giftTimestampsRef.current.filter((t) => now - t < 10_000)
    giftTimestampsRef.current.push(now)
    if (giftTimestampsRef.current.length >= 5 && !surgeActive) {
      giftTimestampsRef.current = []
      setSurgeActive(true)
      setSurgeTeam(team)
      setScores((current) => ({
        ...current,
        [targetTeam]: Math.min(BATTLE_BREAKPOINT, current[targetTeam] + 10),
      }))
      sfxSurge()
      onBattleEvent?.(`⚡ CROWD SURGE! ${TEAM_LABEL[team]} combined attack: +10 damage!`)
      if (surgeTimerRef.current) clearTimeout(surgeTimerRef.current)
      surgeTimerRef.current = setTimeout(() => {
        setSurgeActive(false)
        setSurgeTeam(null)
      }, 3000)
    }
  }

  function fireRoyale() {
    if (eliminatedTeams.includes(royaleTarget) || royaleWinner) return
    const gift = selectedGift
    if (!gift) return
    const power = gift.power
    const hitId = nextEventId(`royale:${gift.id}`)
    setRoyaleScores((current) => ({
      ...current,
      [royaleTarget]: Math.min(BATTLE_BREAKPOINT, current[royaleTarget] + power),
    }))
    onBattleHit?.({
      id: hitId,
      target: royaleTarget,
      attacker: 'alpha',
      giftId: gift.id,
      weapon: gift.weapon,
      giftName: gift.name,
      effectClass: gift.effectClass,
      videoSrc: gift.videoSrc,
    })
    onBattleEvent?.(`Royale: ${ROYALE_TEAM_LABEL[royaleTarget]} took +${power} from ${gift.name}.`)
    broadcastSync({
      kind: 'royale_hit',
      target: royaleTarget,
      power,
      hitId,
      giftId: gift.id,
      weapon: gift.weapon,
      giftName: gift.name,
      effectClass: gift.effectClass,
      videoSrc: gift.videoSrc,
    })
  }

  function resetRoyale() {
    if (!canControl) return
    setRoyaleScores({ ...EMPTY_ROYALE_SCORES })
    setEliminatedTeams([])
    setRoyaleWinner(null)
    setElimCountdown(60)
    onRoyaleReset?.()
    broadcastSync({ kind: 'royale_reset' })
  }

  function resetBattle() {
    if (!canControl) return
    setWallet(STARTING_WALLET)
    setScores({ alpha: 0, omega: 0 })
    setInventory({})
    setGodmode({ alpha: 0, omega: 0 })
    setRevenue({ gross: 0, creator: 0, networkDesigners: 0 })
    setBountyOffers([])
    setBountyRecipient('')
    setBountyAmount(0)
    setEvents([])
    setRecordedWinnerKey(null)
    setSessionWins(0)
    setSessionRounds(0)
    broadcastSync({ kind: 'battle_reset' })
    resetRoyale()
  }

  /** Full stop: end 2p + royale timers, clear scores/elim overlays on cams. */
  function stopAndResetAll() {
    if (!canControl) return
    setEnabled(false)
    setRoyaleMode(false)
    setSurgeActive(false)
    setSurgeTeam(null)
    resetBattle()
    onBattleEvent?.('⏹ Battle stopped and reset — cams cleared.')
    broadcastSync({ kind: 'stop_all' })
  }

  useEffect(() => {
    onRegisterStopReset?.(stopAndResetAll)
    return () => onRegisterStopReset?.(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRegisterStopReset])

  function chooseTeam(team: BattleTeam) {
    setSelectedTeam(team)
    setTargetTeam(team === 'alpha' ? 'omega' : 'alpha')
  }

  function nextEventId(prefix: string) {
    eventSeqRef.current += 1
    return `${prefix}:${Date.now()}:${eventSeqRef.current}`
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('checkout') !== 'success') return
    const giftId = params.get('battle_gift')
    const gift = BATTLE_GIFTS.find((item) => item.id === giftId)
    if (!gift) return
    const quantity = Math.max(1, Number(params.get('battle_qty') ?? 1))
    grantGift(gift, quantity)
    onBattleEvent?.(`Stripe checkout returned: ${quantity} ${gift.name} unlocked for this browser.`)
    params.delete('checkout')
    params.delete('battle_gift')
    params.delete('battle_qty')
    const nextSearch = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot URL fulfillment on mount
  }, [])

  function grantGift(gift: BattleGift, quantity = 1) {
    const cost = discountedCost(gift.baseCost)
    const split = splitBattleRevenue(cost)
    setInventory((items) => ({ ...items, [gift.id]: (items[gift.id] ?? 0) + quantity }))
    setRevenue((current) => ({
      gross: current.gross + split.gross * quantity,
      creator: current.creator + split.creator * quantity,
      networkDesigners: current.networkDesigners + split.networkDesigners * quantity,
    }))
  }

  function showBattleAnimation(event: BattleEvent, targetOverride?: RoyaleTeam) {
    onBattleHit?.({
      id: event.id,
      target: (targetOverride ?? event.target) as RoyaleTeam,
      attacker: event.team as RoyaleTeam,
      giftId: event.gift.id,
      weapon: event.gift.weapon,
      giftName: event.gift.name,
      effectClass: event.gift.effectClass,
      videoSrc: event.gift.videoSrc,
    })
  }

  function buyDemo(gift: BattleGift) {
    const cost = discountedCost(gift.baseCost)
    if (wallet < cost) return
    setWallet((value) => value - cost)
    sfxCoinDrop()
    grantGift(gift)

    // ── Royale mode: route damage to royale scores, not team battle ──
    if (royaleMode) {
      if (eliminatedTeams.includes(royaleTarget) || royaleWinner) return
      const previewEvent: BattleEvent = {
        id: nextEventId(`demo:${gift.id}`),
        team: selectedTeam,
        target: targetTeam,
        gift,
        text: `Royale demo: ${ROYALE_TEAM_LABEL[royaleTarget]} took +1 hit.`,
      }
      setRoyaleScores((current) => ({
        ...current,
        [royaleTarget]: Math.min(BATTLE_BREAKPOINT, current[royaleTarget] + 1),
      }))
      setEvents((current) => [previewEvent, ...current].slice(0, 5))
      showBattleAnimation(previewEvent, royaleTarget)
      onBattleEvent?.(`${previewEvent.text} Demo inventory added.`)
      return
    }

    // ── Team battle mode ────────────────────────────────────────────────
    const previewEvent: BattleEvent = {
      id: nextEventId(`demo:${gift.id}`),
      team: selectedTeam,
      target: targetTeam,
      gift,
      text: `${TEAM_LABEL[selectedTeam]} demo hit ${TEAM_LABEL[targetTeam]} with ${gift.name} for +1.`,
    }
    setScores((current) => ({ ...current, [targetTeam]: Math.min(BATTLE_BREAKPOINT, current[targetTeam] + 1) }))
    setEvents((current) => [previewEvent, ...current].slice(0, 5))
    showBattleAnimation(previewEvent)
    onBattleEvent?.(`${previewEvent.text} Demo added 1 to inventory and played the animation.`)
  }

  function buyWithStripe(gift: BattleGift) {
    if (!conversationId) {
      setCheckoutError('Open Battle Mode inside a live room before using Stripe checkout.')
      return
    }
    setCheckoutError(null)
    setStripeModalInput({
      conversationId,
      giftId: gift.id,
      team: selectedTeam,
      targetTeam,
      quantity: 1,
    })
  }

  function onStripeSuccess(giftId: string, qty: number) {
    const gift = BATTLE_GIFTS.find((g) => g.id === giftId)
    if (gift) {
      setInventory((prev) => ({ ...prev, [giftId]: (prev[giftId] ?? 0) + qty }))
      sfxCoinDrop()
      onBattleEvent?.(`Stripe: ${qty}× ${gift.name} added to inventory.`)
    }
  }

  function fire(gift: BattleGift) {
    if ((inventory[gift.id] ?? 0) <= 0) return

    // ── Royale mode: route damage to royale scores, not team battle ──
    if (royaleMode) {
      if (eliminatedTeams.includes(royaleTarget) || royaleWinner) return
      const power = gift.power
      const nextEvent: BattleEvent = {
        id: nextEventId(`fire:${gift.id}`),
        team: selectedTeam,
        target: targetTeam,
        gift,
        text: `Royale: ${ROYALE_TEAM_LABEL[royaleTarget]} hit for +${power} from ${gift.name}.`,
      }
      setInventory((items) => ({ ...items, [gift.id]: Math.max(0, (items[gift.id] ?? 0) - 1) }))
      setRoyaleScores((current) => ({
        ...current,
        [royaleTarget]: Math.min(BATTLE_BREAKPOINT, current[royaleTarget] + power),
      }))
      setEvents((current) => [nextEvent, ...current].slice(0, 5))
      showBattleAnimation(nextEvent, royaleTarget)
      sfxForGift(gift.effectClass)
      onBattleEvent?.(nextEvent.text)
      broadcastSync({
        kind: 'royale_hit',
        target: royaleTarget,
        power,
        hitId: nextEvent.id,
        giftId: gift.id,
        weapon: gift.weapon,
        giftName: gift.name,
        effectClass: gift.effectClass,
        videoSrc: gift.videoSrc,
      })
      return
    }

    // ── Team battle mode ────────────────────────────────────────────────
    if (brokenHost) return

    const bonusBoost = bonusTeam === selectedTeam ? 2 : 1
    const power = gift.power * bonusBoost
    const godmodeGain = gift.id === 'snowball' ? 1 : gift.godmode
    const nextEvent: BattleEvent = {
      id: nextEventId(`fire:${gift.id}`),
      team: selectedTeam,
      target: targetTeam,
      gift,
      text: `${TEAM_LABEL[selectedTeam]} fired ${gift.name} at ${TEAM_LABEL[targetTeam]} for +${power}.`,
    }

    setInventory((items) => ({ ...items, [gift.id]: Math.max(0, (items[gift.id] ?? 0) - 1) }))
    setScores((current) => ({ ...current, [targetTeam]: Math.min(BATTLE_BREAKPOINT, current[targetTeam] + power) }))
    setGodmode((current) => ({ ...current, [selectedTeam]: Math.min(GODMODE_TARGET, current[selectedTeam] + godmodeGain) }))
    setEvents((current) => [nextEvent, ...current].slice(0, 5))
    showBattleAnimation(nextEvent)
    sfxForGift(gift.effectClass)
    onBattleEvent?.(
      `${nextEvent.text} ${gift.id === 'snowball' ? 'Direct snowball hit: +1 toward Godmode.' : `Godmode +${godmodeGain}.`}`,
    )
    broadcastSync({
      kind: 'team_hit',
      team: selectedTeam,
      target: targetTeam,
      power,
      hitId: nextEvent.id,
      giftId: gift.id,
      weapon: gift.weapon,
      giftName: gift.name,
      effectClass: gift.effectClass,
      videoSrc: gift.videoSrc,
      text: nextEvent.text,
    })
    detectSurge(selectedTeam)
  }

  function offerBountyShare() {
    const recipient = bountyRecipient.trim()
    const amount = Math.floor(bountyAmount)
    if (!recipient || amount <= 0 || amount > bountyAvailable) return

    const offer: BountyOffer = {
      id: nextEventId('bounty'),
      recipient,
      amount,
      status: 'offered',
    }

    setBountyOffers((current) => [offer, ...current].slice(0, 6))
    setBountyRecipient('')
    setBountyAmount(0)
    onBattleEvent?.(`Host offered ${amount} bounty coins to ${recipient}.`)
  }

  function acceptLocalOffer(id: string) {
    setBountyOffers((current) =>
      current.map((offer) => (offer.id === id ? { ...offer, status: 'accepted' as const } : offer)),
    )
  }

  async function recordLeagueWin() {
    if (!canRecordLeague) return
    if (!supabase || !roundWinner || !winnerKey) return
    if (recordedWinnerKey === winnerKey) return
    const loserTeam = roundWinner === 'alpha' ? 'omega' : 'alpha'
    setLeagueBusy(true)
    const { error } = await supabase.rpc('record_battle_win', {
      p_conversation_id: conversationId ?? null,
      p_winner_team: roundWinner,
      p_loser_team: loserTeam,
      p_break_score: BATTLE_BREAKPOINT,
    })
    setLeagueBusy(false)
    if (error) {
      setLeagueError(
        error.message.includes('function') || error.message.includes('schema cache')
          ? 'Battle League RPC missing — run supabase/FIX_BATTLE_LEAGUE.sql in Supabase SQL Editor.'
          : error.message,
      )
      return
    }
    setRecordedWinnerKey(winnerKey)
    onBattleEvent?.(`🏆 League win recorded for ${TEAM_LABEL[roundWinner]}.`)
    await loadBattleLeague()
  }

  /* Auto-record league win once per round (host/mod only). */
  useEffect(() => {
    if (!canRecordLeague) return
    if (!roundWinner || !winnerKey) return
    if (recordedWinnerKey === winnerKey || leagueRecordAttemptRef.current === winnerKey) return
    leagueRecordAttemptRef.current = winnerKey
    void recordLeagueWin()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundWinner, winnerKey, canRecordLeague])

  return (
    <section className={`battle-mode ${enabled ? 'battle-mode--live' : ''}${royaleMode ? ' battle-mode--royale' : ''}${variant === 'studio' ? ' battle-mode--studio' : ''}`} aria-label="Battle Mode">
      <div className="battle-mode-head">
        <div>
          {variant !== 'studio' && <div className="battle-kicker font-mono">BATTLE MODE</div>}
          <h3>{variant === 'studio' ? 'Gift battle' : 'Team gift battle'}</h3>
        </div>
        <div className="battle-head-actions">
          <span className="battle-wallet font-mono">{wallet} coins</span>
          {canControl && (
            <button
              className={enabled ? 'primary' : 'secondary'}
              type="button"
              onClick={() => {
                const next = !enabled
                setEnabled(next)
                broadcastSync({ kind: 'battle_enabled', active: next })
              }}
            >
              {enabled ? 'Battle live' : 'Start battle'}
            </button>
          )}
        </div>
      </div>

      {/* 2-player scores — hidden in royale mode (royale has its own grid) */}
      {!royaleMode && (
      <div className="battle-scoreboard" aria-live="polite">
        {(['alpha', 'omega'] as BattleTeam[]).map((team) => {
          const score = scores[team]
          const progress = Math.min(100, (score / BATTLE_BREAKPOINT) * 100)
          const godmodeProgress = (godmode[team] / GODMODE_TARGET) * 100
          const remaining = Math.max(0, BATTLE_BREAKPOINT - score)
          const winRate = team === 'alpha' && sessionRounds > 0
            ? Math.round((sessionWins / sessionRounds) * 100)
            : null
          return (
            <div
              key={team}
              className={`battle-team ${bonusTeam === team ? 'battle-team--bonus' : ''}`}
              role="group"
              aria-label={`${TEAM_LABEL[team]} score ${score} of ${BATTLE_BREAKPOINT}`}
            >
              <span className="battle-team-name">
                {TEAM_LABEL[team]}
                {winRate !== null && (
                  <span className="battle-win-rate font-mono"> · {winRate}% WIN</span>
                )}
              </span>
              <span className="battle-team-score">
                {score}
                <small>/{BATTLE_BREAKPOINT}</small>
              </span>
              <span className="battle-team-left font-mono">{remaining} left</span>
              <span className="battle-meter" aria-hidden>
                <span style={{ width: `${progress}%` }} />
              </span>
              <span className="battle-godmode font-mono">
                Hit score {score}/{BATTLE_BREAKPOINT} · Godmode {godmode[team]}/{GODMODE_TARGET}
                <span className="battle-godmode-bar" aria-hidden>
                  <span style={{ width: `${godmodeProgress}%` }} />
                </span>
              </span>
            </div>
          )
        })}
      </div>
      )}

      {/* ── Crowd Surge Banner ─────────────────────────────────────────── */}
      {surgeActive && (
        <div className="battle-surge-banner font-mono" role="alert">
          ⚡ CROWD SURGE — {surgeTeam ? TEAM_LABEL[surgeTeam] : ''} COMBINED ATTACK +10
        </div>
      )}

      {/* ── Battle Royale ──────────────────────────────────────────────── */}
      <div className="battle-royale-panel">
        <div className="battle-royale-head">
          <div>
            <div className="battle-kicker font-mono">BATTLE ROYALE</div>
            <strong>7-cam elimination · last standing wins</strong>
          </div>
          <div className="row">
            {canControl && (
              <button
                className={royaleMode ? 'primary' : 'secondary'}
                type="button"
                onClick={() => {
                  const next = !royaleMode
                  setRoyaleMode(next)
                  broadcastSync({ kind: 'royale_mode', active: next })
                  resetRoyale()
                }}
              >
                {royaleMode ? 'ROYALE LIVE' : 'START ROYALE'}
              </button>
            )}
            {royaleMode && canControl && (
              <>
                <button className="secondary" type="button" onClick={resetRoyale}>
                  RESET
                </button>
                <button className="primary battle-stop-reset-btn" type="button" onClick={stopAndResetAll}>
                  STOP · RESET
                </button>
              </>
            )}
          </div>
        </div>

        {royaleMode && (
          <>
            <div className="battle-royale-timer font-mono">
              {royaleWinner
                ? `🏆 ${ROYALE_TEAM_LABEL[royaleWinner]} WINS THE ROYALE`
                : `Next elimination in ${elimCountdown}s`}
            </div>
            <div className="battle-royale-grid">
              {ROYALE_TEAMS.map((team) => {
                const eliminated = eliminatedTeams.includes(team)
                const progress = Math.min(100, (royaleScores[team] / BATTLE_BREAKPOINT) * 100)
                return (
                  <div
                    key={team}
                    className={`battle-royale-slot ${eliminated ? 'battle-royale-slot--out' : ''} ${royaleWinner === team ? 'battle-royale-slot--winner' : ''}`}
                    style={{ '--royale-color': ROYALE_COLORS[team] } as React.CSSProperties}
                  >
                    <span className="font-mono">{ROYALE_TEAM_LABEL[team]}</span>
                    {eliminated ? (
                      <span className="battle-royale-eliminated font-mono">ELIMINATED</span>
                    ) : royaleWinner === team ? (
                      <span className="battle-royale-crown">👑 WINNER</span>
                    ) : (
                      <>
                        <span className="font-mono">{royaleScores[team]}/{BATTLE_BREAKPOINT}</span>
                        <span className="battle-meter" aria-hidden>
                          <span style={{ width: `${progress}%`, background: ROYALE_COLORS[team] }} />
                        </span>
                        <button
                          className={royaleTarget === team ? 'primary' : 'secondary'}
                          type="button"
                          onClick={() => setRoyaleTarget(team)}
                        >
                          Target
                        </button>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="row">
              <button
                className="primary"
                type="button"
                disabled={!!royaleWinner || eliminatedTeams.includes(royaleTarget)}
                onClick={fireRoyale}
              >
                Fire at {ROYALE_TEAM_LABEL[royaleTarget]}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Dual-only info — hidden in royale */}
      {!royaleMode && (
        <>
          {variant !== 'studio' && (
            <div className="battle-state font-mono">
              <span>{roundWinner ? `${TEAM_LABEL[roundWinner]} wins round` : '1 host vs 1 host'}</span>
              <span>Break target bar to {BATTLE_BREAKPOINT}</span>
              <span>
                {BATTLE_GIFTS.length} gifts · {ANIMATED_BATTLE_GIFT_COUNT} animations
              </span>
              <span>Chat teams fire gifts at the host camera</span>
              <span>
                Creator {Math.round(CREATOR_REVENUE_RATE * 100)}% · Network designers{' '}
                {Math.round(NETWORK_DESIGNER_REVENUE_RATE * 100)}%
              </span>
              {bonusTeam && <strong>{TEAM_LABEL[bonusTeam]} bonus mode x2</strong>}
            </div>
          )}

          {roundWinner && canRecordLeague && (
            <div className="battle-record-row">
              <span className="font-mono battle-kicker">{TEAM_LABEL[roundWinner]} wins</span>
              <button
                className="primary"
                type="button"
                disabled={leagueBusy || recordedWinnerKey === winnerKey}
                onClick={() => void recordLeagueWin()}
              >
                {recordedWinnerKey === winnerKey ? '✓ Recorded' : leagueBusy ? 'Saving…' : 'Record to League'}
              </button>
            </div>
          )}

          <div className="battle-league-board font-mono" aria-label="Battle League top winners">
            <div className="battle-league-board-head">
              <strong>Battle League</strong>
              <span>{leagueRows.length ? `Top ${Math.min(10, leagueRows.length)}` : 'No wins yet'}</span>
            </div>
            {leagueError && (
              <div className="battle-league-error" role="alert">
                {leagueError}
              </div>
            )}
            {leagueRows.length === 0 && !leagueError ? (
              <p className="battle-league-empty">Finish a battle to record wins · plays sync here live.</p>
            ) : (
              <ol className="battle-league-list">
                {leagueRows.slice(0, 10).map((row, i) => (
                  <li
                    key={row.userId}
                    className={`battle-league-row${myUserId === row.userId ? ' battle-league-row--you' : ''}`}
                  >
                    <span className="battle-league-rank">{i + 1}</span>
                    <span className="battle-league-name" title={row.displayName}>
                      {row.displayName}
                      {myUserId === row.userId ? ' · you' : ''}
                    </span>
                    <span className="battle-league-wins">{row.wins}W</span>
                    <span className="battle-league-pts">{row.points}pts</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {variant !== 'studio' && (
            <div className="battle-revenue font-mono" aria-label="Battle purchase revenue split">
              <span>Gross {revenue.gross}</span>
              <span>User payout {revenue.creator}</span>
              <span>Network designers {revenue.networkDesigners}</span>
            </div>
          )}
        </>
      )}

      {checkoutError && (
        <div className="battle-checkout-error font-mono" role="alert">
          {checkoutError}
        </div>
      )}

      <details className={`battle-bounty${variant === 'studio' ? ' battle-bounty--studio' : ''}`} open={variant !== 'studio'}>
        <summary className="battle-bounty-head">
          <strong>Host bounty share</strong>
          <span className="font-mono">Available {bountyAvailable} · Reserved {reservedBounty}</span>
        </summary>
        <div className="battle-bounty-form">
          <input
            type="text"
            value={bountyRecipient}
            onChange={(event) => setBountyRecipient(event.target.value)}
            placeholder="User name..."
            className="font-mono"
          />
          <input
            type="number"
            min="0"
            max={bountyAvailable}
            value={bountyAmount || ''}
            onChange={(event) => setBountyAmount(Number(event.target.value))}
            placeholder="Amount"
            className="font-mono"
          />
          <button
            className="secondary"
            type="button"
            disabled={!enabled || !bountyRecipient.trim() || bountyAmount <= 0 || bountyAmount > bountyAvailable}
            onClick={offerBountyShare}
          >
            Offer share
          </button>
        </div>
        {bountyOffers.length > 0 && (
          <div className="battle-bounty-list font-mono">
            {bountyOffers.map((offer) => (
              <div key={offer.id}>
                <span>
                  {offer.recipient} · {offer.amount} · {offer.status}
                </span>
                {offer.status === 'offered' && (
                  <button className="secondary" type="button" onClick={() => acceptLocalOffer(offer.id)}>
                    Mark accepted
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </details>
      {!royaleMode && (
      <div className="battle-target-row">
        <span className="font-mono">Chat team</span>
        <button className={selectedTeam === 'alpha' ? 'primary' : 'secondary'} type="button" onClick={() => chooseTeam('alpha')}>
          Alpha
        </button>
        <button className={selectedTeam === 'omega' ? 'primary' : 'secondary'} type="button" onClick={() => chooseTeam('omega')}>
          Omega
        </button>
        <span className="battle-target font-mono">Target host: {TEAM_LABEL[targetTeam]}</span>
      </div>
      )}

      {selectedGift && (() => {
        const owned = inventory[selectedGift.id] ?? 0
        const cost = discountedCost(selectedGift.baseCost)
        return (
          <div className="gift-bar">
            <select
              className="gift-bar-select font-mono"
              value={selectedGift.id}
              size={1}
              onChange={(e) => setSelectedGiftId(e.target.value)}
              aria-label="Choose battle gift"
            >
              <optgroup label="🎬 Video gifts">
                {BATTLE_GIFTS.filter((g) => g.videoSrc).map((g) => (
                  <option key={g.id} value={g.id}>{g.weapon} {g.name} · {discountedCost(g.baseCost)}c</option>
                ))}
              </optgroup>
              <optgroup label="✨ Animated">
                {BATTLE_GIFTS.filter((g) => g.animated && !g.videoSrc).map((g) => (
                  <option key={g.id} value={g.id}>{g.name} · {discountedCost(g.baseCost)}c</option>
                ))}
              </optgroup>
              <optgroup label="⚡ Boost">
                {BATTLE_GIFTS.filter((g) => !g.animated).map((g) => (
                  <option key={g.id} value={g.id}>{g.name} · {discountedCost(g.baseCost)}c</option>
                ))}
              </optgroup>
            </select>
            <div className="gift-bar-row">
              <span className="gift-bar-icon">{selectedGift.weapon}</span>
              <span className="gift-bar-name font-mono">{selectedGift.name}<br /><small>{cost}c · owned {owned}</small></span>
              <div className="gift-bar-actions">
                <button
                  className="primary"
                  type="button"
                  disabled={Boolean(brokenHost) || checkoutBusy === selectedGift.id}
                  onClick={() => void buyWithStripe(selectedGift)}
                >
                  {checkoutBusy === selectedGift.id ? '…' : 'Stripe'}
                </button>
                <button
                  className="secondary"
                  type="button"
                  disabled={wallet < cost || (royaleMode ? (!!royaleWinner || eliminatedTeams.includes(royaleTarget)) : Boolean(brokenHost))}
                  onClick={() => buyDemo(selectedGift)}
                >
                  Demo
                </button>
                <button
                  className="primary"
                  type="button"
                  disabled={owned <= 0 || (royaleMode ? (!!royaleWinner || eliminatedTeams.includes(royaleTarget)) : (!enabled || Boolean(brokenHost)))}
                  onClick={() => fire(selectedGift)}
                >
                  Fire
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {events.length > 0 && (
        <div className="battle-feed font-mono">
          {events.map((event) => (
            <div key={event.id}>{event.text}</div>
          ))}
        </div>
      )}

      <div className="battle-reset-row">
        {canControl && (
          <>
            <button className="battle-reset secondary" type="button" onClick={resetBattle}>
              Reset battle
            </button>
            <button className="battle-reset primary battle-stop-reset-btn" type="button" onClick={stopAndResetAll}>
              STOP · FULL RESET
            </button>
          </>
        )}
      </div>

      {stripeModalInput && (
        <StripeCheckoutModal
          input={stripeModalInput}
          onSuccess={onStripeSuccess}
          onClose={() => setStripeModalInput(null)}
        />
      )}
    </section>
  )
}
