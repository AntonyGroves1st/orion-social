let ctx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!ctx || ctx.state === 'closed') ctx = new AudioContext()
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

function noise(ac: AudioContext, duration: number, gain: number): AudioBufferSourceNode {
  const len = Math.floor(ac.sampleRate * duration)
  const buf = ac.createBuffer(1, len, ac.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * gain
  const src = ac.createBufferSource()
  src.buffer = buf
  return src
}

function tone(ac: AudioContext, freq: number, duration: number, type: OscillatorType = 'sine'): OscillatorNode {
  const osc = ac.createOscillator()
  osc.type = type
  osc.frequency.value = freq
  const now = ac.currentTime
  osc.start(now)
  osc.stop(now + duration)
  return osc
}

function gain(ac: AudioContext, vol: number): GainNode {
  const g = ac.createGain()
  g.gain.value = vol
  return g
}

function envelope(ac: AudioContext, attack: number, decay: number, peak = 0.5): GainNode {
  const g = ac.createGain()
  const now = ac.currentTime
  g.gain.setValueAtTime(0, now)
  g.gain.linearRampToValueAtTime(peak, now + attack)
  g.gain.exponentialRampToValueAtTime(0.001, now + attack + decay)
  return g
}

export function sfxHit() {
  const ac = getCtx()
  const env = envelope(ac, 0.01, 0.15, 0.4)
  env.connect(ac.destination)
  const n = noise(ac, 0.16, 0.6)
  n.connect(env)
  n.start()
  const osc = tone(ac, 180, 0.12, 'sawtooth')
  const g = gain(ac, 0.25)
  osc.connect(g).connect(env)
}

export function sfxSlap() {
  const ac = getCtx()
  const env = envelope(ac, 0.005, 0.1, 0.5)
  env.connect(ac.destination)
  const n = noise(ac, 0.08, 0.8)
  n.connect(env)
  n.start()
  const osc = tone(ac, 400, 0.06, 'square')
  const g = gain(ac, 0.2)
  osc.connect(g).connect(env)
}

export function sfxKick() {
  const ac = getCtx()
  const env = envelope(ac, 0.005, 0.25, 0.5)
  env.connect(ac.destination)
  const osc = ac.createOscillator()
  osc.type = 'sine'
  const now = ac.currentTime
  osc.frequency.setValueAtTime(160, now)
  osc.frequency.exponentialRampToValueAtTime(30, now + 0.2)
  osc.connect(env)
  osc.start(now)
  osc.stop(now + 0.25)
}

export function sfxBreak() {
  const ac = getCtx()
  const env = envelope(ac, 0.01, 0.4, 0.45)
  env.connect(ac.destination)
  const n = noise(ac, 0.4, 0.7)
  n.connect(env)
  n.start()
  const osc = tone(ac, 90, 0.35, 'sawtooth')
  const g = gain(ac, 0.3)
  osc.connect(g).connect(env)
  const crack = tone(ac, 600, 0.06, 'square')
  const cg = gain(ac, 0.3)
  crack.connect(cg).connect(env)
}

export function sfxExplosion() {
  const ac = getCtx()
  const env = envelope(ac, 0.01, 0.55, 0.5)
  env.connect(ac.destination)
  const n = noise(ac, 0.55, 0.9)
  n.connect(env)
  n.start()
  const osc = ac.createOscillator()
  osc.type = 'sawtooth'
  const now = ac.currentTime
  osc.frequency.setValueAtTime(200, now)
  osc.frequency.exponentialRampToValueAtTime(20, now + 0.5)
  osc.connect(gain(ac, 0.3)).connect(env)
  osc.start(now)
  osc.stop(now + 0.55)
}

export function sfxSurge() {
  const ac = getCtx()
  const env = envelope(ac, 0.05, 0.6, 0.35)
  env.connect(ac.destination)
  const osc = ac.createOscillator()
  osc.type = 'sawtooth'
  const now = ac.currentTime
  osc.frequency.setValueAtTime(120, now)
  osc.frequency.linearRampToValueAtTime(800, now + 0.3)
  osc.frequency.linearRampToValueAtTime(400, now + 0.6)
  osc.connect(gain(ac, 0.25)).connect(env)
  osc.start(now)
  osc.stop(now + 0.65)
}

export function sfxEliminate() {
  const ac = getCtx()
  const env = envelope(ac, 0.01, 0.7, 0.4)
  env.connect(ac.destination)
  const n = noise(ac, 0.5, 0.5)
  n.connect(env)
  n.start()
  const osc = ac.createOscillator()
  osc.type = 'square'
  const now = ac.currentTime
  osc.frequency.setValueAtTime(500, now)
  osc.frequency.exponentialRampToValueAtTime(60, now + 0.6)
  osc.connect(gain(ac, 0.2)).connect(env)
  osc.start(now)
  osc.stop(now + 0.7)
}

export function sfxWinner() {
  const ac = getCtx()
  const now = ac.currentTime
  const notes = [523, 659, 784, 1047]
  for (let i = 0; i < notes.length; i++) {
    const env = envelope(ac, 0.02, 0.3, 0.3)
    env.connect(ac.destination)
    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = notes[i]!
    osc.connect(env)
    osc.start(now + i * 0.12)
    osc.stop(now + i * 0.12 + 0.32)
  }
}

export function sfxGodmode() {
  const ac = getCtx()
  const now = ac.currentTime
  const env = envelope(ac, 0.05, 0.8, 0.35)
  env.connect(ac.destination)
  const osc = ac.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(300, now)
  osc.frequency.linearRampToValueAtTime(1200, now + 0.4)
  osc.frequency.linearRampToValueAtTime(600, now + 0.8)
  osc.connect(gain(ac, 0.2)).connect(env)
  osc.start(now)
  osc.stop(now + 0.85)
  const n = noise(ac, 0.3, 0.2)
  const ng = envelope(ac, 0.3, 0.3, 0.15)
  ng.connect(ac.destination)
  n.connect(ng)
  n.start(now + 0.4)
}

export function sfxSnowball() {
  const ac = getCtx()
  const env = envelope(ac, 0.01, 0.18, 0.35)
  env.connect(ac.destination)
  const osc = tone(ac, 1200, 0.15, 'sine')
  const g = gain(ac, 0.2)
  osc.connect(g).connect(env)
  const n = noise(ac, 0.12, 0.3)
  n.connect(env)
  n.start()
}

export function sfxFireball() {
  const ac = getCtx()
  const env = envelope(ac, 0.02, 0.35, 0.4)
  env.connect(ac.destination)
  const n = noise(ac, 0.35, 0.6)
  n.connect(env)
  n.start()
  const osc = ac.createOscillator()
  osc.type = 'sawtooth'
  const now = ac.currentTime
  osc.frequency.setValueAtTime(400, now)
  osc.frequency.exponentialRampToValueAtTime(100, now + 0.3)
  osc.connect(gain(ac, 0.25)).connect(env)
  osc.start(now)
  osc.stop(now + 0.35)
}

export function sfxCoinDrop() {
  const ac = getCtx()
  const now = ac.currentTime
  for (let i = 0; i < 3; i++) {
    const env = envelope(ac, 0.005, 0.12, 0.25)
    env.connect(ac.destination)
    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = 2400 + i * 400
    osc.connect(env)
    osc.start(now + i * 0.06)
    osc.stop(now + i * 0.06 + 0.12)
  }
}

const SFX_BY_EFFECT: Record<string, () => void> = {
  'snowball': sfxSnowball,
  'fireball': sfxFireball,
  'bomb': sfxExplosion,
  'lightning': sfxSurge,
  'thunder': sfxSurge,
  'skull': sfxBreak,
  'glitch': sfxBreak,
  'solar': sfxFireball,
  'meteor': sfxExplosion,
  'vortex': sfxSurge,
  'neon': sfxHit,
  'frost': sfxSnowball,
  'default': sfxHit,
}

export function sfxForGift(effectClass: string) {
  const fn = SFX_BY_EFFECT[effectClass] ?? SFX_BY_EFFECT['default']!
  fn()
}
