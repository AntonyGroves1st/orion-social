import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { BATTLE_GIFTS, discountedCost, findBattleGift, splitBattleRevenue } from './gift-catalog.mjs'

const port = Number(process.env.PORT || 8791)
const publicOrigin = process.env.PUBLIC_ORIGIN || 'http://localhost:5732'
const corsOrigins = new Set([publicOrigin, 'http://localhost:5732', 'http://127.0.0.1:5732'])
const coinCents = Math.max(1, Number(process.env.ORION_COIN_CENTS || 100))
const useDestinationCharges = process.env.STRIPE_CONNECT_DESTINATION_CHARGES !== 'false'

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY']
const missing = required.filter((key) => !process.env[key])
if (missing.length) {
  throw new Error(`Missing required env: ${missing.join(', ')}`)
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const app = express()

function jsonError(response, status, code, message) {
  return response.status(status).json({ error: { code, message } })
}

function safeString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function assertUrl(value, fallback) {
  const candidate = safeString(value) || fallback
  const url = new URL(candidate)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL must be http or https')
  return url.toString()
}

function hostFromUrl(value) {
  try {
    return new URL(value).host
  } catch {
    return ''
  }
}

async function requireUser(request, response) {
  const raw = request.headers.authorization || ''
  const token = raw.startsWith('Bearer ') ? raw.slice('Bearer '.length) : ''
  if (!token) {
    jsonError(response, 401, 'UNAUTHENTICATED', 'Missing bearer token.')
    return null
  }

  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) {
    jsonError(response, 401, 'UNAUTHENTICATED', 'Invalid Supabase session.')
    return null
  }
  return data.user
}

app.post('/webhook', express.raw({ type: 'application/json' }), async (request, response) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!webhookSecret) return jsonError(response, 500, 'CONFIG_ERROR', 'STRIPE_WEBHOOK_SECRET is not configured.')

  const signature = request.headers['stripe-signature']
  let event
  try {
    event = stripe.webhooks.constructEvent(request.body, signature, webhookSecret)
  } catch (error) {
    return response.status(400).send(`Webhook Error: ${error instanceof Error ? error.message : 'Invalid signature'}`)
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const metadata = session.metadata || {}
    if (metadata.kind === 'battle_gift') {
      const existing = await supabase
        .from('battle_gift_purchases')
        .select('id')
        .eq('provider_payment_id', session.id)
        .maybeSingle()

      if (!existing.data?.id) {
        const grossCents = Number(session.amount_total || metadata.grossCents || 0)
        const { error } = await supabase.rpc('record_battle_gift_purchase', {
          p_conversation_id: metadata.conversationId,
          p_buyer_id: metadata.buyerId,
          p_creator_id: metadata.creatorId,
          p_gift_id: metadata.giftId,
          p_quantity: Number(metadata.quantity || 1),
          p_gross_cents: grossCents,
          p_currency: session.currency || metadata.currency || 'usd',
          p_platform_fee_cents: 0,
          p_provider: 'stripe_checkout',
          p_provider_payment_id: session.id,
          p_status: 'paid',
          p_metadata: {
            team: metadata.team,
            targetTeam: metadata.targetTeam,
            checkoutSessionId: session.id,
            paymentIntent: session.payment_intent,
            stripeMode: session.mode,
          },
        })
        if (error) {
          console.error('[stripe webhook] ledger insert failed', error)
          return jsonError(response, 500, 'LEDGER_ERROR', 'Could not record battle gift purchase.')
        }
      }
    }
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object
    const metadata = intent.metadata || {}
    if (metadata.kind === 'battle_gift') {
      const existing = await supabase
        .from('battle_gift_purchases')
        .select('id')
        .eq('provider_payment_id', intent.id)
        .maybeSingle()

      if (!existing.data?.id) {
        const grossCents = Number(intent.amount || metadata.grossCents || 0)
        const { error } = await supabase.rpc('record_battle_gift_purchase', {
          p_conversation_id: metadata.conversationId,
          p_buyer_id: metadata.buyerId,
          p_creator_id: metadata.creatorId,
          p_gift_id: metadata.giftId,
          p_quantity: Number(metadata.quantity || 1),
          p_gross_cents: grossCents,
          p_currency: intent.currency || 'usd',
          p_platform_fee_cents: 0,
          p_provider: 'stripe_elements',
          p_provider_payment_id: intent.id,
          p_status: 'paid',
          p_metadata: {
            team: metadata.team,
            targetTeam: metadata.targetTeam,
            paymentIntent: intent.id,
          },
        })
        if (error) console.error('[stripe webhook] payment_intent ledger failed', error)
      }
    }
  }

  return response.json({ received: true })
})

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || corsOrigins.has(origin)) return callback(null, true)
      return callback(new Error(`Origin ${origin} is not allowed by Orion Payments CORS.`))
    },
    credentials: false,
  }),
)
app.use(express.json())

app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    service: 'orion-payments',
    publicOrigin,
    supabaseHost: hostFromUrl(process.env.SUPABASE_URL),
  })
})

app.get('/catalog/battle-gifts', (_request, response) => {
  response.json({ data: { gifts: BATTLE_GIFTS } })
})

