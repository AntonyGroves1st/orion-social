/** Resolve profile avatar URL (supports ImgTree short links). */
export function avatarImageSrc(value?: string | null): string {
  const url = (value ?? '').trim()
  if (!url) return ''
  const imgtree = url.match(/^https?:\/\/(?:www\.)?imgtree\.co\/i\/([A-Za-z0-9_-]+)\/?$/i)
  if (imgtree?.[1]) return `https://cdn.imgtree.co/images/${imgtree[1]}.png`
  return url
}

export function avatarInitial(name?: string | null): string {
  const t = (name ?? '').trim()
  return (t[0] || '?').toUpperCase()
}

/** Center-crop upload to a square JPEG so profile avatars never hang outside the orb. */
export async function cropAvatarFileToSquare(file: File, outputSize = 512): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const sx = Math.floor((bitmap.width - side) / 2)
  const sy = Math.floor((bitmap.height - side) / 2)
  const canvas = document.createElement('canvas')
  canvas.width = outputSize
  canvas.height = outputSize
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new Error('Could not prepare avatar canvas')
  }
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, outputSize, outputSize)
  bitmap.close()
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Avatar crop failed'))),
      'image/jpeg',
      0.9,
    )
  })
}
