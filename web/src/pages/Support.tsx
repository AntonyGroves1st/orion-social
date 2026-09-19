import React, { useMemo, useState } from 'react'
import type { Profile } from '../lib/supabase'

type SupportGuide = {
  id: string
  title: string
  department: string
  summary: string
  steps: string[]
}

type SupportQa = {
  question: string
  answer: string
  tags: string[]
}

type SupportMessage = {
  id: string
  sender: 'bot' | 'user'
  body: string
}

const SUPPORT_GUIDES: SupportGuide[] = [
  {
    id: 'stripe-gifts',
    title: 'Stripe gifts and battle purchases',
    department: 'Billing',
    summary: 'Fix gift checkout, payment redirects, and creator split questions.',
    steps: [
      'Make sure you are signed in before pressing Stripe.',
      'Open gifts inside a listed live room, then choose the gift and press Stripe.',
      'If checkout does not open, restart Orion Payments and confirm http://127.0.0.1:8791/health is healthy.',
      'Creator payout is 85 percent and network designers receive 15 percent after the battle gift purchase is recorded.',
    ],
  },
  {
    id: 'live-room-camera',
    title: 'Live room camera and chat',
    department: 'Live Rooms',
    summary: 'Camera permissions, floating chat, and host battle target help.',
    steps: [
      'Allow camera and microphone in the browser site settings.',
      'Use Flip for rear camera on mobile and Cam to hide or restore video.',
      'Floating chat stays over the host camera; new messages fade upward like a live-room stream.',
      'Use Battle to jump to gifts and Fire after the host battle is live.',
    ],
  },
  {
    id: 'reels-posting',
    title: 'Orion Reels posting',
    department: 'Reels',
    summary: 'Post video links, filter categories, and open clips fullscreen.',
    steps: [
      'Paste a TikTok video page link or a direct mp4, webm, mov, m4v, or m3u8 link.',
      'Pick a category so members can discover it from the Reels topic dock.',
      'Use the fullscreen icon on each reel to expand the clip.',
      'If Reels are missing, run the Reels database migration from the Supabase SQL editor.',
    ],
  },
  {
    id: 'profile-friends',
    title: 'Profile, friends, and account',
    department: 'Members',
    summary: 'Profile images, usernames, bios, friends, and sign-in help.',
    steps: [
      'Open Profile to change username, avatar image URL, and bio.',
      'Use Friends to send requests and manage your trusted member list.',
      'If profile fields fail to save, run the profile fields migration in Supabase.',
      'Use Sign out in the footer dock when testing multiple member accounts.',
    ],
  },
]

const SUPPORT_QA: SupportQa[] = [
  {
    question: 'Why is Stripe not opening?',
    answer:
      'You must be signed in, the room must be a listed live room, and Orion Payments must be running on port 8791. The app now falls back to the local /payments proxy if a direct payments URL fails.',
    tags: ['stripe', 'billing', 'gifts'],
  },
  {
    question: 'Why does chat cover the camera?',
    answer:
      'Live chat is designed to float over the host camera. If the camera is still hidden, refresh the live room so the latest transparent overlay styles load.',
    tags: ['chat', 'camera', 'live'],
  },
  {
    question: 'Where are Reels categories?',
    answer:
      'Open Reels and use the category dock above the feed. Categories include For You, Battles, Live Rooms, Music, Gaming, Funny, Love Room, and Tech.',
    tags: ['reels', 'categories', 'video'],
  },
  {
    question: 'How do I get human support?',
    answer:
      'Use the ticket form on this page. It creates a support ticket ID and stores the request locally until the live support database is connected.',
    tags: ['ticket', 'human', 'support'],
  },
  {
    question: 'How do members run Orion locally?',
    answer:
      'Desktop members run Start-Orion-Social.bat. Mobile-only members use the deployed build and Supabase setup from the mobile package.',
    tags: ['setup', 'members', 'desktop', 'mobile'],
  },
]

function supportReply(input: string) {
  const text = input.toLowerCase()
  const match = SUPPORT_QA.find((item) => item.tags.some((tag) => text.includes(tag)) || item.question.toLowerCase().includes(text))
  if (match) return match.answer
  if (/human|agent|ticket|person|help/i.test(input)) {
    return 'I can help triage this now. Use the ticket form below and the human support queue will get the full issue, priority, and account context.'
  }
  return 'I can help with Stripe, live rooms, chat, Reels, friends, profiles, and setup. Try a keyword, or open a ticket for human support.'
}

