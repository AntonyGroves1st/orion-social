import React, { useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import type { Profile } from './lib/supabase'
import {
  clearDevSupabasePaste,
  devSupabasePasteOverridesEnv,
  effectiveSupabaseUrl,
  normalizeSupabaseProjectUrl,
  persistDevSupabasePaste,
  supabase,
  SUPABASE_DEV_SESSION_KEY,
  supabaseInitError,
  viteSupabaseEnv,
} from './lib/supabase'
import Lobby from './pages/Lobby'
import Auth from './pages/Auth'
import Chat from './pages/Chat'
import VideoRoom from './pages/VideoRoom'
import ProfilePage from './pages/Profile'
import Reels from './pages/Reels'
import Support from './pages/Support'
import League from './pages/League'
import OrionKeyGate from './components/OrionKeyGate'
import { clearOrionKeyVerified, readOrionKeyVerified } from './crypto/orionLoginKey'

type ThemeMode = 'dark' | 'light'

const THEME_STORAGE_KEY = 'orion_theme_mode_v1'

function readThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'dark'
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function validSupabaseProjectUrl(url: string) {
  if (/xxxxx|YOUR_REF|example\.com/i.test(url) || url.includes('…')) return false
  if (!url.startsWith('http')) return false
  if (/^https:\/\/.+\.supabase\.co\/?$/i.test(url)) return true
  if (/^http:\/\/(127\.0\.0\.1|localhost):\d+$/i.test(url)) return true
  return false
}

/** New Supabase publishable keys (`sb_publishable_…`) are shorter than legacy JWT anon keys (`eyJ…`). */
function anonKeyLooksValid(anonNorm: string) {
  if (!anonNorm || anonNorm.includes('…')) return false
  if (anonNorm.startsWith('sb_publishable_')) return anonNorm.length >= 30
  if (anonNorm.startsWith('eyJ')) return anonNorm.length >= 80
  return anonNorm.length >= 80
}

function profileHasOrionKeyColumns(profile: Profile | null | undefined) {
  if (!profile) return false
  return (
    Object.prototype.hasOwnProperty.call(profile, 'orion_login_pubkey_jwk') ||
    Object.prototype.hasOwnProperty.call(profile, 'orion_key_required') ||
    Object.prototype.hasOwnProperty.call(profile, 'orion_key_enrolled_at')
  )
}

function DevSupabasePasteForm() {
  let raw: string | null = null
  try {
    raw =
      (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SUPABASE_DEV_SESSION_KEY) : null) ??
      (typeof localStorage !== 'undefined' ? localStorage.getItem(SUPABASE_DEV_SESSION_KEY) : null)
  } catch {
    raw = null
  }
  return (
    <div style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
      <h3 style={{ marginTop: 0, fontSize: 16 }}>Dev shortcut (session only)</h3>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>
        Paste values from Supabase → <strong>Project Settings → API</strong>. They are saved in your browser (
        <code>sessionStorage</code> + <code>localStorage</code>), not in <code>.env</code>. Omit this block from production
        builds.
      </p>
      <p style={{ fontSize: 13, color: '#fbbf24', marginBottom: 0 }}>
        Stay on one host: don’t flip between <code>localhost:5732</code> and <code>127.0.0.1:5732</code> — they keep
        separate storage. After clicking save, confirm the page truly reloads.
      </p>
      <form
        style={{ display: 'grid', gap: 10, maxWidth: 520 }}
        onSubmit={(e) => {
          e.preventDefault()
          const fd = new FormData(e.currentTarget)
          let url = normalizeSupabaseProjectUrl(String(fd.get('url') ?? '').trim())
          const anon = String(fd.get('anon') ?? '').trim()
          if (!url || !anon) return
          if (!validSupabaseProjectUrl(url)) {
            alert(
              'Use your real Project URL: https://<ref>.supabase.co (hosted) OR http://127.0.0.1:<port> (local Supabase CLI). No placeholder text.',
            )
            return
          }
          const anonNorm = anon.replace(/\s+/g, '')
          if (!anonKeyLooksValid(anonNorm)) {
            alert(
              'Paste the full public client key from Supabase API: legacy long JWT (eyJ…) or new sb_publishable_… key.',
            )
            return
          }
          persistDevSupabasePaste(url, anonNorm)
          window.location.reload()
        }}
      >
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--muted)', marginBottom: 4 }}>Project URL</div>
          <input
            name="url"
            type="text"
            required
            placeholder="https://YOUR_REF.supabase.co — not the …/rest/v1 URL"
            autoComplete="off"
          />
        </label>
        <label style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--muted)', marginBottom: 4 }}>anon / publishable key</div>
          <input
            name="anon"
            type="password"
            required
            placeholder="eyJ… (JWT) or sb_publishable_…"
            autoComplete="off"
          />
        </label>
        <div className="row">
          <button className="primary" type="submit">
            Save in this tab & reload
          </button>
          {raw && (
            <button
              className="secondary"
              type="button"
              onClick={() => {
                clearDevSupabasePaste()
                window.location.reload()
              }}
            >
              Clear saved creds
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

function Shell({ children, theme = 'dark' }: { children: React.ReactNode; theme?: ThemeMode }) {
  const location = useLocation()
  const isRoomRoute = location.pathname.startsWith('/call/')
  return (
    <div className={`shell-wrap theme-matrix theme-${theme} studio-app ${isRoomRoute ? 'shell-wrap--room' : ''}`}>
      <div className="matrix-grid-fade" aria-hidden />
      {!isRoomRoute && (
        <header className="brand-bar">
          <div className="brand-mark">
            <span className="brand-icon" aria-hidden>
              <img src="/app-icon.svg" alt="" />
            </span>
            <div>
              <div className="brand-kicker font-mono">ORION MATRIX / v0</div>
              <div className="brand-title">Orion Social</div>
              <div className="brand-tagline">
                invite-only ◆ DMs ◆ live mesh ≤7 ◆ WebRTC ◆ optional Orion seal
              </div>
            </div>
          </div>
          <div className="brand-chips">
            <span className="chip chip--muted font-mono">CAP ~1000</span>
            <span className="chip chip--pulse font-mono">BRIDGE :8790</span>
            <span className="chip chip--muted font-mono">NO CLOUD RECORD</span>
          </div>
        </header>
      )}

      <div className="shell">
        {!isRoomRoute && (
          <div className="banner matrix-banner font-mono">
            <span className="matrix-banner-prompt">{'>'}</span> Orion seal/decrypt → bridge{' '}
            <code>localhost:8790</code> · UI proxies <code>/orion/v1/…</code> via Vite{' '}
            <code>npm run dev</code>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined)
  const [orionKeyVerified, setOrionKeyVerified] = useState(false)
  const [loading, setLoading] = useState(true)
  const [theme, setTheme] = useState<ThemeMode>(() => readThemeMode())

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      /* ignore */
    }
  }, [theme])

  useEffect(() => {
    if (!supabase) return
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      setSession(data.session ?? null)
      setOrionKeyVerified(data.session?.user ? readOrionKeyVerified(data.session.user.id) : false)
    })()
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s)
      // On token refresh keep the existing verified state — only reset on real sign-in/out
      if (_e !== 'TOKEN_REFRESHED') {
        setProfile(undefined)
        setLoading(true)
        setOrionKeyVerified(_e === 'SIGNED_OUT' || !s?.user ? false : readOrionKeyVerified(s.user.id))
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      return
    }
    if (!session?.user) {
      setProfile(null)
      setLoading(false)
      return
    }
    ;(async () => {
      const uid = session.user.id
      const { data } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle()
      setProfile(data as Profile | null)
      setLoading(false)
    })()
  }, [session])

  const nav = useNavigate()
  const location = useLocation()
  const isRoomRoute = location.pathname.startsWith('/call/')
  const navPillClass = (path: string, hash = '') => {
    const active = location.pathname === path && (!hash || location.hash === hash)
    return `nav-pill ${active ? 'nav-pill--active' : ''}`
  }

  if (supabaseInitError) {
    return (
      <Shell theme={theme}>
        <div className="card elevate">
          <h2 style={{ marginTop: 0 }}>Could not init Supabase</h2>
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>
            The client crashed while starting. Usually this means a typo in the URL or key in{' '}
            <code>web/.env</code>.
          </p>
          <pre className="err-block">{supabaseInitError}</pre>
        </div>
      </Shell>
    )
  }

  if (!supabase) {
    const hasEnvFileHints =
      viteSupabaseEnv.urlRaw !== undefined || viteSupabaseEnv.anonRaw !== undefined
    const urlBlank = !(`${viteSupabaseEnv.urlRaw ?? ''}`.trim())
    const anonBlank = !(`${viteSupabaseEnv.anonRaw ?? ''}`.trim())
    return (
      <Shell theme={theme}>
        <div className="card elevate">
          <h2 style={{ marginTop: 0 }}>Misconfigured</h2>
          <p style={{ marginBottom: 12 }}>
            Supabase needs <strong>non-empty</strong> values in the <code>web</code> app folder:
          </p>
          <ul style={{ marginTop: 0, paddingLeft: 20, color: 'var(--muted)', fontSize: 14 }}>
            <li>
              Edit <code>web/.env</code> in the folder that contains <code>vite.config.ts</code> — not the repo root.
            </li>
            <li>
              Paste <strong>Project URL</strong> into <code>VITE_SUPABASE_URL</code> (starts with{' '}
              <code style={{ color: 'var(--accent)' }}>https://</code> … <code>.supabase.co</code> — not the longer API
              URL ending in <code>/rest/v1</code>). Paste the <code>anon public</code> JWT into{' '}
              <code>VITE_SUPABASE_ANON_KEY</code>.
            </li>
            <li>
              Lines must look like <code>KEY=value</code> — <strong>no spaces around </strong>
              <code>=</code> — usually <strong>no quotes</strong> around the JWT.
            </li>
            <li>
              <strong>Restart Vite</strong> after saving (Ctrl+C → <code>npm run dev</code>). Hot reload alone does{' '}
              <em>not</em> reload env vars.
            </li>
          </ul>
          {hasEnvFileHints && (urlBlank || anonBlank) && (
            <p style={{ color: '#fbbf24', fontSize: 14, marginBottom: 0 }}>
              Vite can see those keys but the values after <code>=</code> are still blank. Fill both lines with your real Supabase URL and anon key — not the commented examples — then restart the dev server.
            </p>
          )}
          {import.meta.env.DEV && <DevSupabasePasteForm />}
        </div>
      </Shell>
    )
  }

  const client = supabase

  if (loading && session?.user && profile === undefined) {
    return (
      <Shell theme={theme}>
        <p style={{ color: 'var(--muted)' }}>Loading…</p>
      </Shell>
    )
  }

  const logout = async () => {
    clearOrionKeyVerified(session?.user.id)
    await client.auth.signOut()
    setProfile(null)
    setOrionKeyVerified(false)
    nav('/auth')
  }
  const orionKeyRequired = Boolean(
    session && profile && profileHasOrionKeyColumns(profile) && profile.orion_key_required !== false,
  )
  const canEnterApp = Boolean(session && profile && (!orionKeyRequired || orionKeyVerified))
  const activeProfile = canEnterApp && profile ? profile : null
  const showAppNav = !isRoomRoute && !!activeProfile

  if (session && profile && orionKeyRequired && !orionKeyVerified) {
    return (
      <Shell theme={theme}>
        <OrionKeyGate
          session={session}
          profile={profile}
          onVerified={(updatedProfile) => {
            setProfile(updatedProfile)
            setOrionKeyVerified(true)
            nav('/home', { replace: true })
          }}
          onSignOut={logout}
        />
      </Shell>
    )
  }

  return (
    <Shell theme={theme}>
      {showAppNav && (
        <nav className="top-nav" aria-label="Primary app navigation">
          <div className="top-nav-links">
            <Link to="/home" className={navPillClass('/home')}>
              Live
            </Link>
            <Link to="/profile" className={navPillClass('/profile')}>
              Profile
            </Link>
            <Link to="/reels" className={navPillClass('/reels')}>
              Reels
            </Link>
            <Link to="/league" className={navPillClass('/league')}>
              League
            </Link>
            <Link to="/support" className={navPillClass('/support')}>
              Help
            </Link>
            {profile && session && <span className="nav-muted">@{profile.display_name ?? session.user.email}</span>}
          </div>
          <div className="top-nav-actions">
            <button className="secondary" type="button" onClick={() => setTheme((next) => (next === 'dark' ? 'light' : 'dark'))}>
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
            <button className="secondary" type="button" onClick={logout}>
              Sign out
            </button>
          </div>
        </nav>
      )}

      <Routes location={location} key={location.pathname}>
        <Route path="/auth" element={canEnterApp ? <Navigate to="/home" replace /> : <Auth />} />
        <Route
          path="/home"
          element={
            activeProfile ? (
              <Lobby profile={activeProfile} />
            ) : session && profile === null ? (
              <CompleteInvite />
            ) : session ? (
              <p style={{ color: 'var(--muted)' }}>Loading profile…</p>
            ) : (
              <Navigate to="/auth" replace />
            )
          }
        />
        <Route
          path="/chat/:conversationId?"
          element={activeProfile ? <Chat me={activeProfile} /> : <Navigate to="/auth" replace />}
        />
        <Route
          path="/profile"
          element={activeProfile ? <ProfilePage me={activeProfile} onProfileUpdated={setProfile} /> : <Navigate to="/auth" replace />}
        />
        <Route
          path="/call/:conversationId"
          element={
            activeProfile ? (
              <VideoRoom me={activeProfile} />
            ) : (
              <Navigate to="/auth" replace />
            )
          }
        />
        <Route
          path="/reels"
          element={activeProfile ? <Reels me={activeProfile} variant="discover" /> : <Navigate to="/auth" replace />}
        />
        <Route
          path="/support"
          element={activeProfile ? <Support me={activeProfile} /> : <Navigate to="/auth" replace />}
        />
        <Route
          path="/league"
          element={activeProfile ? <League /> : <Navigate to="/auth" replace />}
        />
        <Route path="/" element={<Navigate to={session ? '/home' : '/auth'} replace />} />
      </Routes>
    </Shell>
  )
}

