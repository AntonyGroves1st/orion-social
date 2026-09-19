/** Live room member roles — host controls stage; mods assist when enabled. */
export type LiveRoomRole = 'host' | 'moderator' | 'member'

export type LiveStageSlotUserId = string | null

export function canManageLiveStage(
  myRole: LiveRoomRole,
  modsEnabled: boolean,
): boolean {
  return myRole === 'host' || (myRole === 'moderator' && modsEnabled)
}

/** Host (room admin) alone controls layout and stage assignment. */
export function canAdminLiveStage(myRole: LiveRoomRole): boolean {
  return myRole === 'host'
}

export function roleFromDb(value: unknown, creatorId: string | null, userId: string): LiveRoomRole {
  if (value === 'host' || value === 'moderator' || value === 'member') return value
  if (creatorId && creatorId === userId) return 'host'
  return 'member'
}

export function parseLiveStageSlots(raw: unknown): LiveStageSlotUserId[] {
  if (!Array.isArray(raw)) return []
  return raw.map((item) => (typeof item === 'string' && item.length > 0 ? item : null))
}

/** Map host-synced user ids to local stage feeds (`__local` for self). */
export function stageFeedsFromUserIds(slots: LiveStageSlotUserId[], meId: string): Array<'__local' | string | null> {
  return slots.map((id) => {
    if (!id) return null
    return id === meId ? '__local' : id
  })
}

/** Map local stage feeds to user ids for DB / broadcast. */
export function stageFeedsToUserIds(
  slots: Array<'__local' | string | null>,
  meId: string,
): LiveStageSlotUserId[] {
  return slots.map((feed) => {
    if (feed === null) return null
    if (feed === '__local') return meId
    return feed
  })
}

export function roleBadge(role: LiveRoomRole): string {
  if (role === 'host') return 'HOST'
  if (role === 'moderator') return 'MOD'
  return ''
}

/** Stable key so redundant DB/sync applies do not re-render the stage. */
export function stageLayoutFingerprint(camCount: number, slots: LiveStageSlotUserId[]): string {
  const count = camCount <= 2 ? 2 : camCount <= 4 ? 4 : camCount <= 6 ? 6 : 7
  const normalized = slots.slice(0, count).map((s) => s ?? '-')
  while (normalized.length < count) normalized.push('-')
  return `${count}:${normalized.join(',')}`
}

/** True when the room already has a saved layout with at least one person on stage. */
export function hasPersistedStageLayout(_camCount: unknown, slots: LiveStageSlotUserId[]): boolean {
  return slots.some((slot) => slot !== null && slot.length > 0)
}

/** Resolve the current host user id for default guest stage slot 0. */
export function findLiveHostUserId(
  roles: Record<string, LiveRoomRole>,
  creatorId: string | null,
  memberIds: Iterable<string>,
  excludeUserId?: string,
): string | null {
  const members = new Set(memberIds)
  for (const [uid, role] of Object.entries(roles)) {
    if (role === 'host' && members.has(uid) && uid !== excludeUserId) return uid
  }
  if (creatorId && members.has(creatorId) && creatorId !== excludeUserId) return creatorId
  return null
}
