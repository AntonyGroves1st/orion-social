import { effectiveSupabaseUrl, supabase } from './supabase'

type CheckoutInput = {
  conversationId: string
  giftId: string
  team: string
  targetTeam: string
  quantity?: number
}

type CheckoutResponse = {
  url: string
}

export type PaymentIntentResponse = {
  clientSecret: string
  amount: number
  currency: string
  giftName: string
  giftSymbol: string
  quantity: number
  split: { grossCents: number; creatorCents: number; networkDesignerCents: number }
}

type CheckoutErrorResponse = {
  error?: {
    code?: string
    message?: string
  }
}

type PaymentsHealth = {
  ok?: boolean
  service?: string
  supabaseHost?: string
}

const PAYMENTS_URL = (import.meta.env.VITE_ORION_PAYMENTS_URL || '/payments').replace(/\/$/, '')

async function parseApiJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  const trimmed = text.trim()
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
    throw new Error(
      'Payments service returned a web page instead of JSON. Start Orion Payments on port 8791 (services/orion-payments) or use Demo for local testing without Stripe.',
    )
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(trimmed.slice(0, 120) || 'Invalid response from payments service.')
  }
}

function hostFromUrl(value: string): string {
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return ''
  }
}

async function assertPaymentsSupabaseMatches(baseUrl: string) {
  const appHost = hostFromUrl(effectiveSupabaseUrl)
  if (!appHost) return
  const response = await fetch(`${baseUrl}/health`, { method: 'GET' })
  if (!response.ok) return
  const health = await parseApiJson<PaymentsHealth | null>(response).catch(() => null)
  const paymentsHost = (health?.supabaseHost ?? '').toLowerCase()
  if (!paymentsHost || paymentsHost === appHost) return
  throw new Error(
    `Stripe is connected to Supabase ${paymentsHost}, but this browser is signed into ${appHost}. Update services/orion-payments/.env to the same SUPABASE_URL, restart Start-Orion-Social.bat, then sign in again.`,
  )
}

export async function startBattleGiftCheckout(input: CheckoutInput): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured.')

  let checkoutBase = PAYMENTS_URL
  try {
    await assertPaymentsSupabaseMatches(checkoutBase)
  } catch (error) {
    if (checkoutBase === '/payments') throw error
    checkoutBase = '/payments'
    await assertPaymentsSupabaseMatches(checkoutBase)
  }

  // Try to refresh; if that fails (network blip, token timing) fall back to the
  // existing cached session rather than immediately signing the user out.
  const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession()
  const session =
    refreshed.session ??
    (await supabase.auth.getSession()).data.session
  const token = session?.access_token
  if (!token) {
    // Genuinely no session — tell the user but do NOT force a sign-out here.
    // They can sign out and back in themselves.
    throw new Error(
      refreshError
        ? `Session could not be refreshed (${refreshError.message}). Please sign out and sign in again, then retry.`
        : 'No active session found. Sign in and retry.',
    )
  }

  const currentUrl = new URL(window.location.href)
  currentUrl.searchParams.set('checkout', 'success')
  currentUrl.searchParams.set('battle_gift', input.giftId)
  currentUrl.searchParams.set('battle_qty', String(input.quantity ?? 1))

  const cancelUrl = new URL(window.location.href)
  cancelUrl.searchParams.set('checkout', 'cancelled')

  const checkoutBody = JSON.stringify({
    ...input,
    quantity: input.quantity ?? 1,
    successUrl: currentUrl.toString(),
    cancelUrl: cancelUrl.toString(),
  })
  const requestCheckout = (baseUrl: string) =>
    fetch(`${baseUrl}/checkout/battle-gift`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: checkoutBody,
    })

  let response: Response
  try {
    response = await requestCheckout(checkoutBase)
  } catch (error) {
    if (checkoutBase !== '/payments') {
      response = await requestCheckout('/payments')
    } else {
      throw error
    }
  }

  if (!response.ok) {
    const payload = await parseApiJson<CheckoutErrorResponse | null>(response).catch(() => null)
    const code = payload?.error?.code ? `${payload.error.code}: ` : ''
    const message = payload?.error?.message ?? 'Could not start Stripe checkout.'
    if (payload?.error?.code === 'UNAUTHENTICATED') {
      // Token was rejected server-side — prompt re-login without force sign-out.
      throw new Error(`${code}${message} Your session token was rejected — sign out and sign back in, then retry Stripe.`)
    }
    throw new Error(`${code}${message}`)
  }

  const payload = await parseApiJson<CheckoutResponse>(response)
  window.location.assign(payload.url)
}

export async function createBattleGiftPaymentIntent(input: CheckoutInput): Promise<PaymentIntentResponse> {
  if (!supabase) throw new Error('Supabase is not configured.')

  let base = PAYMENTS_URL
  try {
    await assertPaymentsSupabaseMatches(base)
  } catch (error) {
    if (base === '/payments') throw error
    base = '/payments'
    await assertPaymentsSupabaseMatches(base)
  }

  const { data: refreshed } = await supabase.auth.refreshSession()
  const session =
    refreshed.session ??
    (await supabase.auth.getSession()).data.session
  const token = session?.access_token
  if (!token) throw new Error('No active session. Sign in and retry.')

  const doRequest = (baseUrl: string) =>
    fetch(`${baseUrl}/checkout/payment-intent`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...input, quantity: input.quantity ?? 1 }),
    })

  let response: Response
  try {
    response = await doRequest(base)
  } catch {
    if (base !== '/payments') {
      response = await doRequest('/payments')
    } else {
      throw new Error('Could not reach payments service.')
    }
  }

  if (!response.ok) {
    const payload = await parseApiJson<CheckoutErrorResponse | null>(response).catch(() => null)
    const code = payload?.error?.code ? `${payload.error.code}: ` : ''
    const message = payload?.error?.message ?? 'Could not create payment.'
    throw new Error(`${code}${message}`)
  }

  return parseApiJson<PaymentIntentResponse>(response)
}
