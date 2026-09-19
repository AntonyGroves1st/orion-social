import { useAudioLevel, streamHasLiveAudio } from '../lib/useAudioLevel'

type Props = {
  stream: MediaStream | null
  /** Mic not muted / audio expected */
  active?: boolean
  compact?: boolean
}

export default function CamVolumeMeter({ stream, active = true, compact = false }: Props) {
  const audioLive = streamHasLiveAudio(stream, active)
  const { level, talking } = useAudioLevel(stream, audioLive)

  const segments = 5
  const filled = audioLive ? Math.ceil((level / 100) * segments) : 0

  return (
    <div
      className={`cam-volume-meter${talking ? ' cam-volume-meter--talking' : ''}${compact ? ' cam-volume-meter--compact' : ''}${!audioLive ? ' cam-volume-meter--muted' : ''}`}
      aria-label={
        !audioLive ? 'Microphone muted' : talking ? `Speaking · ${level}% volume` : `Quiet · ${level}% volume`
      }
    >
      <div className="cam-volume-meter-segments" aria-hidden>
        {Array.from({ length: segments }, (_, i) => (
          <span
            key={i}
            className={`cam-volume-meter-seg${i < filled ? ' cam-volume-meter-seg--on' : ''}${talking && i < filled ? ' cam-volume-meter-seg--hot' : ''}`}
            style={i < filled && filled > 0 ? { opacity: 0.45 + (level / 100) * 0.55 } : undefined}
          />
        ))}
      </div>
      {!compact && (
        <span className="cam-volume-meter-label font-mono">
          {!audioLive ? 'MUTED' : talking ? `LIVE ${level}%` : `${level}%`}
        </span>
      )}
    </div>
  )
}
