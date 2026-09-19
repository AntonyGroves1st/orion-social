/** Base URL for shareable invite links (APK / web / other devices). */
export function publicAppOrigin(): string {
  const configured = import.meta.env.VITE_PUBLIC_APP_URL?.trim().replace(/\/+$/, '')
  if (configured) return configured

  if (typeof window !== 'undefined') {
    const { protocol, hostname, port } = window.location
    const isLocal =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.localhost') ||
      protocol === 'capacitor:' ||
      protocol === 'file:'
    if (!isLocal) {
      return `${protocol}//${hostname}${port ? `:${port}` : ''}`
    }
  }

  return ''
}

export function liveRoomInviteUrl(conversationId: string): string {
  const base = publicAppOrigin()
  if (!base) return ''
  return `${base}/call/${conversationId}`
}

export function inviteLinkIsLocalOnly(url: string): boolean {
  return /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url) || url === ''
}
