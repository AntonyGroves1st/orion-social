import { useCallback, useEffect, useState } from 'react'
import { loadStripe } from '@stripe/stripe-js'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { createBattleGiftPaymentIntent, type PaymentIntentResponse } from '../lib/battlePayments'

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? '')

const STRIPE_APPEARANCE = {
  theme: 'night' as const,
  variables: {
    colorPrimary: '#00f0ff',
    colorBackground: '#0a1a14',
    colorText: '#e0fff8',
    colorDanger: '#ff4d6a',
    fontFamily: '"Inter", system-ui, sans-serif',
    borderRadius: '8px',
    spacingUnit: '4px',
  },
  rules: {
    '.Input': {
      border: '1px solid rgba(0,240,255,0.25)',
      backgroundColor: 'rgba(0,240,255,0.05)',
    },
    '.Input:focus': {
      border: '1px solid rgba(0,240,255,0.7)',
      boxShadow: '0 0 0 2px rgba(0,240,255,0.15)',
    },
    '.Label': { color: 'rgba(224,255,248,0.7)', fontSize: '11px' },
    '.Tab': { border: '1px solid rgba(0,240,255,0.2)', backgroundColor: 'rgba(0,240,255,0.04)' },
    '.Tab--selected': { border: '1px solid rgba(0,240,255,0.6)', backgroundColor: 'rgba(0,240,255,0.1)' },
  },
}

type CheckoutInput = {
  conversationId: string
  giftId: string
  team: string
  targetTeam: string
  quantity?: number
}

type Props = {
  input: CheckoutInput
  onSuccess: (giftId: string, qty: number) => void
  onClose: () => void
}

function PayForm({ intent, onSuccess, onClose }: { intent: PaymentIntentResponse; onSuccess: () => void; onClose: () => void }) {
  const stripe = useStripe()
  const elements = useElements()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  const handlePay = useCallback(async () => {
    if (!stripe || !elements) return
    setBusy(true)
    setError(null)
    const result = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
    })
    if (result.error) {
      setError(result.error.message ?? 'Payment failed.')
      setBusy(false)
    } else if (result.paymentIntent?.status === 'succeeded') {
      onSuccess()
    } else {
      setError('Payment incomplete. Please try again.')
      setBusy(false)
    }
  }, [stripe, elements, onSuccess])

  const dollars = (intent.amount / 100).toFixed(2)

  return (
    <div className="stripe-modal-form">
      <div className="stripe-modal-gift-row">
        <span className="stripe-modal-gift-symbol">{intent.giftSymbol}</span>
        <div className="stripe-modal-gift-info">
          <strong>{intent.giftName}</strong>
          {intent.quantity > 1 && <span className="stripe-modal-qty">× {intent.quantity}</span>}
        </div>
        <span className="stripe-modal-price">${dollars}</span>
      </div>

      <PaymentElement onReady={() => setReady(true)} options={{ layout: 'tabs' }} />

      {error && <p className="stripe-modal-error">{error}</p>}

      <div className="stripe-modal-actions">
        <button className="stripe-modal-cancel" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="stripe-modal-pay" onClick={handlePay} disabled={busy || !ready}>
          {busy ? 'Processing…' : `Pay $${dollars}`}
        </button>
      </div>

      <p className="stripe-modal-secure">🔒 Secured by Stripe</p>
    </div>
  )
}

export function StripeCheckoutModal({ input, onSuccess, onClose }: Props) {
  const [intent, setIntent] = useState<PaymentIntentResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    setIntent(null)
    setLoadError(null)
    createBattleGiftPaymentIntent(input)
      .then(setIntent)
      .catch((err: Error) => {
        const msg = err.message || 'Could not connect to payments service.'
        const hint = msg.includes('fetch') || msg.includes('network') || msg.includes('reach')
          ? ' — Is the payments server running? Check http://127.0.0.1:8791/health'
          : msg.includes('ROOM_NOT_FOUND') || msg.includes('room')
          ? ' — Open a live room first, then retry.'
          : msg.includes('UNAUTHENTICATED') || msg.includes('session')
          ? ' — Sign out and back in, then retry.'
          : ''
        setLoadError(msg + hint)
      })
  }, [retryCount]) // retryCount triggers re-fetch on retry

  const handleSuccess = useCallback(() => {
    setDone(true)
    setTimeout(() => {
      onSuccess(input.giftId, input.quantity ?? 1)
      onClose()
    }, 1200)
  }, [onSuccess, onClose, input.giftId, input.quantity])

  return (
    <div className="stripe-modal-backdrop" onClick={onClose}>
      <div className="stripe-modal" onClick={(e) => e.stopPropagation()}>
        <div className="stripe-modal-header">
          <span className="stripe-modal-title">Complete Purchase</span>
          <button className="stripe-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {done && (
          <div className="stripe-modal-success">
            <span className="stripe-modal-success-icon">✓</span>
            <strong>Payment successful!</strong>
            <span>Your gift is being sent…</span>
          </div>
        )}

        {!done && loadError && (
          <div className="stripe-modal-load-error">
            <p>{loadError}</p>
            <div className="stripe-modal-actions">
              <button className="stripe-modal-cancel" onClick={onClose}>Close</button>
              <button className="stripe-modal-pay" onClick={() => setRetryCount((n) => n + 1)}>
                Retry
              </button>
            </div>
          </div>
        )}

        {!done && !loadError && !intent && (
          <div className="stripe-modal-loading">
            <span className="stripe-modal-spinner" />
            <span>Loading payment…</span>
          </div>
        )}

        {!done && !loadError && intent && (
          <Elements
            stripe={stripePromise}
            options={{ clientSecret: intent.clientSecret, appearance: STRIPE_APPEARANCE }}
          >
            <PayForm intent={intent} onSuccess={handleSuccess} onClose={onClose} />
          </Elements>
        )}
      </div>
    </div>
  )
}
