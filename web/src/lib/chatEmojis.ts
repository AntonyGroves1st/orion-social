import type { ChatEmoji, MessageEmojiReaction } from './supabase'

export const DEFAULT_CHAT_EMOJIS: ChatEmoji[] = [
  ['fire', '🔥', 'Fire', 'hype'],
  ['heart', '❤️', 'Heart', 'love'],
  ['green-heart', '💚', 'Green Heart', 'love'],
  ['laugh', '😂', 'Laugh', 'reaction'],
  ['clap', '👏', 'Clap', 'hype'],
  ['rocket', '🚀', 'Rocket', 'hype'],
  ['eyes', '👀', 'Eyes', 'reaction'],
  ['crown', '👑', 'Crown', 'battle'],
  ['sparkles', '✨', 'Sparkles', 'hype'],
  ['hundred', '💯', 'Hundred', 'hype'],
  ['trophy', '🏆', 'Trophy', 'battle'],
  ['zap', '⚡', 'Lightning', 'battle'],
  ['snow', '❄️', 'Snow', 'battle'],
  ['dragon', '🐉', 'Dragon', 'battle'],
  ['gem', '💎', 'Gem', 'gift'],
  ['target', '🎯', 'Target', 'battle'],
  ['party', '🥳', 'Party', 'hype'],
  ['thinking', '🤔', 'Thinking', 'reaction'],
].map(([key, unicode, label, category], index) => ({
  key,
  unicode,
  label,
  category,
  sort_order: (index + 1) * 10,
  active: true,
}))

export function sortedEmojiCatalog(rows: ChatEmoji[]) {
  return rows
    .filter((emoji) => emoji.active !== false)
    .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label))
}

export function reactionSummary(
  messageId: string,
  reactions: MessageEmojiReaction[],
  catalog: ChatEmoji[],
  myId?: string,
) {
  const emojiByKey = new Map(catalog.map((emoji) => [emoji.key, emoji]))
  const counts = new Map<string, { emoji: ChatEmoji; count: number; mine: boolean }>()
  for (const reaction of reactions) {
    if (reaction.message_id !== messageId) continue
    const emoji = emojiByKey.get(reaction.emoji_key)
    if (!emoji) continue
    const current = counts.get(reaction.emoji_key) ?? { emoji, count: 0, mine: false }
    current.count += 1
    if (reaction.user_id === myId) current.mine = true
    counts.set(reaction.emoji_key, current)
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.emoji.sort_order - b.emoji.sort_order)
}
