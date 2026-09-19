import { useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  clearOrionLoginIdentity,
  markOrionKeyVerified,
  verifyOrionLoginKey,
} from '../crypto/orionLoginKey'
import type { Profile } from '../lib/supabase'
import { supabase } from '../lib/supabase'

type Props = {
  session: Session
  profile: Profile
  onVerified: (profile: Profile) => void
  onSignOut: () => Promise<void>
}

function isMissingColumn(message: string) {
  return /orion_login_pubkey_jwk|schema cache|column .* does not exist/i.test(message)
}

export default function OrionKeyGate({ session, profile, onVerified, onSignOut }: Props) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [recovering, setRecovering] = useState(false)
  const enrolled = Boolean(profile.orion_login_pubkey_jwk)

  async function unlock() {
    if (!supabase) return
    setBusy(true)
    setErr(null)
    try {
      const result = await verifyOrionLoginKey(session.user.id, profile.orion_login_pubkey_jwk)
      if (!result.verified) {
        throw new Error('This browser does not hold the Orion Key for this account.')
      }

      let nextProfile = profile
      if (!profile.orion_login_pubkey_jwk) {
        const { data, error } = await supabase
          .from('profiles')
          .update({
            orion_login_pubkey_jwk: result.publicJwk,
            orion_key_required: true,
            orion_key_enrolled_at: new Date().toISOString(),
          })
          .eq('id', session.user.id)
          .select('*')
          .single()

        if (error) throw error
        nextProfile = data as Profile
      }

      markOrionKeyVerified(session.user.id)
      onVerified(nextProfile)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isMissingColumn(message)) {
        setErr(
          'Orion Key login SQL is not installed yet. Run npm run db:orion-login-key, then refresh and unlock again.',
        )
      } else {
        setErr(message)
      }
    } finally {
      setBusy(false)
    }
  }

  async function replaceKey() {
    if (!supabase) return
    setBusy(true)
    setErr(null)
    clearOrionLoginIdentity(session.user.id)
    try {
      const result = await verifyOrionLoginKey(session.user.id)
      if (!result.verified) throw new Error('Could not create a replacement Orion Key.')
      const { data, error } = await supabase
        .from('profiles')
        .update({
          orion_login_pubkey_jwk: result.publicJwk,
          orion_key_required: true,
          orion_key_enrolled_at: new Date().toISOString(),
        })
        .eq('id', session.user.id)
        .select('*')
        .single()

      if (error) throw error
      markOrionKeyVerified(session.user.id)
      setRecovering(false)
      onVerified(data as Profile)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setErr(isMissingColumn(message) ? 'Orion Key login SQL is not installed yet. Run npm run db:orion-login-key.' : message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="orion-key-lock auth-stack">
      <section className="card elevate orion-key-card" aria-label="Orion Key login protection">
        <div className="section-kicker font-mono">ORION KEY PROTECTION</div>
        <h2>{enrolled ? 'Unlock Orion Social' : 'Create your Orion Key'}</h2>
        <p>
          Supabase confirmed your account. Orion Key now proves this trusted browser is holding your private login key
          before the live network opens.
        </p>
        <div className="orion-key-status font-mono">
          <span>Account</span>
          <strong>{profile.display_name || session.user.email}</strong>
          <span>Device key</span>
          <strong>{enrolled ? 'Required' : 'Ready to enroll'}</strong>
        </div>
        {err && <div className="err-block orion-key-error">{err}</div>}
        <div className="orion-key-actions">
          <button className="primary" type="button" disabled={busy} onClick={() => void unlock()}>
            {busy ? 'Checking key...' : enrolled ? 'Unlock with Orion Key' : 'Create Orion Key'}
          </button>
          {enrolled && (
            <button className="secondary" type="button" onClick={() => setRecovering((value) => !value)}>
              Recovery
            </button>
          )}
          <button className="secondary" type="button" onClick={() => void onSignOut()}>
            Sign out
          </button>
        </div>
        {recovering && (
          <div className="orion-key-recovery">
            <strong>Lost this device key?</strong>
            <p>
              For local testing you can replace the browser key. For live members, keep this behind admin approval or a
              passkey recovery step before enabling public recovery.
            </p>
            <button className="secondary" type="button" disabled={busy} onClick={() => void replaceKey()}>
              Replace local key
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
