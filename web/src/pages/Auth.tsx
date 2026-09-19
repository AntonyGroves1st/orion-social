import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

import { lazyWithRetry } from '../lib/lazyWithRetry'

const LiveMap3D = lazyWithRetry(() => import('../components/LiveMap3D'))

const previewRooms = [
  { id: 'preview-founder', title: 'Founder live', live_listed: true },
  { id: 'preview-studio', title: 'Studio room', live_listed: true },
  { id: 'preview-orbit', title: 'Orbit lounge', live_listed: true },
]

export default function Auth() {
  const nav = useNavigate()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!supabase) return
    try {
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        if (data.session && invite.trim()) {
          const { error: cErr } = await supabase.rpc('orion_claim_invite', {
            payload: { invite: invite.trim(), display_name: name.trim() },
          })
          if (cErr) console.warn('[claim]', cErr)
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
      }
      nav('/home')
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function afterSignupClaim() {
    if (!invite.trim()) {
      nav('/home')
      return
    }
    if (!supabase) return
    const { error } = await supabase.rpc('orion_claim_invite', {
      payload: { invite: invite.trim(), display_name: name.trim() },
    })
    if (!error) window.location.reload()
  }

  return (
    <div className="auth-portal studio-page">
      <div className="auth-map-pane">
        <React.Suspense
          fallback={
            <section className="live-map-shell" aria-label="Live network map loading">
              <div className="live-map-canvas-wrap live-map-loading font-mono">ORION MAP LOADING</div>
            </section>
          }
        >
          <LiveMap3D
            rooms={previewRooms}
            peopleCount={7}
            currentUserName="You"
            onOpenRoom={() => setMode('login')}
          />
        </React.Suspense>
      </div>
      <div className="auth-stack auth-stack--portal">
        <div className="card elevate" style={{ maxWidth: 420 }}>
          <h2 style={{ marginTop: 0 }}>{mode === 'login' ? 'Sign in' : 'Create account'}</h2>
          <div className="row" style={{ marginBottom: 10 }}>
            <button className={mode === 'login' ? 'primary' : 'secondary'} type="button" onClick={() => setMode('login')}>
              Login
            </button>
            <button className={mode === 'signup' ? 'primary' : 'secondary'} type="button" onClick={() => setMode('signup')}>
              Sign up
            </button>
          </div>
          <form onSubmit={onSubmit} style={{ display: 'grid', gap: 10 }}>
            <label>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Email</span>
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Password</span>
              <input
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
            </label>
            {mode === 'signup' && (
              <>
                <label>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>Invite code</span>
                  <input value={invite} placeholder="ORION-FOUNDER-2026" onChange={(e) => setInvite(e.target.value)} />
                </label>
                <label>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>Display name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </label>
              </>
            )}
            {err && <div style={{ color: '#fca5a5', fontSize: 13 }}>{err}</div>}
            <button className="primary" type="submit">
              {mode === 'login' ? 'Enter' : 'Register'}
            </button>
            {mode === 'signup' && (
              <button className="secondary" type="button" onClick={afterSignupClaim}>
                I confirmed email · claim invite now
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  )
}