app.post('/checkout/battle-gift', async (request, response) => {
  const user = await requireUser(request, response)
  if (!user) return

  const conversationId = safeString(request.body?.conversationId)
  const giftId = safeString(request.body?.giftId)
  const team = safeString(request.body?.team)
  const targetTeam = safeString(request.body?.targetTeam)
  const quantity = Math.max(1, Math.min(99, Number(request.body?.quantity || 1)))
  const gift = findBattleGift(giftId)

  if (!conversationId || !gift) return jsonError(response, 422, 'VALIDATION_ERROR', 'Invalid conversation or battle gift.')

  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select('id,title,kind,creator_id,live_listed')
    .eq('id', conversationId)
    .maybeSingle()
  if (convError || !conversation || conversation.kind !== 'live') {
    return jsonError(response, 404, 'ROOM_NOT_FOUND', 'Live room not found.')
  }
  if (!conversation.creator_id) return jsonError(response, 409, 'ROOM_HAS_NO_CREATOR', 'Run db:battle-split before taking payments.')

  const { data: creator } = await supabase
    .from('profiles')
    .select('id,display_name,stripe_account_id')
    .eq('id', conversation.creator_id)
    .maybeSingle()

  const unitCoins = discountedCost(gift.baseCost)
  const unitAmount = unitCoins * coinCents
  const grossCents = unitAmount * quantity
  const split = splitBattleRevenue(grossCents)
  const successUrl = assertUrl(
    request.body?.successUrl,
    `${publicOrigin}/call/${conversationId}?checkout=success&battle_gift=${gift.id}`,
  )
  const cancelUrl = assertUrl(request.body?.cancelUrl, `${publicOrigin}/call/${conversationId}?checkout=cancelled`)

  const metadata = {
    kind: 'battle_gift',
    conversationId,
    buyerId: user.id,
    creatorId: conversation.creator_id,
    giftId: gift.id,
    giftName: gift.name,
    quantity: String(quantity),
    team,
    targetTeam,
    grossCents: String(grossCents),
    creatorCents: String(split.creatorCents),
    networkDesignerCents: String(split.networkDesignerCents),
  }

  const sessionInput = {
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: unitAmount,
          product_data: {
            name: `Orion Battle Gift: ${gift.name}`,
            description: gift.description,
            metadata: {
              giftId: gift.id,
              animated: String(gift.animated),
            },
          },
        },
        quantity,
      },
    ],
    client_reference_id: user.id,
    metadata,
    payment_intent_data: {
      metadata,
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  }

  if (useDestinationCharges && creator?.stripe_account_id) {
    sessionInput.payment_intent_data.application_fee_amount = split.networkDesignerCents
    sessionInput.payment_intent_data.transfer_data = {
      destination: creator.stripe_account_id,
    }
  }

  let checkout
  try {
    checkout = await stripe.checkout.sessions.create(sessionInput)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Stripe checkout failed.'
    console.error('[orion-payments] checkout failed', error)
    return jsonError(response, 500, 'STRIPE_ERROR', message)
  }
  if (!checkout.url) return jsonError(response, 500, 'STRIPE_ERROR', 'Stripe did not return a checkout URL.')

  response.json({
    url: checkout.url,
    split: {
      grossCents,
      creatorCents: split.creatorCents,
      networkDesignerCents: split.networkDesignerCents,
      destinationCharge: Boolean(creator?.stripe_account_id && useDestinationCharges),
    },
  })
})

app.post('/checkout/payment-intent', async (request, response) => {
  const user = await requireUser(request, response)
  if (!user) return

  const conversationId = safeString(request.body?.conversationId)
  const giftId = safeString(request.body?.giftId)
  const team = safeString(request.body?.team)
  const targetTeam = safeString(request.body?.targetTeam)
  const quantity = Math.max(1, Math.min(99, Number(request.body?.quantity || 1)))
  const gift = findBattleGift(giftId)

  if (!conversationId || !gift) return jsonError(response, 422, 'VALIDATION_ERROR', 'Invalid conversation or battle gift.')

  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select('id,title,kind,creator_id,live_listed')
    .eq('id', conversationId)
    .maybeSingle()
  if (convError || !conversation || conversation.kind !== 'live') {
    return jsonError(response, 404, 'ROOM_NOT_FOUND', 'Live room not found.')
  }
  if (!conversation.creator_id) return jsonError(response, 409, 'ROOM_HAS_NO_CREATOR', 'Run db:battle-split before taking payments.')

  const { data: creator } = await supabase
    .from('profiles')
    .select('id,display_name,stripe_account_id')
    .eq('id', conversation.creator_id)
    .maybeSingle()

  const unitCoins = discountedCost(gift.baseCost)
  const unitAmount = unitCoins * coinCents
  const grossCents = unitAmount * quantity
  const split = splitBattleRevenue(grossCents)

  const metadata = {
    kind: 'battle_gift',
    conversationId,
    buyerId: user.id,
    creatorId: conversation.creator_id,
    giftId: gift.id,
    giftName: gift.name,
    quantity: String(quantity),
    team,
    targetTeam,
    grossCents: String(grossCents),
    creatorCents: String(split.creatorCents),
    networkDesignerCents: String(split.networkDesignerCents),
  }

  const intentInput = {
    amount: grossCents,
    currency: 'usd',
    metadata,
    description: `Orion Battle Gift: ${gift.name} × ${quantity}`,
    automatic_payment_methods: { enabled: true },
  }

  if (useDestinationCharges && creator?.stripe_account_id) {
    intentInput.application_fee_amount = split.networkDesignerCents
    intentInput.transfer_data = { destination: creator.stripe_account_id }
  }

  let intent
  try {
    intent = await stripe.paymentIntents.create(intentInput)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Stripe payment intent failed.'
    console.error('[orion-payments] payment-intent failed', error)
    return jsonError(response, 500, 'STRIPE_ERROR', message)
  }

  response.json({
    clientSecret: intent.client_secret,
    amount: grossCents,
    currency: 'usd',
    giftName: gift.name,
    giftSymbol: gift.symbol,
    quantity,
    split: {
      grossCents,
      creatorCents: split.creatorCents,
      networkDesignerCents: split.networkDesignerCents,
    },
  })
})

app.listen(port, () => {
  console.log(`[orion-payments] listening on http://127.0.0.1:${port}`)
})
