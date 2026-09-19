export type ChatReplyTarget = {
  id: string
  name: string
}

/** @mention prefix inserted when replying to someone in chat. */
export function replyMentionPrefix(name: string): string {
  const safe = name.trim().replace(/\s+/g, ' ')
  return `@${safe} `
}

export function applyReplyToBody(name: string, prev: string): string {
  const prefix = replyMentionPrefix(name)
  const stripped = prev.replace(/^@[^\n]+?\s/, '')
  return prefix + stripped
}

export function clearReplyFromBody(prev: string): string {
  return prev.replace(/^@[^\n]+?\s/, '')
}