export default function Support({ me }: { me: Profile }) {
  const [query, setQuery] = useState('')
  const [botDraft, setBotDraft] = useState('')
  const [ticketSubject, setTicketSubject] = useState('')
  const [ticketBody, setTicketBody] = useState('')
  const [ticketPriority, setTicketPriority] = useState('normal')
  const [ticketId, setTicketId] = useState<string | null>(null)
  const [messages, setMessages] = useState<SupportMessage[]>([
    {
      id: 'bot:intro',
      sender: 'bot',
      body: 'Support is live. Ask about Stripe, chat, cameras, Reels, friends, setup, or open a human ticket.',
    },
  ])

  const filteredGuides = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return SUPPORT_GUIDES
    return SUPPORT_GUIDES.filter((guide) =>
      `${guide.title} ${guide.department} ${guide.summary} ${guide.steps.join(' ')}`.toLowerCase().includes(q),
    )
  }, [query])

  const filteredQa = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return SUPPORT_QA
    return SUPPORT_QA.filter((item) => `${item.question} ${item.answer} ${item.tags.join(' ')}`.toLowerCase().includes(q))
  }, [query])

  function sendBotMessage(event: React.FormEvent) {
    event.preventDefault()
    const body = botDraft.trim()
    if (!body) return
    const now = Date.now()
    setMessages((current) => [
      ...current,
      { id: `user:${now}`, sender: 'user', body },
      { id: `bot:${now}`, sender: 'bot', body: supportReply(body) },
    ])
    setBotDraft('')
  }

  function submitTicket(event: React.FormEvent) {
    event.preventDefault()
    const subject = ticketSubject.trim()
    const body = ticketBody.trim()
    if (!subject || !body) return
    const id = `ORION-${Date.now().toString(36).toUpperCase()}`
    const ticket = {
      id,
      memberId: me.id,
      memberName: me.display_name,
      priority: ticketPriority,
      subject,
      body,
      createdAt: new Date().toISOString(),
      status: 'queued_for_human_support',
    }
    try {
      localStorage.setItem(`orion_support_ticket_${id}`, JSON.stringify(ticket))
    } catch {
      /* Local storage is best-effort until support tickets are persisted server-side. */
    }
    setTicketId(id)
    setTicketSubject('')
    setTicketBody('')
  }

  return (
    <div className="support-page studio-page">
      <header className="page-head support-head">
        <div>
          <div className="section-kicker font-mono">HELP AND SUPPORT DEPARTMENT</div>
          <h2>Support Center</h2>
          <p className="page-intro">
            Guides, Q&A, live bot triage, and a human-support ticket path for Orion Social members.
          </p>
        </div>
        <div className="support-status font-mono">
          <span>Bot online</span>
          <strong>Human queue ready</strong>
        </div>
      </header>

      <section className="support-search card elevate" aria-label="Search help">
        <label>
          <span className="reels-label font-mono">Search guides and Q&A</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Stripe, chat, camera, Reels, friends..."
          />
        </label>
      </section>

      <section className="support-grid">
        <div className="support-column">
          <div className="section-kicker font-mono">GUIDES DATABASE</div>
          {filteredGuides.map((guide) => (
            <article key={guide.id} className="support-guide card">
              <div className="support-guide-head">
                <span className="font-mono">{guide.department}</span>
                <h3>{guide.title}</h3>
                <p>{guide.summary}</p>
              </div>
              <ol>
                {guide.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </article>
          ))}
        </div>

        <div className="support-column">
          <div className="section-kicker font-mono">Q&A DATABASE</div>
          <div className="support-qa-list">
            {filteredQa.map((item) => (
              <details key={item.question} className="support-qa">
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="support-live-grid">
        <div className="support-bot card elevate">
          <div className="support-panel-head">
            <div>
              <div className="section-kicker font-mono">LIVE BOT WINDOW</div>
              <h3>Orion Support Bot</h3>
            </div>
            <span className="support-pill font-mono">online</span>
          </div>
          <div className="support-chat-log font-mono" aria-live="polite">
            {messages.slice(-8).map((message) => (
              <div key={message.id} className={`support-message support-message--${message.sender}`}>
                <strong>{message.sender === 'bot' ? 'Support Bot' : 'You'}</strong>
                <span>{message.body}</span>
              </div>
            ))}
          </div>
          <form className="support-bot-compose" onSubmit={sendBotMessage}>
            <input
              type="text"
              value={botDraft}
              onChange={(event) => setBotDraft(event.target.value)}
              placeholder="Ask for help..."
              maxLength={500}
            />
            <button className="primary" type="submit">
              Ask
            </button>
          </form>
        </div>

        <form className="support-ticket card elevate" onSubmit={submitTicket}>
          <div>
            <div className="section-kicker font-mono">HUMAN SUPPORT TICKET</div>
            <h3>Open a ticket</h3>
            <p className="page-intro">Send the issue to human support when the bot cannot solve it.</p>
          </div>
          {ticketId && (
            <div className="support-ticket-created font-mono" role="status">
              Ticket created: <strong>{ticketId}</strong>
            </div>
          )}
          <label>
            <span className="reels-label font-mono">Priority</span>
            <select value={ticketPriority} onChange={(event) => setTicketPriority(event.target.value)}>
              <option value="normal">Normal</option>
              <option value="urgent">Urgent</option>
              <option value="billing">Billing</option>
              <option value="safety">Safety</option>
            </select>
          </label>
          <label>
            <span className="reels-label font-mono">Subject</span>
            <input
              type="text"
              value={ticketSubject}
              onChange={(event) => setTicketSubject(event.target.value)}
              placeholder="What needs help?"
              maxLength={160}
              required
            />
          </label>
          <label>
            <span className="reels-label font-mono">Details</span>
            <textarea
              rows={5}
              value={ticketBody}
              onChange={(event) => setTicketBody(event.target.value)}
              placeholder="Tell support what happened, what you clicked, and what you expected."
              maxLength={1500}
              required
            />
          </label>
          <button className="primary" type="submit">
            Send to human support
          </button>
        </form>
      </section>
    </div>
  )
}
