import React, { useState } from 'react'
import { avatarImageSrc, avatarInitial } from '../lib/profileAvatar'

type Props = {
  src?: string | null
  name?: string | null
  size?: 'xs' | 'sm' | 'md'
  className?: string
  title?: string
}

/**
 * Circular profile avatar — image when available, otherwise initial letter.
 */
export default function ProfileAvatar({ src, name, size = 'sm', className = '', title }: Props) {
  const [failed, setFailed] = useState(false)
  const resolved = avatarImageSrc(src)
  const showImg = Boolean(resolved) && !failed
  const label = title ?? name ?? 'Member'

  return (
    <span
      className={`profile-avatar profile-avatar--${size}${showImg ? '' : ' profile-avatar--fallback'}${className ? ` ${className}` : ''}`}
      title={label}
      aria-hidden={!title}
      role={title ? 'img' : undefined}
      aria-label={title ? label : undefined}
    >
      {showImg ? (
        <img src={resolved} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      ) : (
        <span className="profile-avatar-initial">{avatarInitial(name)}</span>
      )}
    </span>
  )
}