function CompleteInvite() {
  const [invite, setInvite] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const nav = useNavigate()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!supabase) return
    const { error } = await supabase.rpc('orion_claim_invite', {
      payload: { invite: invite.trim(), display_name: name.trim() },
    })
    if (error) {
      setErr(error.message)
      return
    }
    nav('/home', { replace: true })
    window.location.reload()
  }

  return (
    <div className="auth-stack studio-page">
      <div className="card elevate" style={{ maxWidth: 420 }}>
        <h2 style={{ marginTop: 0 }}>Complete membership</h2>
      <p style={{ fontSize: 13, color: 'var(--muted)' }}>
        You are signed in but not in the capped community yet. Enter your invite — default seed is{' '}
        <code style={{ color: 'var(--accent)' }}>ORION-FOUNDER-2026</code> until you mint new codes in SQL.
      </p>
      <form onSubmit={submit} style={{ display: 'grid', gap: 10 }}>
        <label>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Invite</div>
          <input value={invite} onChange={(e) => setInvite(e.target.value)} required />
        </label>
        <label>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Display name</div>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {err && <div style={{ color: '#fca5a5', fontSize: 13 }}>{err}</div>}
        {err && (/schema cache/i.test(err) || /orion_claim_invite|claim_invite/i.test(err)) && (
          <div className="err-block" role="note" style={{ fontSize: 12, lineHeight: 1.5 }}>
            <strong>Backend fix:</strong> the Supabase REST API doesn’t see <code>orion_claim_invite</code> on{' '}
            <em>this</em> database yet.
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              <li>
                <strong>This tab calls:</strong>{' '}
                <code style={{ wordBreak: 'break-all' }}>{effectiveSupabaseUrl || '—'}</code>
                {devSupabasePasteOverridesEnv ? (
                  <>
                    {' '}
                    (saved <strong>Misconfigured / dev paste</strong> overrides <code>web/.env</code> —{' '}
                    <button
                      type="button"
                      className="secondary"
                      style={{ fontSize: 12, padding: '4px 10px', verticalAlign: 'middle' }}
                      onClick={() => {
                        clearDevSupabasePaste()
                        window.location.reload()
                      }}
                    >
                      Clear saved creds &amp; reload
                    </button>
                    )
                  </>
                ) : null}
              </li>
              <li>Open the Supabase project that matches that hostname (same ref as in <code>web/.env</code>).</li>
              <li>
                <strong>SQL → New query</strong> → paste and run the whole file{' '}
                <code style={{ wordBreak: 'break-all' }}>supabase/RUN_ONCE_IN_SQL_EDITOR.sql</code>, or at least{' '}
                <code style={{ wordBreak: 'break-all' }}>supabase/FIX_CLAIM_INVITE_RPC_ONLY.sql</code> if tables already exist. To{' '}
                <em>confirm</em>, run <code>supabase/VERIFY_CLAIM_INVITE_RPC.sql</code> (expects one row:{' '}
                <code>orion_claim_invite</code> · <code>payload jsonb</code>).
              </li>
              <li>
                Dashboard → <strong>Settings → API → Data API</strong> → ensure schema <code>public</code> is exposed.
              </li>
              <li>
                Wait a minute or retry — the SQL ends with{' '}
                <code>{`NOTIFY pgrst, 'reload schema'`}</code> to refresh the API cache.
              </li>
            </ul>
          </div>
        )}
        <button className="primary" type="submit">
          Unlock profile
        </button>
      </form>
      </div>
    </div>
  )
}
