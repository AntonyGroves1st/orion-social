import { supabase } from './supabase'

export type PublishLiveReelInput = {
  userId: string
  blob: Blob
  roomTitle?: string | null
  durationSeconds?: number | null
  visibility?: 'public' | 'friends' | 'private'
}

export type PublishLiveReelResult = {
  videoUrl: string
  path: string
}

/**
 * Upload a live-room MediaRecorder clip to `orion-reels` and publish an Orion Reel (#live).
 */
export async function publishLiveClipAsReel(input: PublishLiveReelInput): Promise<PublishLiveReelResult> {
  if (!supabase) throw new Error('Supabase not configured')
  const { userId, blob, roomTitle, durationSeconds, visibility = 'public' } = input
  if (!blob.size) throw new Error('Clip is empty — record again')

  const type = blob.type || 'video/webm'
  const ext = type.includes('mp4') ? 'mp4' : 'webm'
  const path = `${userId}/live-${Date.now()}.${ext}`

  const { data, error: upErr } = await supabase.storage.from('orion-reels').upload(path, blob, {
    upsert: false,
    contentType: type,
  })
  if (upErr) {
    throw new Error(
      upErr.message.includes('Bucket') || upErr.message.includes('not found')
        ? `Upload failed: ${upErr.message}\n\nRun npm run db:storage to create the orion-reels bucket.`
        : `Upload failed: ${upErr.message}`,
    )
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from('orion-reels').getPublicUrl(data.path)

  const room = roomTitle?.trim()
  const caption = room ? `Live clip · ${room} #live` : 'Live clip #live'

  const { error: insErr } = await supabase.from('orion_reels').insert({
    creator_id: userId,
    video_url: publicUrl,
    hls_url: null,
    thumbnail_url: null,
    caption,
    visibility,
    moderation_status: 'published',
    duration_seconds: durationSeconds && durationSeconds > 0 ? Math.round(durationSeconds) : null,
  })
  if (insErr) throw new Error(insErr.message)

  return { videoUrl: publicUrl, path: data.path }
}
